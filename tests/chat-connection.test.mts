import assert from "node:assert/strict";
import test from "node:test";
import { Client, type IFrame } from "@stomp/stompjs";

import { ApiError } from "../src/api/client.ts";
import { chatSocketUrl, connectRoom } from "../src/realtime/connection.ts";

const connectedFrame: IFrame = {
  command: "CONNECTED", headers: {}, body: "", binaryBody: new Uint8Array(), isBinaryBody: false,
};

function harness(accessToken: () => Promise<string | null>) {
  let active = false;
  let client: Client;
  let pending = Promise.resolve();
  let activations = 0;
  const tokens: string[] = [];
  const statuses: string[] = [];
  const timers: { callback: () => void; delay: number; cancelled: boolean }[] = [];
  const close = connectRoom({
    apiBaseUrl: "https://fixture.example.test/api/v1", roomId: "3", open: false, accessToken,
    onEvent() {}, onConnect() {}, onInvalidEvent() {}, onStatus: status => statuses.push(status),
  }, {
    createClient: configuration => {
      // 실제 STOMP 설정을 사용하고 네트워크 활성화와 시간 경계만 대체한다.
      client = new Client(configuration);
      client.activate = () => {
        active = true;
        activations += 1;
        pending = Promise.resolve(client.beforeConnect(client)).then(() => {
          if (!active) return;
          tokens.push(client.connectHeaders.Authorization ?? "");
          client.onConnect(connectedFrame);
        });
      };
      client.deactivate = async () => { active = false; };
      client.subscribe = () => ({ id: "fixture-subscription", unsubscribe() {} });
      return client;
    },
    scheduleRetry: (callback, delay) => {
      const timer = { callback, delay, cancelled: false };
      timers.push(timer);
      return () => { timer.cancelled = true; };
    },
  });
  return {
    close, tokens, statuses, timers,
    settled: () => pending,
    activations: () => activations,
    rejectStomp: () => client.onStompError(connectedFrame),
    async reconnect() { active = false; client.activate(); await pending; },
    async runNext() {
      const timer = timers.shift();
      assert.ok(timer);
      if (!timer.cancelled) timer.callback();
      await pending;
    },
  };
}

test("일시적인 refresh 503 뒤 토큰을 다시 받아 인증된 연결로 회복한다", async () => {
  // 준비
  let lookups = 0;
  const value = harness(async () => {
    if (++lookups === 1) throw new ApiError(503, "HTTP_503");
    return "fixture-refreshed-token";
  });
  await value.settled();
  assert.equal(value.tokens.length, 0);
  assert.equal(value.timers[0]?.delay, 3000);
  // 실행
  await value.runNext();
  // 검증: 실패한 CONNECT를 보내지 않으며 다음 시도에서 현재 토큰을 다시 요청한다.
  assert.equal(lookups, 2);
  assert.deepEqual(value.tokens, ["Bearer fixture-refreshed-token"]);
  assert.ok(value.statuses.includes("RETRYING"));
  assert.equal(value.statuses.at(-1), "CONNECTED");
  value.close();
});

test("반복적인 네트워크 실패는 최대 30초의 지수 backoff로 제한한다", async () => {
  // 준비
  const value = harness(async () => { throw new TypeError("synthetic network failure"); });
  const delays: number[] = [];
  await value.settled();
  // 실행
  for (let attempt = 0; attempt < 6; attempt += 1) {
    delays.push(value.timers[0]!.delay);
    await value.runNext();
  }
  // 검증
  assert.deepEqual(delays, [3000, 6000, 12000, 24000, 30000, 30000]);
  assert.equal(value.tokens.length, 0);
  value.close();
});

test("401·403·계정 변경·빈 토큰은 backoff 없이 영구 중단한다", async () => {
  // 준비
  const errors = [new ApiError(401, "HTTP_401"), new ApiError(403, "HTTP_403"), new ApiError(0, "SESSION_CHANGED"), null];
  // 실행·검증
  for (const error of errors) {
    const value = harness(async () => { if (error) throw error; return null; });
    await value.settled();
    assert.equal(value.tokens.length, 0);
    assert.equal(value.timers.length, 0);
    assert.equal(value.activations(), 1);
    assert.equal(value.statuses.at(-1), "ERROR");
    value.close();
  }
});

test("화면 종료는 이미 예약한 인증 재시도를 취소한다", async () => {
  // 준비
  let lookups = 0;
  const value = harness(async () => { lookups += 1; throw new ApiError(503, "HTTP_503"); });
  await value.settled();
  // 실행
  value.close();
  await value.runNext();
  // 검증
  assert.equal(lookups, 1);
  assert.equal(value.activations(), 1);
});

test("종료 뒤 늦은 토큰 조회 성공으로 연결을 되살리지 않는다", async () => {
  // 준비
  let resolve: (value: string) => void = () => {};
  const token = new Promise<string>(accept => { resolve = accept; });
  const value = harness(() => token);
  // 실행
  value.close();
  resolve("fixture-late-token");
  await value.settled();
  // 검증
  assert.equal(value.tokens.length, 0);
  assert.equal(value.timers.length, 0);
});

test("일반 소켓 재연결도 이전 토큰을 재사용하지 않는다", async () => {
  // 준비
  let version = 0;
  const value = harness(async () => `fixture-token-${++version}`);
  await value.settled();
  // 실행
  await value.reconnect();
  // 검증
  assert.deepEqual(value.tokens, ["Bearer fixture-token-1", "Bearer fixture-token-2"]);
  value.close();
});

test("명시적 STOMP 거부는 자동 재접속하지 않고 새 연결에서만 재확인한다", async () => {
  // 준비
  const value = harness(async () => "fixture-token");
  await value.settled();
  // 실행
  value.rejectStomp();
  // 검증: 부모의 명시적 새로고침은 기존 연결을 폐기하고 권한을 확인한 뒤 새 Client를 생성한다.
  assert.equal(value.statuses.at(-1), "ERROR");
  assert.equal(value.timers.length, 0);
  value.close();
  const next = harness(async () => "fixture-rechecked-token");
  await next.settled();
  assert.deepEqual(next.tokens, ["Bearer fixture-rechecked-token"]);
  next.close();
});

test("WebSocket 주소는 공개 API origin과 경로 앞부분을 보존한다", () => {
  // 준비·실행·검증
  assert.equal(chatSocketUrl("https://fixture.example.test/api/v1"), "wss://fixture.example.test/ws/chat");
  assert.equal(chatSocketUrl("http://localhost:8080/service/api/v1/"), "ws://localhost:8080/service/ws/chat");
  for (const url of ["https://fixture.example.test/api/v1?token=fixture", "https://fixture.example.test/other", "https://fixture.example.test/api/v1#fragment"]) {
    assert.throws(() => chatSocketUrl(url));
  }
});
