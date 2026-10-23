import assert from "node:assert/strict";
import test from "node:test";
import type { Client, StompConfig } from "@stomp/stompjs";

import { ApiError } from "../src/api/client.ts";
import { parseChatNotification, parseNotification } from "../src/notifications/intent.ts";
import { NotificationIntake } from "../src/notifications/intake.ts";
import { shouldPresentNotification } from "../src/notifications/presentation.ts";
import { NotificationResponses, type TapSession } from "../src/notifications/response.ts";
import { connectInvitationFeed, isInvitationRefresh } from "../src/realtime/invitation-feed.ts";

const payload = { schemaVersion: 2, kind: "OPEN_INVITATION", eventId: "invitation_100", notificationId: "100", roomId: "9", accountBindingId: "binding-a" };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>(done => { resolve = done; }), resolve };
}
function fixture() {
  const states: string[] = [];
  const rooms: string[] = [];
  const invitations: string[] = [];
  const calls: string[] = [];
  const handler = new NotificationResponses(room => rooms.push(room), state => states.push(state), Date.now,
    (notificationId, roomId) => invitations.push(`${notificationId}:${roomId}`));
  const session: TapSession = { sessionKey: "a", accountBindingId: "binding-a",
    verifyRoom: async room => { calls.push(`room:${room}`); return true; },
    verifyInvitation: async (id, room) => { calls.push(`invitation:${id}:${room}`); return true; } };
  return { handler, session, states, rooms, invitations, calls };
}

test("v2 초대는 messageId를 요구하지 않으며 v1 TEXT parser와 경로를 분리한다", () => {
  // 준비·실행
  const result = parseNotification({ ...payload, url: "https://evil.invalid", recipientEmail: "private@example.invalid" });

  // 검증
  assert.deepEqual(result, payload);
  assert.equal(parseChatNotification(payload), null);
  assert.equal(JSON.stringify(result).includes("evil"), false);
  for (const changed of [{ notificationId: 100 }, { notificationId: "../settings" }, { roomId: "0" },
    { kind: "TEXT" }, { schemaVersion: 3 }, { accountBindingId: "" }]) assert.equal(parseNotification({ ...payload, ...changed }), null);
});

test("v2 foreground 표시는 같은 현재 계정 binding을 요구한다", () => {
  // 준비
  const base = { data: payload, title: "TranslaCat", trigger: { type: "push" }, development: false,
    signedIn: true, sessionKey: "a", registeredSessionKey: "a", accountBindingId: "binding-a" };

  // 실행·검증
  assert.equal(shouldPresentNotification(base), true);
  assert.equal(shouldPresentNotification({ ...base, accountBindingId: "binding-b" }), false);
  assert.equal(shouldPresentNotification({ ...base, signedIn: false }), false);
});

test("cold 초대는 로그인·binding 복원 뒤 수신권한을 확인하고 가입방 멤버십 검사를 호출하지 않는다", async () => {
  // 준비
  const h = fixture();

  // 실행
  h.handler.receive(payload);
  h.handler.setSession({ ...h.session, accountBindingId: null });
  h.handler.setSession(h.session);
  await tick();

  // 검증
  assert.deepEqual(h.states, ["login-required", "waiting", "opened"]);
  assert.deepEqual(h.calls, ["invitation:100:9"]);
  assert.deepEqual(h.invitations, ["100:9"]);
  assert.deepEqual(h.rooms, []);
});

test("warm/cold 중복 탭은 초대를 한 번만 열고 기존 TEXT는 그대로 멤버십 경로를 사용한다", async () => {
  // 준비
  const h = fixture();
  h.handler.setSession(h.session);
  const intake = new NotificationIntake(data => h.handler.receive(data));

  // 실행
  intake.live(payload); intake.cold(payload); intake.live(payload);
  await tick();
  h.handler.receive({ schemaVersion: 1, eventId: "message_200", roomId: "9", messageId: "200", accountBindingId: "binding-a" });
  await tick();

  // 검증
  assert.deepEqual(h.invitations, ["100:9"]);
  assert.deepEqual(h.rooms, ["9"]);
  assert.deepEqual(h.calls, ["invitation:100:9", "room:9"]);
});

test("다른 계정과 소유권 거절·room 불일치는 초대 탐색을 차단한다", async () => {
  // 준비
  const wrong = fixture();
  const denied = fixture();
  wrong.handler.setSession({ ...wrong.session, accountBindingId: "binding-b" });
  denied.handler.setSession({ ...denied.session, verifyInvitation: async () => false });

  // 실행
  wrong.handler.receive(payload); denied.handler.receive(payload);
  await tick();

  // 검증
  assert.deepEqual(wrong.calls, []);
  assert.deepEqual(wrong.states, ["wrong-account"]);
  assert.deepEqual(denied.states, ["unavailable"]);
  assert.deepEqual(denied.invitations, []);
});

test("REST 소유권 대기 중 로그아웃·계정 전환이 오면 늦은 초대를 열지 않는다", async () => {
  // 준비
  const h = fixture();
  const wait = deferred<boolean>();
  h.handler.setSession({ ...h.session, verifyInvitation: () => wait.promise });
  h.handler.receive(payload);

  // 실행
  h.handler.setSession(null);
  h.handler.setSession({ ...h.session, accountBindingId: "binding-b" });
  wait.resolve(true);
  await tick();

  // 검증
  assert.deepEqual(h.invitations, []);
  assert.deepEqual(h.states, ["wrong-account"]);
});

test("최종 계정 fence·비활성 상태는 초대 탐색을 막고 복귀 시 다시 검증한다", async () => {
  // 준비
  const h = fixture();
  const wait = deferred<boolean>();
  let current = true;
  h.handler.setSession({ ...h.session, isCurrent: () => current, verifyInvitation: () => wait.promise });
  h.handler.receive(payload);

  // 실행
  current = false;
  wait.resolve(true);
  await tick();
  h.handler.setActive(false);
  h.handler.setSession(h.session);
  assert.deepEqual(h.invitations, []);
  h.handler.setActive(true);
  await tick();

  // 검증
  assert.deepEqual(h.invitations, ["100:9"]);
});

test("초대 수신권한 400은 종료하며 일시 실패만 명시 재시도로 다시 확인한다", async () => {
  // 준비
  const denied = fixture();
  const retry = fixture();
  let calls = 0;
  denied.handler.setSession({ ...denied.session, verifyInvitation: async () => { throw new ApiError(400, "HTTP_400"); } });
  retry.handler.setSession({ ...retry.session, verifyInvitation: async () => {
    calls++; if (calls === 1) throw new ApiError(0, "NETWORK_UNAVAILABLE"); return true;
  } });

  // 실행
  denied.handler.receive(payload); retry.handler.receive(payload);
  await tick(); await tick();
  await denied.handler.retry(); await retry.handler.retry();

  // 검증
  assert.deepEqual(denied.states, ["unavailable"]);
  assert.deepEqual(retry.states, ["retry", "opened"]);
  assert.equal(calls, 2);
});

test("수신권한 checker가 없는 이전 consumer는 v2를 기존 멤버십 경로로 우회하지 않는다", async () => {
  // 준비
  const h = fixture();
  const { verifyInvitation: _unused, ...old } = h.session;
  h.handler.setSession(old);

  // 실행
  h.handler.receive(payload);
  await tick();

  // 검증
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.states, ["unavailable"]);
});

function feedFixture(accessToken: () => Promise<string | null> = async () => "synthetic-token") {
  let configuration!: StompConfig;
  let current = true;
  type Receive = (frame: { body: string }) => void;
  const messages = new Map<string, Receive>();
  const reads: unknown[] = [];
  const calls = { activate: 0, deactivate: 0, refresh: 0, destinations: [] as string[] };
  const jobs: { callback: () => void; cancelled: boolean }[] = [];
  const client = { connectHeaders: {}, reconnectDelay: 3000, activate: () => { calls.activate++; },
    deactivate: async () => { calls.deactivate++; }, subscribe: (destination: string, receive: Receive) => {
      calls.destinations.push(destination); messages.set(destination, receive);
    } } as unknown as Client;
  const stop = connectInvitationFeed({ apiBaseUrl: "https://fixture.invalid/api/v1", accessToken,
    isCurrent: () => current, refresh: () => { calls.refresh++; }, onRead: cursor => reads.push(cursor) }, {
    createClient: config => { configuration = config; return client; },
    schedule: callback => { const job = { callback, cancelled: false }; jobs.push(job); return () => { job.cancelled = true; }; },
  });
  return { configuration, calls, reads, client, jobs, stop, leave: () => { current = false; },
    message: (body: string, destination = "/user/queue/chat/notifications") => {
      const message = messages.get(destination); assert.ok(message); message({ body });
    } };
}

test("초대 private feed는 고정 user queue와 최신 자격을 사용하고 reconnect에서 REST 갱신을 요청한다", async () => {
  // 준비
  const h = feedFixture();

  // 실행
  await h.configuration.beforeConnect?.(h.client);
  h.configuration.onConnect?.({} as never);
  h.message(JSON.stringify({ eventType: "chat.notification.created", notification: wireLike() }));
  h.message("invalid-json");
  h.configuration.onConnect?.({} as never);

  // 검증
  assert.deepEqual(h.calls.destinations, ["/user/queue/chat/notifications", "/user/queue/chat/read",
    "/user/queue/chat/notifications", "/user/queue/chat/read"]);
  assert.equal(h.configuration.brokerURL, "wss://fixture.invalid/ws/chat");
  assert.equal(h.calls.refresh, 3);
  assert.deepEqual(h.client.connectHeaders, { Authorization: "Bearer synthetic-token" });
  h.stop();
});
function wireLike() { return { notificationType: "CHAT_INVITATION", payload: { invitationKind: "OPEN_LINK" } }; }

test("다른 기기의 읽음 user queue는 검증된 cursor만 전달하고 계정 전환 뒤 폐기한다", () => {
  // 준비
  const h = feedFixture(); h.configuration.onConnect?.({} as never);
  const body = JSON.stringify({ eventType: "chat.read.updated", chatRoomId: 9, lastReadMessageId: 24 });

  // 실행
  h.message(body, "/user/queue/chat/read");
  h.message(JSON.stringify({ eventType: "chat.read.updated", chatRoomId: 9, lastReadMessageId: Number.MAX_SAFE_INTEGER + 1 }), "/user/queue/chat/read");
  h.leave(); h.message(body, "/user/queue/chat/read"); h.stop();

  // 검증
  assert.deepEqual(h.reads, [{ roomId: "9", lastReadMessageId: "24" }]);
  assert.equal(h.calls.refresh, 2);
});

test("계정 변경·dispose 뒤 feed 이벤트는 이전 계정 캐시를 갱신하지 않는다", async () => {
  // 준비
  const h = feedFixture();
  h.configuration.onConnect?.({} as never);

  // 실행
  h.leave();
  h.message(JSON.stringify({ eventType: "chat.notification.created" }));
  h.stop();
  h.configuration.onConnect?.({} as never);

  // 검증
  assert.equal(h.calls.refresh, 1);
  assert.equal(h.calls.deactivate, 1);
  assert.deepEqual(h.client.connectHeaders, {});
});

test("일시 토큰 오류 feed는 비인증 CONNECT 없이 backoff하고 폐기 후 재연결하지 않는다", async () => {
  // 준비
  const h = feedFixture(async () => { throw new ApiError(0, "SESSION_REFRESH_UNAVAILABLE"); });

  // 실행
  await h.configuration.beforeConnect?.(h.client);
  await tick();
  h.stop();
  for (const job of h.jobs) job.callback();

  // 검증
  assert.equal(h.jobs.length, 1);
  assert.equal(h.jobs[0].cancelled, true);
  assert.equal(h.calls.activate, 1);
  assert.deepEqual(h.client.connectHeaders, {});
});

test("토큰 갱신 대기 중 계정이 바뀌면 이전 CONNECT를 중단하고 자격을 지운다", async () => {
  // 준비
  const wait = deferred<string>();
  const h = feedFixture(() => wait.promise);
  const connecting = h.configuration.beforeConnect?.(h.client);

  // 실행
  h.leave();
  wait.resolve("synthetic-old-token");
  await connecting;
  h.configuration.onConnect?.({} as never);

  // 검증
  assert.equal(h.calls.deactivate, 1);
  assert.equal(h.calls.refresh, 0);
  assert.deepEqual(h.client.connectHeaders, {});
  h.stop();
});

test("초대 갱신 신호 parser는 사용자 queue 이벤트만 받아들이고 임의 JSON을 사용하지 않는다", () => {
  // 준비·실행·검증
  assert.equal(isInvitationRefresh(JSON.stringify({ eventType: "chat.notification.created" })), true);
  assert.equal(isInvitationRefresh(JSON.stringify({ eventType: "chat.member.banned" })), false);
  assert.equal(isInvitationRefresh("null"), false);
  assert.equal(isInvitationRefresh("{"), false);
  assert.equal(isInvitationRefresh("x".repeat(262145)), false);
});
