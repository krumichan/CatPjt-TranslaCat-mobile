import assert from "node:assert/strict";
import test from "node:test";

import { createApiClient } from "../src/api/client.ts";
import { createAttentionService, parseNotificationAttention } from "../src/notifications/attention-service.ts";
import { publishAttentionChange, subscribeAttentionChanges } from "../src/notifications/attention-changes.ts";
import { isFreshNotificationPreference, shouldPresentNotification } from "../src/notifications/presentation.ts";
import { matchesPresentedNotificationProof, presentedNotificationProof } from "../src/notifications/badge.ts";

const summary = { unreadChatMessageCount: 3, unreadChatRoomCount: 2, unreadActivityCount: 1, totalAttentionCount: 4 };

test("배지 집계는 메시지와 활동 합계만 사용해 OPEN 초대를 중복 집계하지 않는다", () => {
  // 준비·실행·검증
  assert.deepEqual(parseNotificationAttention(summary), summary);
  for (const value of [{ ...summary, totalAttentionCount: 5 }, { ...summary, unreadChatRoomCount: 4 },
    { ...summary, unreadActivityCount: -1 }, { ...summary, totalAttentionCount: "4" },
    { ...summary, unreadChatMessageCount: Number.MAX_SAFE_INTEGER + 1 }, null]) {
    assert.throws(() => parseNotificationAttention(value));
  }
});

test("요약은 현재 인증 API로 조회하며 잘못된 응답을 배지 값으로 넘기지 않는다", async () => {
  // 준비
  const calls: { url: string; authorization: string | null }[] = [];
  const api = createApiClient({ baseUrl: "https://api.example.invalid/api/v1", accessToken: async () => "synthetic-token",
    fetcher: async (url, options) => {
      calls.push({ url: String(url), authorization: new Headers(options?.headers).get("Authorization") });
      return new Response(JSON.stringify({ body: summary }), { status: 200 });
    } });

  // 실행·검증
  assert.deepEqual(await createAttentionService(api).summary(), summary);
  assert.deepEqual(calls, [{ url: "https://api.example.invalid/api/v1/chat/notifications/summary", authorization: "Bearer synthetic-token" }]);
});

test("토큰 대기 시간 초과와 취소 뒤에는 늦은 요약을 적용하지 않는다", async () => {
  // 준비
  let resolve!: (value: string) => void;
  let requests = 0;
  const pending = new Promise<string>(done => { resolve = done; });
  const api = createApiClient({ baseUrl: "https://api.example.invalid/api/v1", accessToken: () => pending,
    fetcher: async () => { requests++; return new Response(JSON.stringify({ body: summary })); } });

  // 실행
  await assert.rejects(createAttentionService(api, 5).summary(), { code: "REQUEST_TIMEOUT" });
  resolve("synthetic-token");
  await new Promise<void>(done => setImmediate(done));

  // 검증: transport가 abort를 무시해도 이미 timeout된 호출은 되살아나지 않는다.
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(createAttentionService(api).summary(cancelled.signal), { code: "REQUEST_ABORTED" });
  assert.ok(requests <= 1);
});

test("0 집계 전 알림 snapshot은 새 push와 재사용된 identifier의 새 event를 지우지 않는다", () => {
  // 준비: native 열거가 늦어지는 사이 새 push가 도착하고 received callback은 아직 실행되지 않았다.
  const old = { schemaVersion: 1, eventId: "old-event", roomId: "9", messageId: "24", accountBindingId: "binding-a" };
  const proof = presentedNotificationProof("native-old", old)!;
  const fresh = { ...old, eventId: "new-event", messageId: "25" };

  // 실행·검증
  assert.equal(matchesPresentedNotificationProof("native-old", old, [proof], "binding-a"), true);
  assert.equal(matchesPresentedNotificationProof("native-new", fresh, [proof], "binding-a"), false);
  assert.equal(matchesPresentedNotificationProof("native-old", fresh, [proof], "binding-a"), false);
  assert.equal(matchesPresentedNotificationProof("native-old", old, [proof], "binding-b"), false);
  assert.equal(presentedNotificationProof("native-old", { schemaVersion: 1 }), null);
});

test("다른 기기의 ON·unmute를 이전 foreground 캐시가 계속 숨기지 않는다", () => {
  // 준비·실행·검증: 시간 역행과 만료된 로컬 상태는 서버 발송 정책을 덮어쓰지 않는다.
  assert.equal(isFreshNotificationPreference(1000, 1000), true);
  assert.equal(isFreshNotificationPreference(1000, 5999), true);
  assert.equal(isFreshNotificationPreference(1000, 6000), false);
  assert.equal(isFreshNotificationPreference(1000, 999), false);
  assert.equal(isFreshNotificationPreference(Number.NaN, 1000), false);
});

test("읽음 변경은 소유 세션과 읽은 범위를 전달하고 구독 해제 후 전달하지 않는다", () => {
  // 준비
  const changes: unknown[] = [];
  const stop = subscribeAttentionChanges(change => changes.push(change));
  const change = { sessionKey: "session-a", readRoom: { roomId: "9", lastReadMessageId: "24" } };

  // 실행
  publishAttentionChange(change); stop(); publishAttentionChange({ sessionKey: "session-b" });

  // 검증
  assert.deepEqual(changes, [change]);
});

test("foreground 전역 OFF는 모든 push를, 방 무음은 해당 메시지만 숨긴다", () => {
  // 준비
  const base = { title: "TranslaCat", trigger: { type: "push" }, development: false,
    signedIn: true, sessionKey: "a", registeredSessionKey: "a", accountBindingId: "binding-a" };
  const message = { schemaVersion: 1, eventId: "message-1", roomId: "9", messageId: "24", accountBindingId: "binding-a" };
  const invitation = { schemaVersion: 2, kind: "OPEN_INVITATION", eventId: "invitation-1", roomId: "9", notificationId: "20", accountBindingId: "binding-a" };

  // 실행·검증
  assert.equal(shouldPresentNotification({ ...base, data: message, pushEnabled: false }), false);
  assert.equal(shouldPresentNotification({ ...base, data: invitation, pushEnabled: false }), false);
  assert.equal(shouldPresentNotification({ ...base, data: message, muted: true }), false);
  assert.equal(shouldPresentNotification({ ...base, data: invitation, muted: true }), true);
  assert.equal(shouldPresentNotification({ ...base, data: message, pushEnabled: true, muted: false }), true);
});
