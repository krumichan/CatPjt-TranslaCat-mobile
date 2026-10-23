export interface IdentitySource {
  status: "restoring" | "signedOut" | "signedIn";
  user: { publicId?: unknown } | null;
  error?: string | null;
}

export function accountIdentity(source: IdentitySource) {
  if (source.status === "restoring") return { status: "loading", publicId: null, message: "로그인한 계정의 ID를 확인하고 있어요." } as const;
  if (source.status !== "signedIn") return {
    status: "signedOut", publicId: null,
    message: source.error === "SESSION_EXPIRED" ? "다시 로그인하면 나의 ID를 확인할 수 있어요." : "로그인하면 나의 ID를 확인하고 친구에게 알려줄 수 있어요.",
  } as const;

  // publicId는 서버의 공개 검색값이다. 숫자 userId로 대체하거나 현재 생성 형식만 강제하지 않는다.
  const value = source.user?.publicId;
  if (typeof value !== "string" || !value.trim() || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    return { status: "unavailable", publicId: null, message: "나의 ID를 확인하지 못했어요. 계정 정보를 다시 확인해 주세요." } as const;
  }
  return { status: "ready", publicId: value, message: "친구가 이 ID로 나를 검색할 수 있어요. ID를 길게 눌러 직접 복사할 수도 있어요." } as const;
}

interface IdentityActionState {
  pending: "copy" | "share" | null;
  message: string | null;
  error: boolean;
}

export function createIdentityActions({ publicId, sessionKey, isCurrent, copy, share }: {
  publicId: string | null;
  sessionKey: string | null;
  isCurrent: (key: string | null) => boolean;
  copy: (value: string) => Promise<boolean>;
  share: (value: string) => Promise<"shared" | "dismissed">;
}) {
  let state: IdentityActionState = { pending: null, message: null, error: false };
  let attached = false;
  let generation = 0;
  let identity = { publicId, sessionKey };
  let inFlight: object | null = null;
  const listeners = new Set<() => void>();
  const publish = (next: IdentityActionState) => { state = next; listeners.forEach(listener => listener()); };
  const cancel = () => {
    generation++;
    publish({ pending: inFlight ? state.pending : null, message: null, error: false });
  };
  const run = async (action: "copy" | "share") => {
    // 사용자 동작 시점의 현재 계정·화면만 내보낸다. 겹친 탭은 OS 작업을 중복 실행하지 않는다.
    if (!attached || !isCurrent(identity.sessionKey) || !identity.publicId || inFlight) return;
    const owner = identity;
    const value = identity.publicId;
    const ownGeneration = ++generation;
    const flight = {};
    inFlight = flight;
    const owned = () => attached && generation === ownGeneration && identity === owner && isCurrent(owner.sessionKey);
    let feedback: Pick<IdentityActionState, "message" | "error"> = { message: null, error: false };
    publish({ pending: action, message: null, error: false });
    try {
      const result = action === "copy" ? await copy(value) : await share(value);
      if (result === false) {
        feedback = { message: "복사하지 못했어요. ID를 길게 눌러 복사해 주세요.", error: true };
      } else {
        feedback = { message: action === "copy" ? "TranslaCat ID를 복사했어요." : result === "shared" ? "ID 공유 창을 열었어요." : null, error: false };
      }
    } catch {
      // OS 오류 원문이나 계정 데이터를 안내·로그에 반사하지 않는다.
      feedback = { message: action === "copy" ? "복사하지 못했어요. ID를 길게 눌러 복사해 주세요." : "공유 창을 열지 못했어요. 다시 시도해 주세요.", error: true };
    } finally {
      // blur·계정 변경은 안내만 무효화한다. OS 작업 잠금은 실제 Promise 종료 때만 해제한다.
      if (inFlight === flight) {
        inFlight = null;
        publish({ pending: null, ...(owned() ? feedback : { message: null, error: false }) });
      }
    }
  };
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    // effect setup-cleanup-setup에서도 다시 연결할 수 있고 오래된 완료는 세대로 무효화한다.
    attach() { attached = true; },
    detach() { attached = false; cancel(); },
    updateIdentity(nextPublicId: string | null, nextSessionKey: string | null) {
      if (identity.publicId === nextPublicId && identity.sessionKey === nextSessionKey) return;
      identity = { publicId: nextPublicId, sessionKey: nextSessionKey };
      cancel();
    },
    cancel,
    copy: () => run("copy"),
    share: () => run("share"),
  };
}
