import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";

import { ApiError, createApiClient } from "../src/api/client.ts";
import { AuthSession, type TokenPair } from "../src/auth/session.ts";
import { createEmailAccessController } from "../src/features/auth/email-access-controller.ts";
import {
  emailAccessMessage, normalizedEmail, parseEmailChallenge, parseEmailProof,
  validBirthDate, validNewPassword, type EmailAccessMode,
} from "../src/features/auth/email-access-contracts.ts";
import { publicPolicyUrl } from "../src/features/auth/policy-links.ts";

const challenge = { challengeId: "610ba52e-7248-4b11-8010-07ac803e31ca", expiresIn: 600, resendAfterSeconds: 60 };
const proof = { verificationToken: "a".repeat(43), expiresIn: 600 };

function fixture(mode: EmailAccessMode = "register", request?: (path: string, body: unknown, signal: AbortSignal) => Promise<unknown>) {
  // 준비: 실제 메일·서버·저장소 대신 요청 경계와 시각을 관측한다.
  const calls: { path: string; body: unknown; signal: AbortSignal }[] = [];
  let time = Date.parse("2026-10-24T00:00:00Z");
  let current = true;
  const controller = createEmailAccessController({ mode, now: () => time, current: () => current, timeoutMs: 100,
    request: async (path, body, signal) => {
      calls.push({ path, body, signal });
      if (request) return request(path, body, signal);
      if (path.endsWith("/challenges")) return challenge;
      if (path.endsWith("/verify")) return proof;
      return mode === "register" ? { publicId: "SYNTHETIC-1" } : { success: true };
    },
  });
  controller.setField("email", "  TEST@example.com  ");
  const verify = async () => {
    await controller.send();
    controller.setField("code", "123456");
    await controller.verify();
  };
  const details = () => {
    controller.setField("password", "  synthetic-pass  ");
    controller.setField("confirmation", "  synthetic-pass  ");
    controller.setField("nickname", "  tester  ");
    controller.setField("birthDate", "2000-02-29");
  };
  return { controller, calls, verify, details, advance: (ms: number) => { time += ms; }, deactivate: () => { current = false; } };
}

test("email normalization preserves aliases and rejects invalid local/domain boundaries", () => {
  // 실행 및 검증
  assert.equal(normalizedEmail("  A.B+alias@Example.COM "), "a.b+alias@example.com");
  for (const invalid of [".a@example.com", "a.@example.com", "a..b@example.com", "x@-example.com", "x@example", "a".repeat(65) + "@example.com"]) {
    assert.equal(normalizedEmail(invalid), null);
  }
});

test("password limits use UTF8 bytes while preserving spaces and supplementary characters", () => {
  // 실행 및 검증
  assert.equal(validNewPassword("가".repeat(24)), true);
  assert.equal(validNewPassword("가".repeat(25)), false);
  assert.equal(validNewPassword("😀".repeat(18)), true);
  assert.equal(validNewPassword("😀".repeat(19)), false);
  assert.equal(validNewPassword("        "), false);
  assert.equal(validNewPassword("short"), false);
  assert.equal(validNewPassword("  secret  "), true);
});

test("birth date validation rejects rollover, future, year zero and accepts real leap days", () => {
  // 준비
  const now = Date.parse("2026-10-24T00:00:00Z");

  // 실행 및 검증
  for (const invalid of ["2001-02-29", "2026-13-01", "2026-04-31", "0000-01-01", "2026-10-25", "2000-2-29"]) assert.equal(validBirthDate(invalid, now), false);
  for (const valid of ["2000-02-29", "0001-01-01", "2026-10-24"]) assert.equal(validBirthDate(valid, now), true);
});

test("challenge/proof parsing bounds lifetime and rejects malformed credentials", () => {
  // 실행 및 검증
  assert.deepEqual(parseEmailChallenge(challenge), challenge);
  assert.deepEqual(parseEmailProof(proof), proof);
  for (const data of [{ ...challenge, expiresIn: 601 }, { ...challenge, challengeId: "bad" }, { ...challenge, resendAfterSeconds: -1 }]) assert.throws(() => parseEmailChallenge(data), ApiError);
  for (const data of [{ ...proof, expiresIn: 0 }, { verificationToken: "unsafe", expiresIn: 600 }, null]) assert.throws(() => parseEmailProof(data), ApiError);
});

for (const mode of ["register", "reset"] as const) {
  test(`${mode}: code and proof are purpose scoped, single use and no automatic login occurs`, async () => {
    // 준비 및 실행
    const f = fixture(mode);
    await f.verify();
    assert.equal(f.controller.getSnapshot().verified, true);
    assert.equal(JSON.stringify(f.controller.getSnapshot()).includes(proof.verificationToken), false);
    f.details();
    await f.controller.complete();
    await f.controller.complete();

    // 검증: 공개 계약만 호출하고 확인 이후 민감한 입력을 비운다.
    assert.deepEqual(f.calls.map(call => call.path), mode === "register"
      ? ["/auth/email/challenges", "/auth/email/verify", "/auth/register"]
      : ["/auth/password-reset/challenges", "/auth/password-reset/verify", "/auth/password-reset/complete"]);
    assert.deepEqual(f.calls[0].body, { email: "test@example.com" });
    assert.deepEqual(f.calls[2].body, { email: "test@example.com", password: "  synthetic-pass  ", verificationToken: proof.verificationToken,
      ...(mode === "register" ? { nickname: "tester", birthDate: "2000-02-29" } : {}) });
    assert.equal(f.controller.getSnapshot().completed, true);
    assert.equal(f.controller.getSnapshot().password, "");
    assert.equal(f.controller.getSnapshot().confirmation, "");
  });
}

test("changing email invalidates the proof and changing it back does not restore verification", async () => {
  // 준비
  const f = fixture();
  await f.verify();
  f.details();

  // 실행
  f.controller.setField("email", "other@example.com");
  f.controller.setField("email", "test@example.com");
  await f.controller.complete();

  // 검증
  assert.equal(f.controller.getSnapshot().verified, false);
  assert.equal(f.calls.length, 2);
});

test("expired proof cannot submit and resend cooldown survives address edits", async () => {
  // 준비
  const f = fixture();
  await f.verify();
  f.details();

  // 실행 및 검증
  f.advance(600000);
  await f.controller.complete();
  assert.equal(f.calls.length, 2);
  assert.equal(f.controller.getSnapshot().verified, false);
  await f.controller.send();
  f.controller.setField("email", "other@example.com");
  await f.controller.send();
  assert.equal(f.calls.length, 3);
});

test("unmatched password or invalid birthdate does not consume valid proof", async () => {
  // 준비
  const f = fixture();
  await f.verify();
  f.details();
  f.controller.setField("confirmation", "different-password");

  // 실행 및 검증
  await f.controller.complete();
  assert.equal(f.calls.length, 2);
  assert.equal(f.controller.getSnapshot().verified, true);
  f.controller.setField("confirmation", "  synthetic-pass  ");
  f.controller.setField("birthDate", "2001-02-29");
  await f.controller.complete();
  assert.equal(f.calls.length, 2);
  f.controller.setField("birthDate", "2000-02-29");
  await f.controller.complete();
  assert.equal(f.controller.getSnapshot().completed, true);
});

test("background cancels pending request, clears passwords and ignores late replies without losing cooldown", async () => {
  // 준비
  let resolve!: (value: unknown) => void;
  const f = fixture("register", () => new Promise(value => { resolve = value; }));
  f.details();
  const pending = f.controller.send();
  await f.controller.send();

  // 실행
  f.controller.suspend();
  resolve(challenge);
  await pending;

  // 검증
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].signal.aborted, true);
  assert.equal(f.controller.getSnapshot().busy, null);
  assert.equal(f.controller.getSnapshot().expiresAt, 0);
  assert.equal(f.controller.getSnapshot().password, "");
  assert.ok(f.controller.getSnapshot().cooldownUntil > 0);
});

test("switching account while response is pending cannot update old screen", async () => {
  // 준비
  let resolve!: (value: unknown) => void;
  const f = fixture("register", () => new Promise(value => { resolve = value; }));
  const pending = f.controller.send();

  // 실행
  f.deactivate();
  f.controller.suspend(true);
  resolve(challenge);
  await pending;

  // 검증
  assert.equal(f.controller.getSnapshot().expiresAt, 0);
  await f.controller.send();
  assert.equal(f.calls.length, 1);
});

for (const mode of ["register", "reset"] as const) {
  for (const phase of ["challenge", "proof"] as const) {
    for (const transition of ["external-start", "external-failure", "sign-in-then-out"] as const) {
      test(`${mode}: late ${phase} ignores actual AuthSession ${transition} without screen cleanup`, async () => {
        // 준비: 실제 AuthSession의 세대를 사용하며 React cleanup이나 수동 suspend를 호출하지 않는다.
        const pair: TokenPair = { accessToken: "synthetic-access", refreshToken: "synthetic-refresh",
          accessTokenExpiresIn: 3600, publicId: "BOUNDARY-USER" };
        const session = new AuthSession({ read: async () => null, write: async () => {}, remove: async () => {} }, {
          login: async () => pair,
          refresh: async () => pair,
          profile: async () => ({ id: "1", publicId: pair.publicId, name: "synthetic", email: "" }),
          logout: async () => {},
        });
        await session.restore();
        const boundary = session.getSnapshot().boundaryGeneration;
        assert.equal(session.getSnapshot().sessionKey, null);
        assert.equal(session.isCurrentSignedOutBoundary(boundary), true);
        let time = Date.parse("2026-10-24T00:00:00Z");
        let resolveReply!: (value: unknown) => void;
        const lateReply = new Promise<unknown>(resolve => { resolveReply = resolve; });
        const calls: string[] = [];
        const controller = createEmailAccessController({ mode, now: () => time, timeoutMs: 5000,
          current: () => session.isCurrentSignedOutBoundary(boundary),
          request: async path => {
            calls.push(path);
            if (path.endsWith("/challenges")) return phase === "challenge" ? lateReply : challenge;
            return lateReply;
          },
        });
        controller.setField("email", "synthetic@example.invalid");
        let pending: Promise<void>;
        if (phase === "challenge") pending = controller.send();
        else {
          await controller.send();
          controller.setField("code", "123456");
          pending = controller.verify();
        }
        const beforeBoundary = controller.getSnapshot();
        let notifications = 0;
        controller.subscribe(() => { notifications++; });
        let failedLogin: Promise<unknown> | null = null;
        let rejectLogin!: (reason: unknown) => void;

        // 실행: null 세션 키가 같아도 로그인 시작 즉시 실제 소유 세대는 달라진다.
        if (transition === "sign-in-then-out") {
          await session.signIn("synthetic@example.invalid", "synthetic-password");
          await session.signOut();
        } else {
          const loginReply = new Promise<TokenPair>((_, reject) => { rejectLogin = reject; });
          failedLogin = session.signInExternal(() => loginReply).catch(error => error);
          assert.equal(session.isCurrentSignedOutBoundary(boundary), false);
          await setImmediate();
          if (transition === "external-failure") {
            rejectLogin(new ApiError(0, "SYNTHETIC_LOGIN_CANCELLED"));
            await failedLogin;
          }
        }
        assert.equal(session.getSnapshot().status, "signedOut");
        assert.equal(session.getSnapshot().sessionKey, null);
        assert.notEqual(session.getSnapshot().boundaryGeneration, boundary);
        resolveReply(phase === "challenge" ? challenge : proof);
        await pending;
        time += 600001;
        controller.tick();
        await controller.complete();

        // 검증: 늦은 응답과 finally·만료 tick이 이전 화면을 갱신하거나 후속 쓰기를 보내지 않는다.
        assert.equal(session.isCurrentSignedOutBoundary(boundary), false);
        assert.strictEqual(controller.getSnapshot(), beforeBoundary);
        assert.equal(notifications, 0);
        assert.equal(controller.getSnapshot().verified, false);
        assert.equal(calls.length, phase === "challenge" ? 1 : 2);
        if (transition === "external-start") {
          rejectLogin(new ApiError(0, "SYNTHETIC_LOGIN_CANCELLED"));
          await failedLogin;
        }

        // 검증: 새 세대를 캡처한 정상 화면은 요청할 수 있다. 이전 세대를 다시 살려 허용하지 않는다.
        const nextBoundary = session.getSnapshot().boundaryGeneration;
        const next = createEmailAccessController({ mode, now: () => time,
          current: () => session.isCurrentSignedOutBoundary(nextBoundary), request: async () => challenge });
        next.setField("email", "next@example.invalid");
        await next.send();
        assert.ok(next.getSnapshot().expiresAt > time);
        assert.equal(session.isCurrentSignedOutBoundary(boundary), false);
      });
    }
  }
}

test("uncertain completion never retries a consumed proof or reports success", async () => {
  // 준비
  const f = fixture("reset", async path => path.endsWith("/challenges") ? challenge : path.endsWith("/verify") ? proof : Promise.reject(new ApiError(0, "NETWORK_UNAVAILABLE")));
  await f.verify();
  f.details();

  // 실행
  await f.controller.complete();
  await f.controller.complete();

  // 검증
  assert.equal(f.calls.length, 3);
  assert.equal(f.controller.getSnapshot().completed, false);
  assert.equal(f.controller.getSnapshot().verified, false);
  assert.equal(f.controller.getSnapshot().password, "");
});

test("timeout releases busy even when transport ignores AbortSignal", async () => {
  // 준비
  const f = fixture("reset", async () => new Promise(() => {}));

  // 실행
  await f.controller.send();

  // 검증
  assert.equal(f.calls[0].signal.aborted, true);
  assert.equal(f.controller.getSnapshot().busy, null);
  assert.ok(f.controller.getSnapshot().error);
});

test("background after verification keeps email challenge but blur clears proof", async () => {
  // 준비
  const f = fixture();
  await f.verify();
  f.details();

  // 실행 및 검증
  f.controller.suspend();
  assert.equal(f.controller.getSnapshot().verified, true);
  assert.equal(f.controller.getSnapshot().password, "");
  f.controller.suspend(true);
  f.details();
  await f.controller.complete();
  assert.equal(f.calls.length, 2);
});

test("API helper sends anonymous auth requests without credentials and only reflects allowlisted errors", async () => {
  // 준비
  const api = createApiClient({ baseUrl: "https://api.example.invalid/api/v1", accessToken: async () => { throw new Error("must not request bearer"); },
    fetcher: async (_url, init) => {
      assert.equal(new Headers(init?.headers).has("Authorization"), false);
      return new Response(JSON.stringify({ body: { errorCode: "AUTH_EMAIL_RESEND_TOO_SOON", retryAfterSeconds: 120, message: "private synthetic data" } }), { status: 429 });
    },
  });

  // 실행 및 검증
  await assert.rejects(api.request("/auth/password-reset/challenges", { authenticated: false, method: "POST", body: { email: "test@example.com" } }), failure => {
    assert.ok(failure instanceof ApiError);
    assert.equal(failure.serverCode, "AUTH_EMAIL_RESEND_TOO_SOON");
    assert.equal(failure.retryAfterSeconds, 120);
    assert.equal(emailAccessMessage(failure).includes("private"), false);
    return true;
  });
});

test("server retry window is preserved and unknown response cannot complete registration", async () => {
  // 준비
  const limited = fixture("register", async () => { throw new ApiError(429, "HTTP_ERROR", "AUTH_EMAIL_DAILY_LIMIT", 3600); });
  await limited.controller.send();

  // 실행 및 검증
  limited.advance(60000);
  await limited.controller.send();
  assert.equal(limited.calls.length, 1);
  const malformed = fixture("register", async path => path.endsWith("/challenges") ? challenge : path.endsWith("/verify") ? proof : { success: true });
  await malformed.verify();
  malformed.details();
  await malformed.controller.complete();
  assert.equal(malformed.controller.getSnapshot().completed, false);
});

test("legal links only allow explicit HTTPS documents and do not invent unavailable addresses", () => {
  // 실행 및 검증
  for (const invalid of [null, "", "http://example.com/privacy", "javascript:alert(1)", "https://secret:password@example.com/terms"]) assert.equal(publicPolicyUrl(invalid), null);
  assert.equal(publicPolicyUrl("https://example.com/legal/privacy"), "https://example.com/legal/privacy");
});
