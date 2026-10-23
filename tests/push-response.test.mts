import assert from "node:assert/strict";
import test from "node:test";

import { ApiError } from "../src/api/client.ts";
import { NotificationResponses, verifyNotificationRoom, type NotificationTapState } from "../src/notifications/response.ts";
import { shouldPresentNotification } from "../src/notifications/presentation.ts";

const payload = { schemaVersion: 1, eventId: "event-1", roomId: "11", messageId: "22", accountBindingId: "binding-a" };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, deny) => { resolve = accept; reject = deny; });
  return { promise, resolve, reject };
}

test("foreground는 현재 계정 binding만 표시하고 원격 알림은 개발 진단 제목으로 우회하지 못한다", () => {
  // 준비
  const base = { data: payload, title: "TranslaCat", trigger: { type: "push" }, development: false,
    signedIn: true, sessionKey: "session-a", registeredSessionKey: "session-a", accountBindingId: "binding-a" };
  // 실행 및 검증
  assert.equal(shouldPresentNotification(base), true);
  assert.equal(shouldPresentNotification({ ...base, accountBindingId: "binding-b" }), false);
  assert.equal(shouldPresentNotification({ ...base, sessionKey: "session-b" }), false);
  assert.equal(shouldPresentNotification({ ...base, signedIn: false }), false);
  const diagnostic = { ...base, data: {}, signedIn: false, development: true, title: "TranslaCat 알림 표시 테스트" };
  assert.equal(shouldPresentNotification(diagnostic), false);
  assert.equal(shouldPresentNotification({ ...diagnostic, trigger: null }), true);
  assert.equal(shouldPresentNotification({ ...diagnostic, trigger: null, development: false }), false);
});

test("cold 탭은 인증 복원과 서버 binding을 기다리고 REST 권한 성공 후에만 방을 연다", async () => {
  // 준비
  const states: NotificationTapState[] = [];
  const opened: string[] = [];
  const checks: string[] = [];
  const handler = new NotificationResponses(room => opened.push(room), state => states.push(state));
  // 실행
  handler.receive(payload);
  handler.setSession({ sessionKey: "a", accountBindingId: null, verifyRoom: async () => { throw new Error("NOT_YET"); } });
  handler.setSession({ sessionKey: "a", accountBindingId: "binding-a", verifyRoom: async room => { checks.push(room); return true; } });
  await tick();
  // 검증
  assert.deepEqual(states, ["login-required", "waiting", "opened"]);
  assert.deepEqual(checks, ["11"]);
  assert.deepEqual(opened, ["11"]);
});

test("다른 계정 binding·잘못된 payload는 REST 요청과 탐색을 모두 막는다", async () => {
  // 준비
  const states: NotificationTapState[] = [];
  let checked = 0;
  const handler = new NotificationResponses(() => assert.fail("unexpected navigation"), state => states.push(state));
  handler.setSession({ sessionKey: "b", accountBindingId: "binding-b", verifyRoom: async () => { checked += 1; return true; } });
  // 실행
  handler.receive(payload);
  handler.receive({ ...payload, eventId: "other", roomId: "//external.test" });
  await tick();
  // 검증
  assert.equal(checked, 0);
  assert.deepEqual(states, ["wrong-account"]);
});

test("warm/cold 중복은 한 번만 열고 REST 거절은 종료하며 통신 실패는 재시도를 남긴다", async () => {
  // 준비
  const opened: string[] = [];
  const states: NotificationTapState[] = [];
  let allowed = true;
  const handler = new NotificationResponses(room => opened.push(room), state => states.push(state));
  handler.setSession({ sessionKey: "a", accountBindingId: "binding-a", verifyRoom: async () => allowed });
  // 실행
  handler.receive(payload);
  handler.receive(payload);
  await tick();
  allowed = false;
  handler.receive({ ...payload, eventId: "denied" });
  await tick();
  handler.setSession({ sessionKey: "a", accountBindingId: "binding-a", verifyRoom: async () => { throw new ApiError(0, "NETWORK_UNAVAILABLE"); } });
  handler.receive({ ...payload, eventId: "network" });
  await tick();
  // 검증
  assert.deepEqual(opened, ["11"]);
  assert.deepEqual(states, ["opened", "unavailable", "retry"]);
});

test("REST 권한 응답 도중 계정이 바뀌거나 로그아웃되면 이전 방을 열지 않는다", async () => {
  // 준비
  let release!: (value: boolean) => void;
  const pending = new Promise<boolean>(resolve => { release = resolve; });
  const states: NotificationTapState[] = [];
  const handler = new NotificationResponses(() => assert.fail("stale navigation"), state => states.push(state));
  handler.setSession({ sessionKey: "a", accountBindingId: "binding-a", verifyRoom: async () => pending });
  handler.receive(payload);
  // 실행
  handler.setSession(null);
  handler.setSession({ sessionKey: "b", accountBindingId: "binding-b", verifyRoom: async () => true });
  release(true);
  await tick();
  // 검증
  assert.deepEqual(states, ["wrong-account"]);
});

test("중복 캐시는 128개와 하루 만료로 유한하며 새 이벤트는 정상 처리한다", async () => {
  // 준비
  let now = 0;
  let checked = 0;
  const handler = new NotificationResponses(() => {}, () => {}, () => now);
  handler.setSession({ sessionKey: "a", accountBindingId: "binding-a", verifyRoom: async () => { checked += 1; return false; } });
  // 실행 및 검증
  for (let index = 0; index < 129; index += 1) {
    handler.receive({ ...payload, eventId: `event-${index}` });
    await tick();
  }
  handler.receive({ ...payload, eventId: "event-0" });
  await tick();
  assert.equal(checked, 130);
  now = 86_400_001;
  handler.receive({ ...payload, eventId: "event-128" });
  await tick();
  assert.equal(checked, 131);
});

test("오프라인에서 실패한 같은 탭은 다시 검증하고 성공한 이벤트는 한 번만 연다", async () => {
  // 준비
  const states: NotificationTapState[] = [];
  const opened: string[] = [];
  let online = false;
  let checked = 0;
  const handler = new NotificationResponses(room => opened.push(room), state => states.push(state));
  handler.setSession({
    sessionKey: "a", accountBindingId: "binding-a",
    verifyRoom: async () => {
      checked += 1;
      if (!online) throw new ApiError(0, "NETWORK_UNAVAILABLE");
      return true;
    },
  });

  // 실행 및 검증: 실패 자체가 자동 재시도 루프를 만들지 않는다.
  handler.receive(payload);
  await tick();
  await tick();
  assert.equal(checked, 1);
  assert.deepEqual(opened, []);
  assert.deepEqual(states, ["retry"]);

  // 실행 및 검증: 실패 때의 seen을 해제하되 성공 이후에는 중복 탭을 다시 막는다.
  online = true;
  handler.receive(payload);
  handler.receive(payload);
  await tick();
  handler.receive(payload);
  await handler.retry();
  await tick();
  assert.equal(checked, 2);
  assert.deepEqual(opened, ["11"]);
  assert.deepEqual(states, ["retry", "opened"]);
});

for (const [status, code] of [
  [0, "REQUEST_ABORTED"], [0, "SESSION_REFRESH_UNAVAILABLE"],
  [408, "HTTP_408"], [429, "HTTP_429"], [503, "HTTP_503"],
] as const) {
  test(code + " 실패는 명시 재시도에서 권한을 다시 확인한 뒤 한 번만 연다", async () => {
    // 준비
    const states: NotificationTapState[] = [];
    const opened: string[] = [];
    let checked = 0;
    const handler = new NotificationResponses(room => opened.push(room), state => states.push(state));
    handler.setSession({
      sessionKey: "a", accountBindingId: "binding-a",
      verifyRoom: async () => {
        checked += 1;
        if (checked === 1) throw new ApiError(status, code);
        return true;
      },
    });

    // 실행 및 검증: 일시적인 실패는 pending을 보존하고 명시 동작을 기다린다.
    handler.receive(payload);
    await tick();
    await tick();
    assert.equal(checked, 1);
    assert.deepEqual(states, ["retry"]);
    assert.deepEqual(opened, []);

    // 실행 및 검증: 성공 뒤에는 retry와 원래 탭 모두 다시 열지 않는다.
    await handler.retry();
    handler.receive(payload);
    await handler.retry();
    await tick();
    assert.equal(checked, 2);
    assert.deepEqual(states, ["retry", "opened"]);
    assert.deepEqual(opened, ["11"]);
  });
}

for (const [status, code] of [
  [403, "HTTP_403"], [404, "HTTP_404"], [200, "INVALID_API_RESPONSE"],
] as const) {
  test(code + " 거절은 종료되어 재시도나 같은 탭으로 방을 다시 검사하지 않는다", async () => {
    // 준비
    const states: NotificationTapState[] = [];
    let checked = 0;
    const handler = new NotificationResponses(() => assert.fail("terminal navigation"), state => states.push(state));
    const session = {
      sessionKey: "a", accountBindingId: "binding-a",
      verifyRoom: async () => { checked += 1; throw new ApiError(status, code); },
    };
    handler.setSession(session);

    // 실행
    handler.receive(payload);
    await tick();
    await handler.retry();
    handler.receive(payload);
    handler.setSession({ ...session });
    await tick();

    // 검증: 권한 거절과 응답 계약 오류는 연결 회복으로 자동 탐색하지 않는다.
    assert.equal(checked, 1);
    assert.deepEqual(states, ["unavailable"]);
  });
}

test("다른 계정의 탭은 종료되어 원래 계정으로 돌아와도 자동으로 열지 않는다", async () => {
  // 준비
  const states: NotificationTapState[] = [];
  let checked = 0;
  const handler = new NotificationResponses(() => assert.fail("wrong-account navigation"), state => states.push(state));
  const verifyRoom = async () => { checked += 1; return true; };
  handler.setSession({ sessionKey: "b", accountBindingId: "binding-b", verifyRoom });

  // 실행
  handler.receive(payload);
  await tick();
  await handler.retry();
  handler.setSession({ sessionKey: "a", accountBindingId: "binding-a", verifyRoom });
  handler.receive(payload);
  await tick();

  // 검증
  assert.equal(checked, 0);
  assert.deepEqual(states, ["wrong-account"]);
});

test("권한 확인 중 비활성화되면 늦은 성공을 무시하고 복귀 후 새 권한 확인으로만 연다", async () => {
  // 준비
  const first = deferred<boolean>();
  const opened: string[] = [];
  let checked = 0;
  const handler = new NotificationResponses(room => opened.push(room), () => {});
  handler.setSession({
    sessionKey: "a", accountBindingId: "binding-a",
    verifyRoom: async () => { checked += 1; return checked === 1 ? first.promise : true; },
  });

  // 실행 및 검증: 비활성화 전에 시작한 REST 성공은 탐색에 사용할 수 없다.
  handler.receive(payload);
  handler.setActive(false);
  first.resolve(true);
  await tick();
  assert.equal(checked, 1);
  assert.deepEqual(opened, []);

  // 실행 및 검증: pending은 유지하되 복귀 후 새 요청이 성공해야 연다.
  handler.setActive(true);
  await tick();
  assert.equal(checked, 2);
  assert.deepEqual(opened, ["11"]);
});

test("effect cleanup과 setup이 작업 중 재실행되어도 응답 처리가 다시 활성화된다", async () => {
  // 준비
  const first = deferred<boolean>();
  const opened: string[] = [];
  let checked = 0;
  const handler = new NotificationResponses(room => opened.push(room), () => {});
  handler.setSession({
    sessionKey: "a", accountBindingId: "binding-a",
    verifyRoom: async () => { checked += 1; return checked === 1 ? first.promise : true; },
  });
  handler.receive(payload);

  // 실행: 이전 작업이 끝나기 전에 같은 인스턴스의 cleanup과 setup을 재현한다.
  handler.setActive(false);
  handler.setActive(true);
  await tick();
  assert.equal(checked, 1);
  first.resolve(true);
  await tick();

  // 검증: 오래된 성공으로 열지 않고 재활성화된 새 검증으로 한 번만 연다.
  assert.equal(checked, 2);
  assert.deepEqual(opened, ["11"]);
});

test("최종 탐색 시점의 세션이 달라지면 passive effect 전에도 방을 열지 않는다", async () => {
  // 준비
  const opened: string[] = [];
  let current = true;
  let checked = 0;
  const handler = new NotificationResponses(room => opened.push(room), () => {});
  handler.setSession({
    sessionKey: "a", accountBindingId: "binding-a", isCurrent: () => current,
    verifyRoom: async () => {
      checked += 1;
      current = false;
      return true;
    },
  });

  // 실행: setSession 갱신 전에도 실제 인증 세션의 변경을 최종 가드에서 확인한다.
  handler.receive(payload);
  await tick();

  // 검증
  assert.equal(checked, 1);
  assert.deepEqual(opened, []);
});

test("권한 확인 중 여러 재시도는 진행 중인 작업 하나로 합치고 성공 탐색도 한 번이다", async () => {
  // 준비
  const first = deferred<boolean>();
  const opened: string[] = [];
  let checked = 0;
  const handler = new NotificationResponses(room => opened.push(room), () => {});
  handler.setSession({
    sessionKey: "a", accountBindingId: "binding-a",
    verifyRoom: async () => { checked += 1; return first.promise; },
  });
  handler.receive(payload);

  // 실행 및 검증: 명시 재시도를 겹쳐도 REST 요청을 추가하지 않는다.
  const retries = Array.from({ length: 4 }, () => handler.retry());
  await tick();
  assert.equal(checked, 1);
  first.resolve(true);
  await Promise.all(retries);
  await tick();

  // 검증
  assert.equal(checked, 1);
  assert.deepEqual(opened, ["11"]);
});

test("작업 중 겹친 재시도는 통신 실패 뒤 자동 반복을 예약하지 않는다", async () => {
  // 준비
  const first = deferred<boolean>();
  const states: NotificationTapState[] = [];
  let checked = 0;
  const handler = new NotificationResponses(() => assert.fail("offline navigation"), state => states.push(state));
  handler.setSession({
    sessionKey: "a", accountBindingId: "binding-a",
    verifyRoom: async () => {
      checked += 1;
      if (checked === 1) return first.promise;
      throw new ApiError(0, "NETWORK_UNAVAILABLE");
    },
  });
  handler.receive(payload);

  // 실행 및 검증: 작업 중 재시도는 새 큐를 만들지 않고 첫 실패에서 멈춘다.
  const retries = Array.from({ length: 4 }, () => handler.retry());
  first.reject(new ApiError(0, "NETWORK_UNAVAILABLE"));
  await Promise.all(retries);
  await tick();
  await tick();
  assert.equal(checked, 1);
  assert.deepEqual(states, ["retry"]);

  // 실행 및 검증: 실패 후의 명시 재시도도 한 번만 검사하며 스스로 반복하지 않는다.
  await handler.retry();
  await tick();
  await tick();
  assert.equal(checked, 2);
  assert.deepEqual(states, ["retry", "retry"]);
});

test("REST 확인이 끝나지 않아도 전체 제한은 재시도 가능한 시간 초과로 종료한다", async () => {
  // 준비
  const pending = deferred<boolean>();
  let signal!: AbortSignal;

  // 실행 및 검증: signal을 무시하는 포트도 전체 제한을 넘기면 종료하고 중단을 알린다.
  await assert.rejects(verifyNotificationRoom(async currentSignal => {
    signal = currentSignal;
    return pending.promise;
  }, 1), { status: 0, code: "REQUEST_ABORTED" });
  assert.equal(signal.aborted, true);

  // 검증: 시간 초과 뒤 도착한 원래 포트의 거절도 관찰되어 unhandled rejection을 만들지 않는다.
  pending.reject(new Error("synthetic late REST failure"));
  await tick();
});

test("정상 권한 확인은 타이머를 해제하여 완료 후 signal을 중단하지 않는다", async () => {
  // 준비
  let signal!: AbortSignal;

  // 실행
  const allowed = await verifyNotificationRoom(async currentSignal => {
    signal = currentSignal;
    return true;
  }, 1);
  await new Promise<void>(resolve => setTimeout(resolve, 5));

  // 검증: 원래 제한 시간이 지나도 성공한 작업의 signal은 중단되지 않는다.
  assert.equal(allowed, true);
  assert.equal(signal.aborted, false);
});

test("전체 확인 제한은 서버 응답 계약 오류를 시간 초과로 바꾸지 않는다", async () => {
  // 준비
  const failure = new ApiError(200, "INVALID_API_RESPONSE");

  // 실행 및 검증: 기존 terminal 분류가 오류 객체 그대로 유지된다.
  await assert.rejects(verifyNotificationRoom(async () => { throw failure; }, 5), error => error === failure);
});
