import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { createApiClient } from "../src/api/client.ts";
import { base64Url, createMobileWebLogin } from "../src/auth/mobile-web-login.ts";

const requestId = "12345678-1234-4123-8123-123456789abc";
const redirectUri = "translacat-dev://auth/callback";
const code = "A".repeat(43);

function fixture(change?: (url: URL) => void, type = "success") {
  let randomCalls = 0;
  let savedState = "";
  const requests: { url: string; body: Record<string, unknown> }[] = [];
  const api = createApiClient({
    baseUrl: "https://api.example.test/api/v1", accessToken: async () => { throw new Error("익명 handoff에 토큰이 필요하지 않음"); },
    fetcher: async (url, options) => {
      const body = JSON.parse(String(options?.body));
      requests.push({ url: String(url), body });
      assert.equal(new Headers(options?.headers).has("Authorization"), false);
      if (requests.length === 1) {
        savedState = body.state;
        return Response.json({ body: { requestId, expiresIn: 300 } });
      }
      return Response.json({ body: { accessToken: "synthetic-access", refreshToken: "synthetic-refresh", publicId: "qa-user", accessTokenExpiresIn: 3600 } });
    },
  });
  const login = createMobileWebLogin({
    api, webBaseUrl: "https://translacat.vercel.app", redirectUri,
    randomBytes: async () => new Uint8Array(32).fill(++randomCalls),
    challenge: async verifier => createHash("sha256").update(verifier).digest("base64url"),
    openBrowser: async (url, redirect) => {
      assert.equal(redirect, redirectUri);
      const start = new URL(url);
      assert.equal(start.origin, "https://translacat.vercel.app");
      assert.equal(start.pathname, "/ko/mobile/sign-in");
      assert.deepEqual(Array.from(start.searchParams.keys()), ["requestId"]);
      const callback = new URL(redirect);
      callback.searchParams.set("code", code);
      callback.searchParams.set("state", savedState);
      callback.searchParams.set("requestId", requestId);
      change?.(callback);
      return { type, url: callback.toString() };
    },
  });
  return { login, requests };
}

test("PKCE는 각각의 난수·S256으로 생성하고 verifier는 코드 교환에만 전달한다", async () => {
  // 준비 및 실행
  const { login, requests } = fixture();
  const result = await login();

  // 검증: 브라우저 URL과 첫 요청에는 장기 토큰과 verifier가 없다.
  assert.equal(result.publicId, "qa-user");
  assert.equal(requests.length, 2);
  const request = requests[0].body;
  const exchange = requests[1].body;
  assert.deepEqual(Object.keys(request).sort(), ["codeChallenge", "redirectUri", "state"]);
  assert.equal(request.codeChallenge, createHash("sha256").update(String(exchange.codeVerifier)).digest("base64url"));
  assert.notEqual(exchange.codeVerifier, request.state);
  assert.equal(exchange.requestId, requestId);
  assert.equal(exchange.code, code);
});

for (const [name, change] of [
  ["state 불일치", (url: URL) => url.searchParams.set("state", "B".repeat(43))],
  ["다른 요청 ID", (url: URL) => url.searchParams.set("requestId", "00000000-0000-4000-8000-000000000000")],
  ["중복 코드", (url: URL) => url.searchParams.append("code", code)],
  ["임의 query", (url: URL) => url.searchParams.set("token", "synthetic")],
  ["다른 scheme", (url: URL) => { url.protocol = "evil:"; }],
  ["다른 path", (url: URL) => { url.pathname = "/other"; }],
  ["fragment", (url: URL) => { url.hash = "unsafe"; }],
] as const) {
  test(`인증 callback의 ${name}를 교환 전에 거부한다`, async () => {
    // 준비
    const { login, requests } = fixture(change);

    // 실행 및 검증
    await assert.rejects(login(), { code: "INVALID_MOBILE_AUTH_CALLBACK" });
    assert.equal(requests.length, 1);
  });
}

test("브라우저 취소는 토큰 교환이나 자동 재전송을 하지 않는다", async () => {
  // 준비
  const { login, requests } = fixture(undefined, "cancel");

  // 실행 및 검증
  await assert.rejects(login(), { code: "MOBILE_AUTH_CANCELLED" });
  assert.equal(requests.length, 1);
});

test("base64url 인코딩은 패딩 없이 원래 난수 바이트를 보존한다", () => {
  // 준비
  const bytes = Uint8Array.from({ length: 32 }, (_, index) => index);

  // 실행 및 검증
  assert.equal(base64Url(bytes), Buffer.from(bytes).toString("base64url"));
});

test("빈 userinfo를 URL parser가 정규화해도 앱 복귀 주소로 허용하지 않는다", async () => {
  // 준비
  let calls = 0;
  const api = createApiClient({ baseUrl: "https://api.example.test/api/v1", accessToken: async () => null,
    fetcher: async () => { calls++; return Response.json({ body: { requestId, expiresIn: 300 } }); } });
  const login = createMobileWebLogin({ api, webBaseUrl: "https://translacat.vercel.app", redirectUri,
    randomBytes: async () => new Uint8Array(32).fill(1),
    challenge: async verifier => createHash("sha256").update(verifier).digest("base64url"),
    openBrowser: async () => ({ type: "success", url: "translacat-dev://@auth/callback?code=" + code
      + "&state=" + base64Url(new Uint8Array(32).fill(1)) + "&requestId=" + requestId }),
  });

  // 실행 및 검증
  await assert.rejects(login(), { code: "INVALID_MOBILE_AUTH_CALLBACK" });
  assert.equal(calls, 1);
});
