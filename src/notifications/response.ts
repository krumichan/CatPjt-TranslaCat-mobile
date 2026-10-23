import { ApiError } from "../api/client.ts";
import { authorizeNotificationIntent, parseNotification, type NotificationIntent } from "./intent.ts";

export type NotificationTapState = "idle" | "login-required" | "waiting" | "wrong-account" | "unavailable" | "retry" | "opened";
export type TapSession = {
  sessionKey: string; accountBindingId: string | null;
  isCurrent?(): boolean;
  verifyRoom(roomId: string): Promise<boolean>;
  verifyInvitation?(notificationId: string, roomId: string): Promise<boolean>;
};

function transient(error: unknown): boolean {
  return error instanceof ApiError && (
    error.status === 0 && ["NETWORK_UNAVAILABLE", "REQUEST_ABORTED", "SESSION_REFRESH_UNAVAILABLE"].includes(error.code)
    || error.status === 408 || error.status === 429 || error.status >= 500 && error.status <= 599
  );
}

export async function verifyNotificationRoom(
  verify: (signal: AbortSignal) => Promise<boolean>, timeoutMs = 12_000,
): Promise<boolean> {
  const cancellation = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // 토큰 갱신이 signal을 기다리지 않아도 전체 방 확인은 제한 시간에 종료한다.
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new ApiError(0, "REQUEST_ABORTED"));
      cancellation.abort();
    }, timeoutMs);
  });
  try {
    // race는 제한 시간 뒤 도착하는 기존 요청의 reject도 관찰해 미처리 오류를 남기지 않는다.
    return await Promise.race([Promise.resolve().then(() => verify(cancellation.signal)), timeout]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

export class NotificationResponses {
  private pending: NotificationIntent | null = null;
  private seen = new Map<string, number>();
  private session: TapSession | null = null;
  private active = true;
  private epoch = 0;
  private working = false;
  private again = false;
  private navigate: (roomId: string) => void;
  private state: (state: NotificationTapState) => void;
  private now: () => number;
  private navigateInvitation: (notificationId: string, roomId: string) => void;

  constructor(navigate: (roomId: string) => void, state: (state: NotificationTapState) => void, now: () => number = Date.now,
    navigateInvitation: (notificationId: string, roomId: string) => void = () => {}) {
    this.navigate = navigate;
    this.state = state;
    this.now = now;
    this.navigateInvitation = navigateInvitation;
  }

  setSession(session: TapSession | null) {
    this.session = session;
    ++this.epoch;
    void this.flush();
  }

  setActive(active: boolean) {
    if (active === this.active) return;
    this.active = active;
    ++this.epoch;
    // 비활성화·effect cleanup은 늦은 응답만 무효화한다. 복귀·재설정은 보류 알림을 다시 검증한다.
    if (active) void this.flush();
  }

  retry(): Promise<void> {
    // 이미 확인 중인 버튼 연타는 추가 재시도나 무한 반복을 예약하지 않는다.
    return this.working ? Promise.resolve() : this.flush();
  }

  private key(intent: NotificationIntent) {
    return intent.accountBindingId + ":" + intent.schemaVersion + ":" + intent.eventId;
  }

  private trimSeen(now: number) {
    for (const [existing, at] of this.seen) if (now - at > 86_400_000) this.seen.delete(existing);
  }

  private remember(intent: NotificationIntent) {
    const now = this.now();
    this.trimSeen(now);
    this.seen.set(this.key(intent), now);
    while (this.seen.size > 128) this.seen.delete(this.seen.keys().next().value!);
  }

  private current(session: TapSession, intent: NotificationIntent, epoch: number) {
    if (!this.active || epoch !== this.epoch || this.session !== session || this.pending !== intent) return false;
    // React의 세션 effect보다 먼저 로그아웃·계정 교체가 발생한 경합도 최종 탐색 직전에 차단한다.
    try { return session.isCurrent?.() ?? true; } catch { return false; }
  }

  receive(data: unknown) {
    const intent = parseNotification(data);
    if (!intent) return;
    // provider 재전송과 warm/cold 중복을 유한한 메모리에서 제거한다. 저장된 payload로 읽음 상태를 갱신하지 않는다.
    const key = this.key(intent);
    this.trimSeen(this.now());
    if (this.seen.has(key)) return;
    this.remember(intent);
    this.pending = intent;
    void this.flush();
  }

  private async flush() {
    if (!this.active) return;
    if (this.working) { this.again = true; return; }
    const intent = this.pending;
    if (!intent) return;
    const session = this.session;
    if (!session) { this.state("login-required"); return; }
    if (!session.accountBindingId) { this.state("waiting"); return; }
    const decision = authorizeNotificationIntent(intent, session.accountBindingId);
    if (decision !== "verify-membership") {
      this.pending = null;
      this.state("wrong-account");
      return;
    }
    const epoch = this.epoch;
    if (!this.current(session, intent, epoch)) return;
    this.working = true;
    this.remember(intent);
    try {
      // 채팅은 기존 멤버십을 확인하고, 초대는 아직 참여 전이므로 수신권한과 방 일치 여부를 확인한다.
      const allowed = intent.schemaVersion === 2
        ? await session.verifyInvitation?.(intent.notificationId, intent.roomId) ?? false
        : await session.verifyRoom(intent.roomId);
      if (!this.current(session, intent, epoch)) return;
      this.pending = null;
      if (!allowed) { this.state("unavailable"); return; }
      if (intent.schemaVersion === 2) this.navigateInvitation(intent.notificationId, intent.roomId);
      else this.navigate(intent.roomId);
      this.state("opened");
    } catch (error) {
      if (!this.current(session, intent, epoch)) return;
      if (transient(error)) {
        // 일시 실패는 보류하며 같은 알림 재탭·명시 재시도·다음 복귀에서만 다시 확인한다.
        this.seen.delete(this.key(intent));
        this.state("retry");
      } else {
        this.pending = null;
        this.state("unavailable");
      }
    } finally {
      this.working = false;
      if (this.again) { this.again = false; void this.flush(); }
    }
  }
}
