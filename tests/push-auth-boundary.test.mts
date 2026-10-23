import assert from "node:assert/strict";
import test from "node:test";

import { ApiError } from "../src/api/client.ts";
import { AuthSession, type SessionTransport, type TokenPair } from "../src/auth/session.ts";

function pair(user: string): TokenPair {
  return { accessToken: `${user}-synthetic-access`, refreshToken: `${user}-synthetic-refresh`, accessTokenExpiresIn: 3600, publicId: user };
}
const storage = () => ({ read: async () => null, write: async () => {}, remove: async () => {} });
function transport(logouts: string[]): SessionTransport {
  return {
    login: async email => pair(email), refresh: async () => pair("a"),
    profile: async value => ({ id: value.startsWith("a-") ? "1" : "2", publicId: value.startsWith("a-") ? "a" : "b", name: "Synthetic", email: "" }),
    logout: async value => { logouts.push(value); },
  };
}

test("로그아웃은 부가 cleanup에 현재 자격을 캡처하고 완료를 기다리는 동안 sid revoke도 진행한다", async () => {
  // 준비
  const logouts: string[] = [];
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const captured: [string, string][] = [];
  const session = new AuthSession(storage(), transport(logouts), Date.now, () => {}, async (token, key) => {
    captured.push([token, key]);
    await pending;
  });
  await session.signInExternal(async () => pair("a"));
  const oldKey = session.getSnapshot().sessionKey!;
  // 실행
  const logout = session.signOut();
  await new Promise<void>(resolve => setImmediate(resolve));
  // 검증
  assert.equal(session.getSnapshot().status, "signedOut");
  assert.deepEqual(captured, [["a-synthetic-access", oldKey]]);
  assert.deepEqual(logouts, ["a-synthetic-access"]);
  release();
  await logout;
});

test("부가 cleanup 실패는 sid 폐기를 막지 않고 새 로그인 계정에 영향을 주지 않는다", async () => {
  // 준비
  const logouts: string[] = [];
  let reject!: () => void;
  const pending = new Promise<void>((_, failure) => { reject = () => failure(new Error("OFFLINE")); });
  const session = new AuthSession(storage(), transport(logouts), Date.now, () => {}, async () => pending);
  await session.signInExternal(async () => pair("a"));
  // 실행
  const logout = session.signOut();
  await session.signInExternal(async () => pair("b"));
  reject();
  await logout;
  // 검증
  assert.equal(session.getSnapshot().user?.publicId, "b");
  assert.equal(session.getSnapshot().error, null);
  assert.deepEqual(logouts, ["a-synthetic-access"]);
});

test("계정 교체는 이전 자격만 cleanup에 넘기며 오래된 cleanup을 기다리지 않는다", async () => {
  // 준비
  const logouts: string[] = [];
  const captured: string[] = [];
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const session = new AuthSession(storage(), transport(logouts), Date.now, () => {}, async token => {
    captured.push(token); await pending;
  });
  await session.signInExternal(async () => pair("a"));
  // 실행
  await session.signInExternal(async () => pair("b"));
  // 검증
  assert.equal(session.getSnapshot().user?.publicId, "b");
  assert.deepEqual(captured, ["a-synthetic-access"]);
  assert.deepEqual(logouts, ["a-synthetic-access"]);
  finish();
});


test("계정 교체 취소도 만료된 이전 계정 refresh로 sid를 폐기한다", async () => {
  // 준비: 실제 자격 대신 만료 access와 유효 refresh를 구분하는 서버 모형을 사용한다.
  const calls: string[] = [];
  let now = 0;
  let oldSessionActive = true;
  const base = transport([]);
  const session = new AuthSession(storage(), {
    ...base,
    refresh: async value => {
      calls.push("refresh:" + value);
      assert.equal(value, "a-synthetic-refresh");
      return { ...pair("a"), accessToken: "a-renewed-access" };
    },
    logout: async value => {
      calls.push("logout:" + value);
      if (value === "a-synthetic-access") throw new ApiError(401, "HTTP_401");
      assert.equal(value, "a-renewed-access");
      oldSessionActive = false;
    },
  }, () => now, () => {}, async value => {
    calls.push("release:" + value);
    throw new ApiError(401, "HTTP_401");
  });
  await session.signInExternal(async () => ({ ...pair("a"), accessTokenExpiresIn: 1 }));
  now = 2_000;

  // 실행: B 웹 로그인이 취소돼도 캡처한 A 자격의 정리는 별도로 완료한다.
  await assert.rejects(session.signInExternal(async () => {
    throw new ApiError(0, "MOBILE_AUTH_CANCELLED");
  }), { code: "MOBILE_AUTH_CANCELLED" });
  await new Promise<void>(resolve => setImmediate(resolve));

  // 검증: 부가 등록 삭제의 401에 막히지 않고 A sid를 폐기하며 새 로그인을 만들지 않는다.
  assert.equal(oldSessionActive, false);
  assert.deepEqual(calls, ["release:a-synthetic-access", "refresh:a-synthetic-refresh", "logout:a-renewed-access"]);
  assert.equal(session.getSnapshot().status, "signedOut");
  assert.equal(await session.accessToken(), null);
});
