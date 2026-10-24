import { ChatContractError } from "../../domain/chat/contracts.ts";
import type { OpenProfile } from "../../domain/chat/types.ts";
import { ProfileImageInputError, selectedProfileImage, type SelectedProfileImage } from "./image-selection.ts";
import type { OpenProfileService } from "./service.ts";

export interface OpenProfileState {
  profile: OpenProfile | null;
  draft: SelectedProfileImage | null;
  pending: "load" | "pick" | "upload" | "remove" | null;
  ready: boolean;
  uncertain: { reviewed: boolean } | null;
  error: string | null;
  notice: string | null;
}

export const emptyOpenProfileState = (): OpenProfileState => ({
  profile: null, draft: null, pending: null, ready: false, uncertain: null, error: null, notice: null,
});

function errorMessage(error: unknown) {
  if (error instanceof ProfileImageInputError) return error.message;
  const status = error && typeof error === "object" && "status" in error ? error.status : null;
  if (status === 413) return "사진 용량이 커요. 5MB 이하의 사진을 선택해 주세요.";
  if (status === 400 || status === 415) return "이 사진을 사용할 수 없어요. JPG, PNG, WEBP 사진을 선택해 주세요.";
  if (status === 401) return "로그인 상태를 확인해 주세요.";
  if (status === 403 || status === 404 || error instanceof ChatContractError) return "이 방의 프로필을 변경할 수 없어요. 참여 상태를 다시 확인해 주세요.";
  return "사진을 처리하지 못했어요. 연결 상태를 확인한 뒤 다시 시도해 주세요.";
}

export function createOpenProfileController({ roomId, service, pickImage, isCurrent, isActive, onChange, onSaved,
  schedule = (work, delay) => { const timer = setTimeout(work, delay); return () => clearTimeout(timer); },
}: {
  roomId: string;
  service: OpenProfileService;
  pickImage: () => Promise<SelectedProfileImage | null>;
  isCurrent: () => boolean;
  isActive: () => boolean;
  onChange: (state: OpenProfileState) => void;
  onSaved?: () => void;
  schedule?: (work: () => void, delay: number) => () => void;
}) {
  let state = emptyOpenProfileState();
  let disposed = false;
  let sequence = 0;
  let request: AbortController | null = null;
  let stopTimer: (() => void) | null = null;
  let writeStarted = false;
  const current = () => !disposed && isCurrent();
  const usable = () => current() && isActive();
  const emit = (patch: Partial<OpenProfileState>) => {
    if (!current()) return;
    state = { ...state, ...patch };
    onChange(state);
  };
  const end = () => { stopTimer?.(); stopTimer = null; request = null; writeStarted = false; };
  const cancelRequest = () => {
    sequence++;
    request?.abort();
    const uncertain = writeStarted;
    end();
    return uncertain;
  };
  const begin = (pending: "load" | "upload" | "remove") => {
    const id = ++sequence;
    const abort = new AbortController();
    request = abort;
    writeStarted = false;
    emit({ pending, error: null, notice: null });
    stopTimer = schedule(() => {
      if (!current() || id !== sequence) return;
      const uncertain = cancelRequest();
      emit({ pending: null, ready: false, ...(uncertain ? { uncertain: { reviewed: false } } : {}),
        error: uncertain ? "사진 변경 결과를 확인하지 못했어요. 같은 요청을 다시 보내기 전에 현재 사진을 확인해 주세요." : "응답이 늦어요. 연결 상태를 확인하고 다시 불러와 주세요." });
    }, 20000);
    return { id, signal: abort.signal };
  };

  const load = async () => {
    if (!usable() || state.pending) return;
    const operation = begin("load");
    try {
      const profile = await service.read(roomId, operation.signal);
      if (!usable() || operation.id !== sequence) return;
      // 읽기만으로 결과 불명 상태를 해제하지 않는다. 새 사진을 본 뒤 사용자가 직접 확인한다.
      emit({ profile, ready: true, uncertain: state.uncertain ? { reviewed: true } : null });
    } catch (error) {
      if (current() && operation.id === sequence) emit({ ready: false, error: errorMessage(error) });
    } finally {
      if (current() && operation.id === sequence) { end(); emit({ pending: null }); }
    }
  };

  const choose = async () => {
    if (!usable() || !state.ready || state.pending || state.uncertain) return;
    const id = ++sequence;
    emit({ pending: "pick", error: null, notice: null });
    try {
      const image = await pickImage();
      // OS 선택기에서 돌아오는 순간 아직 inactive일 수 있다. 같은 화면·계정의 로컬 초안만 받는다.
      if (current() && id === sequence && image) emit({ draft: selectedProfileImage(image) });
    } catch (error) {
      if (current() && id === sequence) emit({ error: errorMessage(error) });
    } finally {
      if (current() && id === sequence) emit({ pending: null });
    }
  };

  const mutate = async (kind: "upload" | "remove", confirmed?: { memberId: string; imageUrl: string | null }) => {
    if (!usable() || !state.ready || state.pending || state.uncertain || !state.profile) return;
    const image = state.draft;
    if (kind === "upload" && !image) return;
    const expectedMember = state.profile.openChatMemberId;
    if (kind === "remove" && (!confirmed || confirmed.memberId !== expectedMember
      || confirmed.imageUrl !== (state.profile.profileImageUrl ?? null))) return;
    const operation = begin(kind);
    try {
      // 저장 직전에 방 참여·종료와 내 방별 멤버를 재확인한다. 다른 계정/방의 초안을 전송하지 않는다.
      const before = await service.read(roomId, operation.signal);
      if (!usable() || operation.id !== sequence) return;
      if (before.openChatMemberId !== expectedMember) throw new ChatContractError();
      if (kind === "remove" && (before.profileImageUrl ?? null) !== confirmed?.imageUrl) throw new ChatContractError();
      writeStarted = true;
      const profile = kind === "upload"
        ? await service.upload(roomId, expectedMember, image!, operation.signal)
        : await service.remove(roomId, expectedMember, operation.signal);
      // 성공 응답이 먼저 도착했다면 같은 계정의 로컬 상태는 갱신한다. 비활성화 직후의 중복 전송을 막는다.
      if (!current() || operation.id !== sequence) return;
      if (profile.openChatMemberId !== expectedMember) throw new ChatContractError();
      emit({ profile, draft: null, ready: true, notice: kind === "upload" ? "이 방의 프로필 사진을 저장했어요." : "프로필 사진을 삭제했어요. 기본 아이콘으로 표시해요." });
      if (isActive()) onSaved?.();
    } catch (error) {
      if (!current() || operation.id !== sequence) return;
      const status = error && typeof error === "object" && "status" in error ? error.status : null;
      const rejected = typeof status === "number" && status >= 400 && status < 500;
      const uncertain = writeStarted && !rejected;
      const unavailable = status === 401 || status === 403 || status === 404 || (!writeStarted && error instanceof ChatContractError);
      emit({ ready: !uncertain && !unavailable, ...(unavailable ? { profile: null, draft: null } : {}),
        ...(uncertain ? { uncertain: { reviewed: false } } : {}), error: uncertain
        ? "사진 변경 결과를 확인하지 못했어요. 현재 사진을 다시 확인해 주세요. 자동으로 다시 전송하지 않아요."
        : errorMessage(error) });
    } finally {
      if (current() && operation.id === sequence) { end(); emit({ pending: null }); }
    }
  };

  return {
    getState: () => state,
    load,
    choose,
    save: () => mutate("upload"),
    remove: (memberId: string, imageUrl: string | null) => mutate("remove", { memberId, imageUrl }),
    clearDraft: () => { if (usable() && !state.pending && !state.uncertain) emit({ draft: null, error: null }); },
    acknowledge: () => {
      if (usable() && state.ready && !state.error && !state.pending && state.uncertain?.reviewed) {
        emit({ uncertain: null, draft: null, error: null });
      }
    },
    suspend: () => {
      // 사진 선택기 자체는 취소하지 않는다. 서버 요청만 끊고 이미 전송한 변경은 결과 불명으로 남긴다.
      if (!current() || !request) return;
      const uncertain = cancelRequest();
      emit({ pending: null, ready: false, ...(uncertain ? { uncertain: { reviewed: false } } : {}) });
    },
    dispose: () => { cancelRequest(); disposed = true; },
  };
}
