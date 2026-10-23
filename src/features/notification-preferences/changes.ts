export type NotificationPreferenceChange = {
  sessionKey: string;
  scope: { kind: "global" } | { kind: "room"; roomId: string };
  value: boolean;
};

const listeners = new Set<(change: NotificationPreferenceChange) => void>();

export function subscribeNotificationPreferenceChanges(listener: (change: NotificationPreferenceChange) => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

// 현재 화면이 서버에서 확인한 값만 전달한다. 계정 세대 검사는 발행·수신 양쪽에서 유지한다.
export function publishNotificationPreferenceChange(change: NotificationPreferenceChange) {
  for (const listener of listeners) {
    try { listener(change); } catch { /* 한 수신자의 실패로 저장 결과를 바꾸지 않는다. */ }
  }
}
