export type ChatNotificationIntent = {
  schemaVersion: 1;
  eventId: string;
  roomId: string;
  messageId: string;
  accountBindingId: string;
};
export type OpenInvitationNotificationIntent = {
  schemaVersion: 2;
  kind: "OPEN_INVITATION";
  eventId: string;
  notificationId: string;
  roomId: string;
  accountBindingId: string;
};
export type NotificationIntent = ChatNotificationIntent | OpenInvitationNotificationIntent;

function isOpaqueId(value: unknown): value is string {
  return typeof value === "string" && /^[1-9][0-9]{0,19}$/.test(value);
}

export function parseChatNotification(data: unknown): ChatNotificationIntent | null {
  // payload는 외부 입력이다. 숫자 ID는 정밀도가 이미 손실될 수 있어 문자열만 허용한다.
  if (!data || typeof data !== "object") return null;
  const value = data as Record<string, unknown>;
  if (value.schemaVersion !== 1 || !isOpaqueId(value.roomId) || !isOpaqueId(value.messageId)) {
    return null;
  }
  if (typeof value.eventId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value.eventId)
    || typeof value.accountBindingId !== "string"
    || !/^[A-Za-z0-9_-]{1,128}$/.test(value.accountBindingId)) {
    return null;
  }
  return {
    schemaVersion: 1,
    eventId: value.eventId,
    roomId: value.roomId,
    messageId: value.messageId,
    accountBindingId: value.accountBindingId,
  };
}

export function parseNotification(data: unknown): NotificationIntent | null {
  const chat = parseChatNotification(data);
  if (chat) return chat;
  if (!data || typeof data !== "object") return null;
  const value = data as Record<string, unknown>;
  if (value.schemaVersion !== 2 || value.kind !== "OPEN_INVITATION"
    || !isOpaqueId(value.notificationId) || !isOpaqueId(value.roomId)
    || typeof value.eventId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value.eventId)
    || typeof value.accountBindingId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value.accountBindingId)) return null;
  // 초대에는 가짜 메시지 ID나 payload URL을 쓰지 않는다. 실제 수신권한은 REST에서 다시 확인한다.
  return { schemaVersion: 2, kind: "OPEN_INVITATION", eventId: value.eventId, notificationId: value.notificationId,
    roomId: value.roomId, accountBindingId: value.accountBindingId };
}

export function authorizeNotificationIntent(
  intent: NotificationIntent,
  currentBinding: string | null,
): "login-required" | "wrong-account" | "verify-membership" {
  // 일치하는 계정이라도 REST 멤버십 확인 전에는 대화 내용을 열지 않는다.
  if (!currentBinding) return "login-required";
  return intent.accountBindingId === currentBinding ? "verify-membership" : "wrong-account";
}
