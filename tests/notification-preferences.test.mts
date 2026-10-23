import assert from "node:assert/strict";
import test from "node:test";

import { ApiError, createApiClient } from "../src/api/client.ts";
import { ChatContractError } from "../src/domain/chat/contracts.ts";
import { publishNotificationPreferenceChange, subscribeNotificationPreferenceChanges, type NotificationPreferenceChange } from "../src/features/notification-preferences/changes.ts";
import { createNotificationPreferenceController } from "../src/features/notification-preferences/controller.ts";
import { createNotificationPreferenceService } from "../src/features/notification-preferences/service.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((success, failure) => { resolve = success; reject = failure; });
  return { promise, resolve, reject };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

function serviceFixture(body: unknown) {
  const calls: { path: string; method: string; body: unknown; signal?: AbortSignal | null }[] = [];
  const api = createApiClient({ baseUrl: "https://fixture.invalid/api/v1", accessToken: async () => "synthetic-token",
    fetcher: async (input, options) => {
      calls.push({ path: new URL(String(input)).pathname, method: options?.method ?? "GET",
        body: options?.body ? JSON.parse(String(options.body)) : null, signal: options?.signal });
      return new Response(JSON.stringify({ body }));
    },
  });
  return { service: createNotificationPreferenceService(api), calls };
}

function controllerFixture(options: Partial<Parameters<typeof createNotificationPreferenceController>[0]> = {}) {
  const written: boolean[] = [];
  const confirmed: boolean[] = [];
  const changes: unknown[] = [];
  const controller = createNotificationPreferenceController({ read: async () => true,
    write: async value => { written.push(value); return value; }, isCurrent: () => true,
    onConfirmed: value => confirmed.push(value), onChange: value => changes.push(value), ...options });
  return { controller, written, confirmed, changes };
}

test("전체 알림은 GET과 명시적 boolean PUT을 구분하고 기기 해제 요청을 만들지 않는다", async () => {
  // 준비
  const on = serviceFixture({ pushEnabled: true, privateField: "ignored" });
  const off = serviceFixture({ pushEnabled: false });
  const abort = new AbortController();

  // 실행
  assert.deepEqual(await on.service.global(abort.signal), { pushEnabled: true });
  assert.deepEqual(await off.service.setGlobal(false, abort.signal), { pushEnabled: false });

  // 검증
  assert.deepEqual(on.calls, [{ path: "/api/v1/chat/notifications/preferences", method: "GET", body: null, signal: abort.signal }]);
  assert.deepEqual(off.calls, [{ path: "/api/v1/chat/notifications/preferences", method: "PUT", body: { pushEnabled: false }, signal: abort.signal }]);
});

test("방 무음은 현재 방 번호와 muted만 전송하고 응답 방을 일치시킨다", async () => {
  // 준비
  const fixture = serviceFixture({ roomId: 7, muted: true });

  // 실행
  assert.deepEqual(await fixture.service.room("7"), { roomId: "7", muted: true });
  await fixture.service.setRoom("7", true);

  // 검증
  assert.deepEqual(fixture.calls.map(call => ({ path: call.path, method: call.method, body: call.body })), [
    { path: "/api/v1/chat/rooms/7/notification-preferences", method: "GET", body: null },
    { path: "/api/v1/chat/rooms/7/notification-preferences", method: "PUT", body: { muted: true } },
  ]);
  await assert.rejects(serviceFixture({ roomId: 8, muted: true }).service.room("7"), ChatContractError);
});

test("누락·문자열 boolean·반올림 ID와 PUT 반대 응답은 성공 설정으로 수락하지 않는다", async () => {
  // 준비
  const globals = [{}, { pushEnabled: "false" }, { pushEnabled: null }, [], null];
  const rooms = [{ roomId: "7", muted: true }, { roomId: 7, muted: 1 }, { roomId: Number.MAX_SAFE_INTEGER + 1, muted: true }];

  // 실행·검증
  for (const body of globals) await assert.rejects(serviceFixture(body).service.global(), ChatContractError);
  for (const body of rooms) await assert.rejects(serviceFixture(body).service.room("7"), ChatContractError);
  await assert.rejects(serviceFixture({ pushEnabled: true }).service.setGlobal(false), ChatContractError);
  await assert.rejects(serviceFixture({ roomId: 7, muted: false }).service.setRoom("7", true), ChatContractError);
});

test("unsafe 방 경로와 boolean 아닌 설정 입력은 HTTP 요청 전에 거절한다", async () => {
  // 준비
  const { service, calls } = serviceFixture({});

  // 실행·검증
  for (const roomId of ["0", "07", "../7", "9007199254740992", "7?x=1"]) {
    await assert.rejects(service.room(roomId), ChatContractError);
    await assert.rejects(service.setRoom(roomId, true), ChatContractError);
  }
  await assert.rejects(service.setGlobal("false" as unknown as boolean), ChatContractError);
  await assert.rejects(service.setRoom("7", 1 as unknown as boolean), ChatContractError);
  assert.equal(calls.length, 0);
});

test("알림 설정 PUT 실패는 401·503·네트워크 오류에서도 자동 재전송하지 않는다", async () => {
  // 준비·실행·검증: 불확실한 변경을 반복하지 않는다는 사용자 동작 계약이다.
  for (const status of [0, 401, 503]) {
    let calls = 0;
    const service = createNotificationPreferenceService(createApiClient({ baseUrl: "https://fixture.invalid/api/v1",
      accessToken: async () => "synthetic-token", fetcher: async () => {
        calls++;
        if (!status) throw new Error("synthetic-private-error");
        return new Response("", { status });
      },
    }));
    await assert.rejects(service.setGlobal(false), ApiError);
    assert.equal(calls, 1);
  }
});

test("인증 토큰을 기다리는 동안 계정이 바뀌면 설정을 보내지 않는다", async () => {
  // 준비
  let current = true;
  let calls = 0;
  const token = deferred<string>();
  const service = createNotificationPreferenceService(createApiClient({ baseUrl: "https://fixture.invalid/api/v1",
    accessToken: () => token.promise, assertCurrentSession: () => { if (!current) throw new ApiError(0, "SESSION_CHANGED"); },
    fetcher: async () => { calls++; return new Response(""); },
  }));

  // 실행
  const pending = service.setGlobal(false);
  current = false;
  token.resolve("synthetic-token");

  // 검증
  await assert.rejects(pending, { code: "SESSION_CHANGED" });
  assert.equal(calls, 0);
});

test("서버 조회 전에는 기본 켜짐을 저장값으로 표시하거나 토글 요청을 보내지 않는다", async () => {
  // 준비
  const { controller, written, confirmed } = controllerFixture();

  // 실행
  await controller.setValue(false);
  assert.equal(controller.getState().value, null);
  await controller.load();

  // 검증
  assert.deepEqual(written, []);
  assert.deepEqual(confirmed, [true]);
  assert.equal(controller.getState().value, true);
  assert.equal(controller.getState().loading, false);
});

test("전체 알림 끄기 저장 중 연속 탭·조회는 PUT 하나만 유지하고 성공 뒤 확인 이벤트를 보낸다", async () => {
  // 준비
  const pending = deferred<boolean>();
  let reads = 0;
  let writes = 0;
  const { controller, confirmed } = controllerFixture({ read: async () => { reads++; return true; },
    write: () => { writes++; return pending.promise; } });
  await controller.load();

  // 실행
  const change = controller.setValue(false);
  await tick();
  await controller.setValue(true);
  await controller.load();
  assert.equal(controller.getState().saving, true);
  assert.equal(controller.getState().value, false);
  pending.resolve(false);
  await change;

  // 검증
  assert.equal(writes, 1);
  assert.equal(reads, 1);
  assert.deepEqual(confirmed, [true, false]);
  assert.equal(controller.getState().saving, false);
  assert.match(controller.getState().notice!, /저장했어요/);
});

test("저장 실패는 마지막 확인 값으로 rollback하고 GET으로 실제 반영값을 확인한다", async () => {
  // 준비
  let stored = true;
  let writes = 0;
  const { controller, confirmed } = controllerFixture({ read: async () => stored,
    write: async value => { writes++; stored = value; throw new Error("SYNTHETIC_PRIVATE_DETAIL"); } });
  await controller.load();

  // 실행
  await controller.setValue(false);
  assert.equal(controller.getState().value, true);
  assert.equal(controller.getState().uncertain, true);
  await controller.setValue(false);
  await controller.load();

  // 검증
  assert.equal(writes, 1);
  assert.equal(controller.getState().value, false);
  assert.equal(controller.getState().uncertain, false);
  assert.deepEqual(confirmed, [true, false]);
  assert.doesNotMatch(JSON.stringify(controller.getState()), /SYNTHETIC_PRIVATE_DETAIL/);
});

test("이전 GET이 늦게 도착해도 새 GET의 저장값을 덮지 못하며 조회 중 PUT도 막는다", async () => {
  // 준비
  const old = deferred<boolean>();
  const fresh = deferred<boolean>();
  let reads = 0;
  const { controller, written, confirmed } = controllerFixture({ read: () => ++reads === 1 ? old.promise : fresh.promise });
  const first = controller.load();
  await tick();

  // 실행
  const second = controller.load();
  await tick();
  await controller.setValue(false);
  fresh.resolve(false);
  await second;
  old.resolve(true);
  await first;

  // 검증
  assert.equal(controller.getState().value, false);
  assert.deepEqual(written, []);
  assert.deepEqual(confirmed, [false]);
});

test("deadline 뒤 Abort를 무시하는 PUT 성공은 성공 표시나 이벤트가 되지 않는다", async () => {
  // 준비
  const pending = deferred<boolean>();
  let signal: AbortSignal | null = null;
  const { controller, confirmed } = controllerFixture({ timeoutMs: 10,
    write: (_, abort) => { signal = abort; return pending.promise; } });
  await controller.load();

  // 실행
  await controller.setValue(false);
  assert.equal((signal as AbortSignal | null)?.aborted, true);
  pending.resolve(false);
  await tick();

  // 검증
  assert.equal(controller.getState().value, true);
  assert.equal(controller.getState().uncertain, true);
  assert.deepEqual(confirmed, [true]);
});

test("계정 변경과 dispose 후 이전 PUT의 오류·성공을 새 화면에 반영하지 않는다", async () => {
  // 준비·실행·검증: 성공과 실패를 독립 controller로 확인한다.
  for (const success of [true, false]) {
    let current = true;
    const pending = deferred<boolean>();
    const { controller, confirmed, changes } = controllerFixture({ isCurrent: () => current, write: () => pending.promise });
    await controller.load();
    const write = controller.setValue(false);
    await tick();
    const before = changes.length;
    current = false;
    controller.dispose();
    if (success) pending.resolve(false); else pending.reject(new Error("SYNTHETIC_OLD_ACCOUNT"));
    await write;
    assert.equal(changes.length, before);
    assert.deepEqual(confirmed, [true]);
  }
});

test("저장 호출 직전 화면이 비활성이 되면 읽기·쓰기 네트워크 작업을 실행하지 않는다", async () => {
  // 준비
  let current = true;
  let reads = 0;
  let writes = 0;
  const { controller } = controllerFixture({ isCurrent: () => current,
    read: async () => { reads++; return true; }, write: async next => { writes++; return next; } });
  await controller.load();

  // 실행
  const pending = controller.setValue(false);
  current = false;
  await pending;
  await controller.load();

  // 검증
  assert.equal(reads, 1);
  assert.equal(writes, 0);
});

test("조회 실패는 확인되지 않은 값을 켜짐으로 대체하지 않고 명시적 재조회가 가능하다", async () => {
  // 준비
  let fail = true;
  const { controller, confirmed } = controllerFixture({ read: async () => {
    if (fail) throw new Error("SYNTHETIC_TRANSPORT");
    return false;
  } });

  // 실행
  await controller.load();
  assert.equal(controller.getState().value, null);
  assert.match(controller.getState().error!, /다시 불러와/);
  fail = false;
  await controller.load();

  // 검증
  assert.equal(controller.getState().value, false);
  assert.equal(controller.getState().error, null);
  assert.deepEqual(confirmed, [false]);
});

test("설정 변경 이벤트는 확인한 세션·범위·boolean만 전달하며 구독 해제를 지킨다", () => {
  // 준비
  const values: NotificationPreferenceChange[] = [];
  const stop = subscribeNotificationPreferenceChanges(value => values.push(value));
  const stopThrowing = subscribeNotificationPreferenceChanges(() => { throw new Error("synthetic listener"); });
  const global: NotificationPreferenceChange = { sessionKey: "synthetic-session-a", scope: { kind: "global" }, value: false };
  const room: NotificationPreferenceChange = { sessionKey: "synthetic-session-a", scope: { kind: "room", roomId: "7" }, value: true };

  // 실행
  publishNotificationPreferenceChange(global);
  publishNotificationPreferenceChange(room);
  stop();
  stopThrowing();
  publishNotificationPreferenceChange(global);

  // 검증
  assert.deepEqual(values, [global, room]);
});
