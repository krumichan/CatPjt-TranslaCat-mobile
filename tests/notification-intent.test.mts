import assert from "node:assert/strict";
import test from "node:test";

import { authorizeNotificationIntent, parseChatNotification } from "../src/notifications/intent.ts";

test("알림은 큰 문자열 ID를 보존하고 계정 및 서버 권한 확인을 요구한다", () => {
  // 준비
  const payload = { schemaVersion: 1, eventId: "event-1", roomId: "9007199254740993",
    messageId: "9007199254740994", accountBindingId: "binding-a" };
  // 실행
  const intent = parseChatNotification(payload);
  // 검증
  assert.ok(intent);
  assert.equal(intent.roomId, payload.roomId);
  assert.equal(authorizeNotificationIntent(intent, null), "login-required");
  assert.equal(authorizeNotificationIntent(intent, "binding-b"), "wrong-account");
  assert.equal(authorizeNotificationIntent(intent, "binding-a"), "verify-membership");
});

test("숫자로 전달된 큰 ID 및 임의 경로와 미지원 schema를 거부한다", () => {
  // 준비
  const valid = { schemaVersion: 1, eventId: "event-1", roomId: "1",
    messageId: "2", accountBindingId: "binding-a" };
  // 실행 및 검증
  for (const changed of [{ roomId: 9007199254740993 }, { roomId: "../settings" },
    { messageId: "0" }, { schemaVersion: 2 }, { accountBindingId: "" }]) {
    assert.equal(parseChatNotification({ ...valid, ...changed }), null);
  }
});
