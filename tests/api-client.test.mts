import assert from "node:assert/strict";
import test from "node:test";

import { ApiError, createApiClient } from "../src/api/client.ts";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, deny) => { resolve = accept; reject = deny; });
  return { promise, resolve, reject };
}

test("잘못된 경로와 미로그인 요청에서는 네트워크나 토큰 유출이 발생하지 않는다", async () => {
  // 준비
  let calls = 0;
  const client = createApiClient({
    baseUrl: "https://api.example.test/api/v1",
    accessToken: async () => null,
    fetcher: async () => { calls++; throw new Error("요청이 실행되면 안 됨"); },
  });
  // 실행 및 검증
  for (const path of ["//evil.test", "/../outside", "/%2e%2e/outside"]) {
    await assert.rejects(client.request(path), { code: "INVALID_API_PATH" });
  }
  await assert.rejects(client.request("/chat/rooms"), { code: "SIGN_IN_REQUIRED" });
  assert.equal(calls, 0);
});

test("BE body 계약을 읽고 HTTP 오류에는 자동 재전송하지 않는다", async () => {
  // 준비
  let calls = 0;
  const client = createApiClient({
    baseUrl: "https://api.example.test/api/v1",
    accessToken: async () => "test-token",
    fetcher: async (url, options) => {
      calls++;
      assert.equal(String(url), "https://api.example.test/api/v1/chat/rooms");
      assert.equal(new Headers(options?.headers).get("Authorization"), "Bearer test-token");
      return calls === 1
        ? new Response(JSON.stringify({ body: { rooms: [] } }), { status: 200 })
        : new Response("비공개 서버 오류", { status: 503 });
    },
  });
  // 실행 및 검증
  assert.deepEqual(await client.request("/chat/rooms"), { rooms: [] });
  await assert.rejects(client.request("/chat/rooms"), { code: "HTTP_503" });
  assert.equal(calls, 2);
});

test("access token 대기 중 계정이 바뀌면 이전 요청을 전송하지 않는다", async () => {
  // 준비
  const token = deferred<string | null>();
  const started = deferred<void>();
  let current = true;
  let calls = 0;
  const client = createApiClient({
    baseUrl: "https://api.example.test/api/v1",
    accessToken: async () => { started.resolve(); return token.promise; },
    assertCurrentSession: () => { if (!current) throw new ApiError(0, "SESSION_CHANGED"); },
    fetcher: async () => { calls++; return new Response(JSON.stringify({ body: {} })); },
  });

  // 실행
  const request = assert.rejects(client.request("/chat/rooms"), { code: "SESSION_CHANGED" });
  await started.promise;
  current = false;
  token.resolve("alice:access:initial");
  await request;

  // 검증
  assert.equal(calls, 0);
});

test("fetch 대기 중 계정이 바뀌면 이전 계정 응답을 반환하지 않는다", async () => {
  // 준비
  const response = deferred<Response>();
  const started = deferred<void>();
  let current = true;
  const client = createApiClient({
    baseUrl: "https://api.example.test/api/v1",
    accessToken: async () => "alice:access:initial",
    assertCurrentSession: () => { if (!current) throw new ApiError(0, "SESSION_CHANGED"); },
    fetcher: async () => { started.resolve(); return response.promise; },
  });

  // 실행
  const request = assert.rejects(client.request("/chat/rooms"), { code: "SESSION_CHANGED" });
  await started.promise;
  current = false;
  response.resolve(new Response(JSON.stringify({ body: { privateRoom: "alice-only" } })));
  await request;
});

test("응답 JSON을 읽는 동안 계정이 바뀌어도 이전 계정 body를 반환하지 않는다", async () => {
  // 준비
  const started = deferred<void>();
  const body = deferred<unknown>();
  const response = new Response(null, { status: 200 });
  response.json = async () => { started.resolve(); return body.promise; };
  let current = true;
  const client = createApiClient({
    baseUrl: "https://api.example.test/api/v1",
    accessToken: async () => "alice:access:initial",
    assertCurrentSession: () => { if (!current) throw new ApiError(0, "SESSION_CHANGED"); },
    fetcher: async () => response,
  });

  // 실행
  const request = assert.rejects(client.request("/chat/rooms"), { code: "SESSION_CHANGED" });
  await started.promise;
  current = false;
  body.resolve({ body: { privateRoom: "alice-only" } });
  await request;
});

test("메시지 POST의 401은 실제 사용한 토큰을 알리고 자동 재전송하지 않는다", async () => {
  // 준비
  let calls = 0;
  const rejectedTokens: string[] = [];
  const client = createApiClient({
    baseUrl: "https://api.example.test/api/v1",
    accessToken: async () => "alice:access:initial",
    onUnauthorized: token => { rejectedTokens.push(token); },
    fetcher: async (_url, options) => {
      calls++;
      assert.equal(options?.method, "POST");
      assert.equal(options?.redirect, "error");
      return new Response(JSON.stringify({
        message: "synthetic private server text", body: { errorCode: "AUTH_TOKEN_INVALID" },
      }), { status: 401 });
    },
  });

  // 실행 및 검증
  await assert.rejects(client.request("/chat/rooms/1/messages", { method: "POST", body: { content: "test" } }),
    (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.code, "HTTP_401");
      assert.equal(error.serverCode, "AUTH_TOKEN_INVALID");
      assert.equal(error.message, "HTTP_401");
      assert.equal(JSON.stringify(error).includes("synthetic private"), false);
      return true;
    });
  assert.deepEqual(rejectedTokens, ["alice:access:initial"]);
  assert.equal(calls, 1);
});

test("본문 없는 401도 JSON 오류로 바뀌지 않고 403은 세션 폐기를 요청하지 않는다", async () => {
  // 준비
  const rejectedTokens: string[] = [];
  let calls = 0;
  const client = createApiClient({
    baseUrl: "https://api.example.test/api/v1",
    accessToken: async () => "alice:access:initial",
    onUnauthorized: token => { rejectedTokens.push(token); },
    fetcher: async () => new Response("", { status: ++calls === 1 ? 401 : 403 }),
  });

  // 실행 및 검증
  await assert.rejects(client.request("/chat/rooms"), { code: "HTTP_401", serverCode: undefined });
  await assert.rejects(client.request("/chat/rooms/1"), { code: "HTTP_403" });
  assert.deepEqual(rejectedTokens, ["alice:access:initial"]);
  assert.equal(calls, 2);
});

test("익명 로그인 요청은 토큰이나 현재 세션 검사 없이 인증 오류를 반환한다", async () => {
  // 준비
  let tokenCalls = 0;
  let rejected = false;
  const client = createApiClient({
    baseUrl: "https://api.example.test/api/v1",
    accessToken: async () => { tokenCalls++; return "unused-token"; },
    assertCurrentSession: () => { throw new Error("익명 요청은 세션을 검사하면 안 됨"); },
    onUnauthorized: () => { rejected = true; },
    fetcher: async (_url, options) => {
      assert.equal(new Headers(options?.headers).has("Authorization"), false);
      return new Response(JSON.stringify({ body: { errorCode: "AUTH_INVALID_CREDENTIALS" } }), { status: 401 });
    },
  });

  // 실행 및 검증
  await assert.rejects(client.request("/auth/login", { method: "POST", authenticated: false }), {
    code: "HTTP_401", serverCode: "AUTH_INVALID_CREDENTIALS",
  });
  assert.equal(tokenCalls, 0);
  assert.equal(rejected, false);
});

test("인증 오류는 허용한 코드와 범위 안의 재시도 초만 반환한다", async () => {
  // 준비
  const responses = [
    { errorCode: "AUTH_PASSWORD_ATTEMPTS_EXCEEDED", retryAfterSeconds: 60 },
    { errorCode: "synthetic-private-code", retryAfterSeconds: 86401 },
    { errorCode: "AUTH_INVALID_INPUT", retryAfterSeconds: -1 },
    { errorCode: "AUTH_INVALID_INPUT", retryAfterSeconds: 1.5 },
  ];
  const client = createApiClient({
    baseUrl: "https://api.example.test/api/v1", accessToken: async () => null,
    fetcher: async () => new Response(JSON.stringify({ body: responses.shift() }), { status: 429 }),
  });

  // 실행 및 검증
  await assert.rejects(client.request("/auth/login", { authenticated: false }), {
    code: "HTTP_429", serverCode: "AUTH_PASSWORD_ATTEMPTS_EXCEEDED", retryAfterSeconds: 60,
  });
  await assert.rejects(client.request("/auth/login", { authenticated: false }), {
    code: "HTTP_429", serverCode: undefined, retryAfterSeconds: undefined,
  });
  for (let remaining = 0; remaining < 2; remaining++) {
    await assert.rejects(client.request("/auth/login", { authenticated: false }), {
      code: "HTTP_429", serverCode: "AUTH_INVALID_INPUT", retryAfterSeconds: undefined,
    });
  }
});

test("네트워크와 요청 취소를 인증 거절과 구분하고 공급자 오류 원문을 숨긴다", async () => {
  // 준비
  const controller = new AbortController();
  let rejected = false;
  const client = createApiClient({
    baseUrl: "https://api.example.test/api/v1",
    accessToken: async () => "alice:access:initial",
    onUnauthorized: () => { rejected = true; },
    fetcher: async () => { throw new Error("synthetic private transport error"); },
  });

  // 실행 및 검증
  await assert.rejects(client.request("/chat/rooms"), { status: 0, code: "NETWORK_UNAVAILABLE", message: "NETWORK_UNAVAILABLE" });
  controller.abort();
  await assert.rejects(client.request("/chat/rooms", { signal: controller.signal }), {
    status: 0, code: "REQUEST_ABORTED", message: "REQUEST_ABORTED",
  });
  assert.equal(rejected, false);
});

test("성공 응답의 잘못된 JSON과 body 없는 envelope를 서버 원문 없이 거부한다", async () => {
  // 준비
  let calls = 0;
  const client = createApiClient({
    baseUrl: "https://api.example.test/api/v1", accessToken: async () => "alice:access:initial",
    fetcher: async () => new Response(++calls === 1 ? "synthetic non-json" : JSON.stringify({ message: "missing body" })),
  });

  // 실행 및 검증
  for (let request = 0; request < 2; request++) {
    await assert.rejects(client.request("/chat/rooms"), { code: "INVALID_API_RESPONSE", message: "INVALID_API_RESPONSE" });
  }
  assert.equal(calls, 2);
});
