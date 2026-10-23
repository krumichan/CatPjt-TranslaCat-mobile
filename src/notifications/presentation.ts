import { parseNotification } from "./intent.ts";

export function isFreshNotificationPreference(confirmedAt: number, now = Date.now()) {
  // 발송 직전 서버 정책이 기준이다. 로컬 설정 변경과 이미 전송 중인 알림의 짧은 경쟁만 막는다.
  return Number.isFinite(confirmedAt) && now >= confirmedAt && now - confirmedAt < 5000;
}

export function shouldPresentNotification(input: {
  data: unknown; title: unknown; trigger: unknown; development: boolean;
  signedIn: boolean; sessionKey: string | null; registeredSessionKey: string | null; accountBindingId: string | null;
  pushEnabled?: boolean; muted?: boolean;
}): boolean {
  const intent = parseNotification(input.data);
  if (input.signedIn && input.sessionKey !== null && input.sessionKey === input.registeredSessionKey
    && intent !== null && intent.accountBindingId === input.accountBindingId) {
    return input.pushEnabled !== false && (intent.schemaVersion !== 1 || input.muted !== true);
  }
  // scheduleNotificationAsync({ trigger: null })만 진단 예외다. 원격 push trigger는 제목을 같게 해도 예외가 아니다.
  return input.development && input.trigger === null && input.title === "TranslaCat 알림 표시 테스트";
}
