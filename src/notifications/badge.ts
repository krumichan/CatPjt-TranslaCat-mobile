import { parseNotification } from "./intent.ts";

export type BadgeSession = {
  sessionKey: string;
  isCurrent: () => boolean;
};

export type NativeBadgeWriter = (count: number) => Promise<boolean>;

const MAX_NATIVE_BADGE_COUNT = 2_147_483_647;

/** REST에서 검증한 안읽음 수만 받아 세션 전환과 네이티브 쓰기를 직렬화한다. */
export class NotificationBadge {
  private session: BadgeSession | null = null;
  private desiredCount = 0;
  private revision = 0;
  private attemptedRevision = 0;
  private pumping: Promise<void> | null = null;
  private readonly write: NativeBadgeWriter;

  constructor(write: NativeBadgeWriter) {
    this.write = write;
  }

  setSession(session: BadgeSession | null): void {
    // 새 계정의 수를 받기 전에는 이전 계정의 배지를 남기지 않는다.
    const changed = this.session?.sessionKey !== session?.sessionKey;
    this.session = session;
    if (changed || session === null) this.desiredCount = 0;
    this.requestWrite();
  }

  setCount(sessionKey: string, count: number): boolean {
    // payload 숫자나 늦게 끝난 이전 세션 요청을 그대로 네이티브에 쓰지 않는다.
    if (!this.session || this.session.sessionKey !== sessionKey || !this.isCurrent(this.session)
      || !Number.isSafeInteger(count) || count < 0) return false;
    this.desiredCount = Math.min(count, MAX_NATIVE_BADGE_COUNT);
    this.requestWrite();
    return true;
  }

  retry(): void {
    // 지원하지 않는 런처나 일시 실패는 자동 반복하지 않고 다음 명시적 갱신에서 재시도한다.
    this.requestWrite();
  }

  async drain(): Promise<void> {
    while (this.pumping) await this.pumping;
  }

  private isCurrent(session: BadgeSession): boolean {
    try {
      return session.isCurrent();
    } catch {
      return false;
    }
  }

  private requestWrite(): void {
    this.revision += 1;
    this.startWrite();
  }

  private startWrite(): void {
    if (this.pumping) return;
    // 같은 이벤트에서 연속 갱신한 수는 최신 값 하나로 합친다.
    this.pumping = Promise.resolve().then(async () => {
      while (this.attemptedRevision < this.revision) {
        const revision = this.revision;
        const session = this.session;
        const count = session && this.isCurrent(session) ? this.desiredCount : 0;
        this.attemptedRevision = revision;

        // 네이티브 API가 false를 돌려주거나 reject해도 호출자에 미처리 거절을 남기지 않는다.
        try {
          await this.write(count);
        } catch {
          // 이후 setCount/retry에서만 재시도하며 백그라운드 무한 루프를 만들지 않는다.
        }

        // 요청 중 세션이 무효화된 경우에도 이미 진행 중인 쓰기 뒤에 0을 적용한다.
        if (count !== 0 && revision === this.revision && session === this.session
          && session !== null && !this.isCurrent(session)) {
          this.desiredCount = 0;
          this.revision += 1;
        }
      }
    }).finally(() => {
      this.pumping = null;
      // 마지막 await와 완료 콜백 사이에 들어온 갱신도 놓치지 않는다.
      if (this.attemptedRevision < this.revision) this.startWrite();
    });
  }
}

export type ReadNotificationCursor = {
  data: unknown;
  accountBindingId: string | null;
  readRoomCursor?: { roomId: string; lastReadMessageId: string };
  readInvitationIds?: readonly string[];
};

export type PresentedNotificationProof = { identifier: string; eventId: string; accountBindingId: string };

// 0 집계 전에 이미 표시된 알림만 증명한다. 집계 뒤 도착한 새 알림은 이 목록에 없다.
export function presentedNotificationProof(identifier: string, data: unknown): PresentedNotificationProof | null {
  const intent = parseNotification(data);
  return intent ? { identifier, eventId: intent.eventId, accountBindingId: intent.accountBindingId } : null;
}

export function matchesPresentedNotificationProof(identifier: string, data: unknown,
  proof: readonly PresentedNotificationProof[], binding: string): boolean {
  const current = presentedNotificationProof(identifier, data);
  return current !== null && current.accountBindingId === binding && proof.some(item => item.identifier === identifier
    && item.eventId === current.eventId && item.accountBindingId === binding);
}

/** 서버에서 읽음으로 확인한 범위의 현재 계정 알림만 알림창에서 제거한다. */
export function shouldDismissReadNotification(input: ReadNotificationCursor): boolean {
  const intent = parseNotification(input.data);
  if (!intent || !input.accountBindingId || intent.accountBindingId !== input.accountBindingId) return false;
  if (intent.schemaVersion === 2) {
    return Array.isArray(input.readInvitationIds) && input.readInvitationIds.includes(intent.notificationId);
  }

  // 문자열 ID를 Number로 바꾸면 큰 메시지 ID의 경계가 섞이므로 정수 그대로 비교한다.
  const cursor = input.readRoomCursor;
  if (!cursor || intent.roomId !== cursor.roomId || typeof cursor.lastReadMessageId !== "string"
    || !/^[1-9][0-9]{0,19}$/.test(cursor.lastReadMessageId)) return false;
  return BigInt(intent.messageId) <= BigInt(cursor.lastReadMessageId);
}
