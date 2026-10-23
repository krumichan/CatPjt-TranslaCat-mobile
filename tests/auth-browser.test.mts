import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import type { AuthSessionOpenOptions, WebBrowserAuthSessionResult } from "expo-web-browser";

import { createApiClient } from "../src/api/client.ts";
import { createAuthBrowser } from "../src/auth/auth-browser.ts";
import { createMobileWebLogin } from "../src/auth/mobile-web-login.ts";
import { AuthSession, type SessionStorage, type SessionTransport, type TokenPair } from "../src/auth/session.ts";

const webUrl = "https://web.example.test/ko/mobile/sign-in?requestId=12345678-1234-4123-8123-123456789abc";
const redirectUri = "translacat-dev://auth/callback";
const requestId = "12345678-1234-4123-8123-123456789abc";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

test("Android 인증은 같은 task를 사용하고 검증할 callback 결과를 그대로 전달한다", async () => {
  // 준비: installed SDK의 타입으로 지원 옵션을 검사한다. 실제 브라우저는 열지 않는다.
  let submitted: [string, string, AuthSessionOpenOptions?] | undefined;
  const result = { type: "success", url: redirectUri + "?synthetic=proof" } as const;
  const openBrowser = createAuthBrowser("android", async (...args) => { submitted = args; return result; });

  // 실행
  const actual = await openBrowser(webUrl, redirectUri);

  // 검증: auth URL·복귀 URL을 바꾸지 않고 플랫폼 옵션만 추가한다.
  assert.deepEqual(submitted, [webUrl, redirectUri, { createTask: false, useProxyActivity: false }]);
  assert.equal(actual, result);
});

test("iOS 인증은 기존 native 세션의 옵션과 callback 기본값을 유지한다", async () => {
  // 준비
  let submitted: unknown[] | undefined;
  const result = { type: "success", url: redirectUri } as const;
  const openBrowser = createAuthBrowser("ios", async (...args) => { submitted = args; return result; });

  // 실행 / 검증: 옵션 객체조차 추가하지 않아 iOS 인증 동작을 바꾸지 않는다.
  assert.equal(await openBrowser(webUrl, redirectUri), result);
  assert.deepEqual(submitted, [webUrl, redirectUri]);
});

for (const type of ["cancel", "dismiss"] as const) {
  test(`SDK의 ${type} 결과를 성공으로 바꾸거나 브라우저를 다시 열지 않는다`, async () => {
    // 준비
    let calls = 0;
    const result = { type } as WebBrowserAuthSessionResult;
    const openBrowser = createAuthBrowser("android", async () => { calls++; return result; });

    // 실행 / 검증
    assert.equal(await openBrowser(webUrl, redirectUri), result);
    assert.equal(calls, 1);
  });
}

test("브라우저 오류는 추가 열기·dismiss·재시도 없이 호출자에게 전달한다", async () => {
  // 준비
  const failure = new Error("synthetic-browser-failure");
  let calls = 0;
  const openBrowser = createAuthBrowser("android", async () => { calls++; throw failure; });

  // 실행 / 검증
  await assert.rejects(openBrowser(webUrl, redirectUri), error => error === failure);
  assert.equal(calls, 1);
});

function loginFixture() {
  const browserStarted = deferred<void>();
  const browserResult = deferred<WebBrowserAuthSessionResult>();
  const requests: string[] = [];
  let callback = "";
  let randomCalls = 0;
  const tokens: TokenPair = {
    accessToken: "synthetic-access", refreshToken: "synthetic-refresh",
    publicId: "synthetic-user", accessTokenExpiresIn: 3600,
  };
  const api = createApiClient({
    baseUrl: "https://api.example.test/api/v1", accessToken: async () => null,
    fetcher: async (url, options) => {
      const path = new URL(String(url)).pathname;
      requests.push(path);
      if (path.endsWith("/requests")) {
        const body = JSON.parse(String(options?.body)) as { state: string };
        const returned = new URL(redirectUri);
        returned.searchParams.set("code", "A".repeat(43));
        returned.searchParams.set("state", body.state);
        returned.searchParams.set("requestId", requestId);
        callback = returned.toString();
        return Response.json({ body: { requestId, expiresIn: 300 } });
      }
      return Response.json({ body: tokens });
    },
  });
  const openBrowser = createAuthBrowser("android", async (_url, _redirect, options) => {
    assert.deepEqual(options, { createTask: false, useProxyActivity: false });
    browserStarted.resolve();
    return browserResult.promise;
  });
  const login = createMobileWebLogin({
    api, webBaseUrl: "https://web.example.test", redirectUri,
    randomBytes: async () => new Uint8Array(32).fill(++randomCalls),
    challenge: async verifier => createHash("sha256").update(verifier).digest("base64url"),
    openBrowser,
  });
  return { login, browserStarted, browserResult, requests, callback: () => callback, tokens };
}

test("인증 callback 뒤 중복 복귀·닫기 신호가 와도 일회 코드는 한 번만 교환한다", async () => {
  // 준비: 모든 자격은 합성 값이며 refresh 저장도 메모리 fixture만 사용한다.
  const fixture = loginFixture();
  let saved: string | null = null;
  let writes = 0;
  const storage: SessionStorage = {
    read: async () => saved,
    write: async value => { saved = value; writes++; },
    remove: async () => { saved = null; },
  };
  const transport: SessionTransport = {
    login: async () => fixture.tokens, refresh: async () => fixture.tokens,
    profile: async () => ({ id: "1", publicId: fixture.tokens.publicId, name: "Fixture", email: "" }),
    logout: async () => {},
  };
  const session = new AuthSession(storage, transport);

  // 실행: SDK Promise가 성공으로 완료된 뒤의 수동 닫기나 같은 callback은 새 인증 결과가 아니다.
  const signingIn = session.signInExternal(fixture.login);
  await fixture.browserStarted.promise;
  fixture.browserResult.resolve({ type: "success", url: fixture.callback() });
  await signingIn;
  fixture.browserResult.resolve({ type: "dismiss" } as WebBrowserAuthSessionResult);
  fixture.browserResult.resolve({ type: "success", url: fixture.callback() });

  // 검증: 성공 상태와 저장을 유지하며 일회 code를 재전송하지 않는다.
  assert.equal(session.getSnapshot().status, "signedIn");
  assert.equal(await session.accessToken(), fixture.tokens.accessToken);
  assert.equal(writes, 1);
  assert.deepEqual(fixture.requests, ["/api/v1/auth/mobile/requests", "/api/v1/auth/mobile/exchange"]);
});

test("이전 브라우저의 늦은 수동 취소가 새로 완료한 세션을 취소 상태로 바꾸지 않는다", async () => {
  // 준비
  const fixture = loginFixture();
  let saved: string | null = null;
  const transport: SessionTransport = {
    login: async () => fixture.tokens, refresh: async () => fixture.tokens,
    profile: async () => ({ id: "1", publicId: fixture.tokens.publicId, name: "Fixture", email: "" }),
    logout: async () => {},
  };
  const session = new AuthSession({ read: async () => saved, write: async value => { saved = value; },
    remove: async () => { saved = null; } }, transport);
  const oldAttempt = assert.rejects(session.signInExternal(fixture.login), { code: "MOBILE_AUTH_CANCELLED" });
  await fixture.browserStarted.promise;

  // 실행: 별도의 새 성공 뒤 이전 브라우저가 닫혀도 새 세션의 소유권은 유지한다.
  await session.signInExternal(async () => fixture.tokens);
  const sessionKey = session.getSnapshot().sessionKey;
  fixture.browserResult.resolve({ type: "dismiss" } as WebBrowserAuthSessionResult);
  await oldAttempt;

  // 검증: 취소된 요청은 code 교환을 실행하지 않고 새 로그인·저장을 건드리지 않는다.
  assert.equal(session.getSnapshot().status, "signedIn");
  assert.equal(session.getSnapshot().sessionKey, sessionKey);
  assert.equal(await session.accessToken(), fixture.tokens.accessToken);
  assert.equal(JSON.parse(saved!).refreshToken, fixture.tokens.refreshToken);
  assert.deepEqual(fixture.requests, ["/api/v1/auth/mobile/requests"]);
});
