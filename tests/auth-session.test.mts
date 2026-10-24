import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";

import { ApiError } from "../src/api/client.ts";
import {
  AuthSession, type SessionStorage, type SessionTransport, type TokenPair,
} from "../src/auth/session.ts";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, deny) => { resolve = accept; reject = deny; });
  return { promise, resolve, reject };
}

function pair(publicId = "alice", revision = "initial", expiresIn = 3600): TokenPair {
  return {
    accessToken: publicId + ":access:" + revision,
    refreshToken: publicId + ":refresh:" + revision,
    accessTokenExpiresIn: expiresIn,
    publicId,
  };
}

function saved(publicId = "alice", revision = "initial") {
  const credentials = pair(publicId, revision);
  return JSON.stringify({ refreshToken: credentials.refreshToken, publicId });
}

function memoryStorage(initial: string | null = null) {
  let value = initial;
  const writes: string[] = [];
  const storage: SessionStorage = {
    read: async () => value,
    write: async next => { writes.push(next); value = next; },
    remove: async () => { value = null; },
  };
  return { storage, value: () => value, writes };
}

function transport(overrides: Partial<SessionTransport> = {}): SessionTransport {
  return {
    login: async email => pair(email.startsWith("bob") ? "bob" : "alice"),
    refresh: async refreshToken => pair(refreshToken.split(":")[0], "renewed"),
    profile: async accessToken => {
      const publicId = accessToken.split(":")[0];
      return { id: publicId === "alice" ? "1" : "2", publicId, name: publicId, email: "" };
    },
    logout: async () => {},
    ...overrides,
  };
}

test("로그인은 refresh만 저장하고 세션 경계 정리를 구독 알림보다 먼저 수행한다", async () => {
  // 준비: 토큰은 실제 자격이 아닌 테스트 식별자다.
  const memory = memoryStorage();
  const events: string[] = [];
  let submitted: string[] = [];
  const session = new AuthSession(memory.storage, transport({
    login: async (email, password) => { submitted = [email, password]; return pair(); },
  }), Date.now, () => { events.push("boundary"); });
  session.subscribe(() => { events.push(session.getSnapshot().status); });

  // 실행
  await session.signIn(" alice@example.test ", " password with spaces ");

  // 검증: 화면 상태에 토큰을 공개하지 않고 비밀번호 입력을 변형하지 않는다.
  assert.deepEqual(submitted, ["alice@example.test", " password with spaces "]);
  assert.deepEqual(JSON.parse(memory.value()!), { refreshToken: "alice:refresh:initial", publicId: "alice" });
  assert.equal(session.getSnapshot().status, "signedIn");
  assert.equal(session.getSnapshot().user?.email, "alice@example.test");
  assert.equal(JSON.stringify(session.getSnapshot()).includes("alice:access:"), false);
  assert.equal(JSON.stringify(session.getSnapshot()).includes("alice:refresh:"), false);
  assert.deepEqual(events.slice(-2), ["boundary", "signedIn"]);
});

test("동시에 만료가 임박한 access를 요청해도 refresh와 저장은 한 번만 실행한다", async () => {
  // 준비
  const memory = memoryStorage();
  const started = deferred<void>();
  const result = deferred<TokenPair>();
  let refreshCalls = 0;
  let now = 0;
  const session = new AuthSession(memory.storage, transport({
    refresh: async () => { refreshCalls++; started.resolve(); return result.promise; },
  }), () => now);
  await session.signIn("alice@example.test", "password");
  const sessionKey = session.getSnapshot().sessionKey;
  now = 3_590_000;

  // 실행: 모든 호출을 같은 미완료 refresh에 겹친다.
  const requests = Array.from({ length: 6 }, () => session.accessToken());
  await started.promise;
  assert.equal(refreshCalls, 1);
  result.resolve(pair("alice", "renewed"));
  const tokens = await Promise.all(requests);

  // 검증
  assert.deepEqual(tokens, Array.from({ length: 6 }, () => "alice:access:renewed"));
  assert.equal(refreshCalls, 1);
  assert.equal(memory.writes.length, 2);
  assert.equal(memory.value(), saved("alice", "renewed"));
  assert.equal(session.getSnapshot().sessionKey, sessionKey);
});

for (const outcome of ["success", "denied"] as const) {
  test("새 계정 로그인 뒤 이전 refresh의 늦은 " + outcome + "는 새 계정과 저장을 바꾸지 않는다", async () => {
    // 준비
    const memory = memoryStorage();
    const started = deferred<void>();
    const result = deferred<TokenPair>();
    let now = 0;
    const session = new AuthSession(memory.storage, transport({
      refresh: async () => { started.resolve(); return result.promise; },
    }), () => now);
    await session.signIn("alice@example.test", "password");
    now = 3_590_000;

    // 실행: 이전 호출의 거절 검사를 먼저 연결하여 늦은 거절도 유실하지 않는다.
    const oldRequest = assert.rejects(session.accessToken(), {
      code: outcome === "success" ? "SESSION_CHANGED" : "HTTP_401",
    });
    await started.promise;
    await session.signIn("bob@example.test", "password");
    const sessionKey = session.getSnapshot().sessionKey;
    if (outcome === "success") result.resolve(pair("alice", "late"));
    else result.reject(new ApiError(401, "HTTP_401"));
    await oldRequest;

    // 검증
    assert.equal(session.getSnapshot().status, "signedIn");
    assert.equal(session.getSnapshot().user?.publicId, "bob");
    assert.equal(session.getSnapshot().sessionKey, sessionKey);
    assert.equal(await session.accessToken(), "bob:access:initial");
    assert.equal(memory.value(), saved("bob"));
  });
}

test("로그아웃 뒤 늦은 refresh 성공이 계정이나 기기 저장소를 되살리지 않는다", async () => {
  // 준비
  const memory = memoryStorage();
  const started = deferred<void>();
  const result = deferred<TokenPair>();
  const loggedOut: string[] = [];
  let now = 0;
  let refreshCalls = 0;
  const session = new AuthSession(memory.storage, transport({
    refresh: async () => {
      if (++refreshCalls === 1) { started.resolve(); return result.promise; }
      return pair("alice", "for-logout");
    },
    logout: async token => { loggedOut.push(token); },
  }), () => now);
  await session.signIn("alice@example.test", "password");
  now = 3_590_000;

  // 실행
  const oldRequest = assert.rejects(session.accessToken(), { code: "SESSION_CHANGED" });
  await started.promise;
  await session.signOut();
  result.resolve(pair("alice", "late"));
  await oldRequest;

  // 검증
  assert.equal(session.getSnapshot().status, "signedOut");
  assert.equal(await session.accessToken(), null);
  assert.equal(memory.value(), null);
  assert.deepEqual(loggedOut, ["alice:access:for-logout"]);
});

test("이전 로그인 응답이 늦게 도착하면 그 응답의 서버 세션만 폐기한다", async () => {
  // 준비
  const memory = memoryStorage();
  const started = deferred<void>();
  const result = deferred<TokenPair>();
  const loggedOut: string[] = [];
  const session = new AuthSession(memory.storage, transport({
    login: async email => {
      if (email.startsWith("alice")) { started.resolve(); return result.promise; }
      return pair("bob");
    },
    logout: async token => { loggedOut.push(token); },
  }));

  // 실행
  const first = assert.rejects(session.signIn("alice@example.test", "password"), { code: "SESSION_CHANGED" });
  await started.promise;
  await session.signIn("bob@example.test", "password");
  result.resolve(pair("alice", "late-login"));
  await first;

  // 검증
  assert.equal(session.getSnapshot().user?.publicId, "bob");
  assert.equal(memory.value(), saved("bob"));
  assert.deepEqual(loggedOut, ["alice:access:late-login"]);
});

test("저장소 쓰기 중 로그아웃하면 늦은 쓰기 뒤 삭제가 실행되어 최종 자격이 남지 않는다", async () => {
  // 준비
  const memory = memoryStorage();
  const writing = deferred<void>();
  const allowWrite = deferred<void>();
  const storage: SessionStorage = {
    ...memory.storage,
    write: async value => { writing.resolve(); await allowWrite.promise; await memory.storage.write(value); },
  };
  const loggedOut: string[] = [];
  const session = new AuthSession(storage, transport({ logout: async token => { loggedOut.push(token); } }));

  // 실행: 저장이 끝나기 전에 화면 인증부터 해제한다.
  const login = assert.rejects(session.signIn("alice@example.test", "password"), { code: "SESSION_CHANGED" });
  await writing.promise;
  const logout = session.signOut();
  assert.equal(session.getSnapshot().status, "signedOut");
  allowWrite.resolve();
  await Promise.all([login, logout]);

  // 검증
  assert.equal(memory.value(), null);
  assert.equal(await session.accessToken(), null);
  assert.deepEqual(loggedOut, ["alice:access:initial"]);
});

for (const status of [401, 403]) {
  test("복원 refresh의 " + status + " 인증 거절은 저장된 자격을 지우고 복원 재시도를 끈다", async () => {
    // 준비
    const memory = memoryStorage(saved());
    const session = new AuthSession(memory.storage, transport({
      refresh: async () => { throw new ApiError(status, "HTTP_" + status); },
    }));

    // 실행
    await session.restore();

    // 검증
    assert.equal(memory.value(), null);
    assert.deepEqual(session.getSnapshot(), {
      status: "signedOut", user: null, sessionKey: null, boundaryGeneration: 1, error: "SESSION_EXPIRED", canRetryRestore: false,
    });
  });
}

for (const failure of ["network", "server", "storage-read"] as const) {
  test("복원의 일시적 " + failure + " 실패는 저장된 refresh를 보존하고 재시도를 허용한다", async () => {
    // 준비
    const memory = memoryStorage(saved());
    const storage = failure === "storage-read"
      ? { ...memory.storage, read: async () => { throw new Error("synthetic storage error"); } }
      : memory.storage;
    const session = new AuthSession(storage, transport({
      refresh: async () => { throw new ApiError(failure === "server" ? 503 : 0, "TEMPORARILY_UNAVAILABLE"); },
    }));

    // 실행
    await session.restore();

    // 검증
    assert.equal(memory.value(), saved());
    assert.equal(session.getSnapshot().status, "signedOut");
    assert.equal(session.getSnapshot().error, "SESSION_RESTORE_UNAVAILABLE");
    assert.equal(session.getSnapshot().canRetryRestore, true);
    assert.equal(await session.accessToken(), null);
  });
}

test("손상된 저장 JSON은 서버 호출 전에 삭제한다", async () => {
  // 준비
  const memory = memoryStorage("{invalid-json");
  let refreshCalls = 0;
  const session = new AuthSession(memory.storage, transport({
    refresh: async () => { refreshCalls++; return pair(); },
  }));

  // 실행
  await session.restore();

  // 검증
  assert.equal(refreshCalls, 0);
  assert.equal(memory.value(), null);
  assert.equal(session.getSnapshot().error, "SAVED_SESSION_INVALID");
});

test("로그인 응답과 현재 사용자 신원이 다르면 저장하지 않고 새 서버 세션을 폐기한다", async () => {
  // 준비
  const memory = memoryStorage();
  const loggedOut: string[] = [];
  const session = new AuthSession(memory.storage, transport({
    profile: async () => ({ id: "2", publicId: "bob", name: "bob", email: "" }),
    logout: async token => { loggedOut.push(token); },
  }));

  // 실행 및 검증
  await assert.rejects(session.signIn("alice@example.test", "password"), { code: "INVALID_AUTH_RESPONSE" });
  assert.equal(memory.writes.length, 0);
  assert.equal(memory.value(), null);
  assert.equal(session.getSnapshot().status, "signedOut");
  assert.deepEqual(loggedOut, ["alice:access:initial"]);
});

test("비정상 token DTO는 현재 사용자 조회나 자격 저장에 사용하지 않는다", async () => {
  // 준비
  const memory = memoryStorage();
  let profileCalls = 0;
  const session = new AuthSession(memory.storage, transport({
    login: async () => ({ ...pair(), accessTokenExpiresIn: Number.NaN }),
    profile: async () => { profileCalls++; throw new Error("호출되면 안 됨"); },
  }));

  // 실행 및 검증
  await assert.rejects(session.signIn("alice@example.test", "password"), { code: "INVALID_AUTH_RESPONSE" });
  assert.equal(profileCalls, 0);
  assert.equal(memory.value(), null);
  assert.equal(session.getSnapshot().status, "signedOut");
});

test("로그인 자격 저장이 실패하면 signedIn을 공개하지 않고 새 서버 세션을 폐기한다", async () => {
  // 준비
  const memory = memoryStorage();
  const loggedOut: string[] = [];
  const session = new AuthSession({
    ...memory.storage, write: async () => { throw new Error("synthetic write failure"); },
  }, transport({ logout: async token => { loggedOut.push(token); } }));

  // 실행 및 검증
  await assert.rejects(session.signIn("alice@example.test", "password"));
  assert.equal(session.getSnapshot().status, "signedOut");
  assert.equal(await session.accessToken(), null);
  assert.equal(memory.value(), null);
  assert.deepEqual(loggedOut, ["alice:access:initial"]);
});

for (const failure of ["storage", "remote", "both"] as const) {
  test("로그아웃 " + failure + " 실패를 표시하고 다음 시도에서 남은 정리를 완료한다", async () => {
    // 준비
    const memory = memoryStorage();
    let failing = false;
    let remoteCalls = 0;
    const session = new AuthSession({
      ...memory.storage,
      remove: async () => {
        if (failing && failure !== "remote") throw new Error("synthetic remove failure");
        await memory.storage.remove();
      },
    }, transport({
      logout: async () => {
        remoteCalls++;
        if (failing && failure !== "storage") throw new ApiError(0, "NETWORK_UNAVAILABLE");
      },
    }));
    await session.signIn("alice@example.test", "password");
    failing = true;

    // 실행 및 검증: 원격 결과를 기다리는 중에도 access는 즉시 사용할 수 없다.
    const first = session.signOut();
    assert.equal(session.getSnapshot().status, "signedOut");
    assert.equal(await session.accessToken(), null);
    await first;
    assert.equal(session.getSnapshot().error, "SIGN_OUT_INCOMPLETE");
    assert.equal(memory.value(), failure === "remote" ? null : saved());

    // 실행 및 검증: 메모리에 보관한 이전 자격으로 재시도한다.
    failing = false;
    await session.signOut();
    assert.equal(memory.value(), null);
    assert.equal(session.getSnapshot().error, null);
    assert.equal(remoteCalls, failure === "storage" ? 1 : 2);
  });
}

test("이미 서버 logout이 성공했다면 로컬 삭제 재시도의 401은 완료를 막지 않는다", async () => {
  // 준비: 첫 시도에서는 서버만 폐기되고 기기 삭제가 실패한다.
  const memory = memoryStorage();
  let failRemove = false;
  let revoked = false;
  const session = new AuthSession({
    ...memory.storage,
    remove: async () => {
      if (failRemove) throw new Error("synthetic remove failure");
      await memory.storage.remove();
    },
  }, transport({
    logout: async () => {
      if (revoked) throw new ApiError(401, "HTTP_401");
      revoked = true;
    },
  }));
  await session.signIn("alice@example.test", "password");
  failRemove = true;
  await session.signOut();
  assert.equal(session.getSnapshot().error, "SIGN_OUT_INCOMPLETE");

  // 실행
  failRemove = false;
  await session.signOut();

  // 검증
  assert.equal(memory.value(), null);
  assert.equal(session.getSnapshot().status, "signedOut");
  assert.equal(session.getSnapshot().error, null);
});

test("만료된 access의 logout은 캡처한 refresh로 새 access를 얻고 같은 계정을 폐기한다", async () => {
  // 준비
  const memory = memoryStorage();
  const calls: string[] = [];
  let now = 0;
  const session = new AuthSession(memory.storage, transport({
    refresh: async refreshToken => { calls.push("refresh:" + refreshToken); return pair("alice", "for-logout"); },
    logout: async accessToken => { calls.push("logout:" + accessToken); },
  }), () => now);
  await session.signIn("alice@example.test", "password");
  now = 3_700_000;

  // 실행
  await session.signOut();

  // 검증
  assert.deepEqual(calls, ["refresh:alice:refresh:initial", "logout:alice:access:for-logout"]);
  assert.equal(memory.value(), null);
  assert.equal(session.getSnapshot().error, null);
});

test("refresh 중의 401과 갱신 이전 access의 늦은 401은 최신 세션을 폐기하지 않는다", async () => {
  // 준비
  const memory = memoryStorage();
  const started = deferred<void>();
  const result = deferred<TokenPair>();
  let now = 0;
  const session = new AuthSession(memory.storage, transport({
    refresh: async () => { started.resolve(); return result.promise; },
  }), () => now);
  await session.signIn("alice@example.test", "password");
  now = 3_590_000;

  // 실행 및 검증: 같은 토큰이라도 진행 중인 갱신 결과를 먼저 기다린다.
  const tokenRequest = session.accessToken();
  await started.promise;
  session.rejectCurrent("alice:access:initial");
  assert.equal(session.getSnapshot().status, "signedIn");
  result.resolve(pair("alice", "renewed"));
  assert.equal(await tokenRequest, "alice:access:renewed");
  session.rejectCurrent("alice:access:initial");
  assert.equal(session.getSnapshot().status, "signedIn");
  assert.equal(memory.value(), saved("alice", "renewed"));

  // 실행 및 검증: 실제 현재 토큰의 거절만 인증과 저장소를 정리한다.
  session.rejectCurrent("alice:access:renewed");
  assert.equal(session.getSnapshot().error, "SESSION_EXPIRED");
  assert.equal(await session.accessToken(), null);
  await setImmediate();
  assert.equal(memory.value(), null);
});

test("일시적인 refresh 실패는 기존 세션을 유지하고 다음 호출에서 다시 갱신한다", async () => {
  // 준비
  const memory = memoryStorage();
  let now = 0;
  let refreshCalls = 0;
  const session = new AuthSession(memory.storage, transport({
    refresh: async () => {
      if (++refreshCalls === 1) throw new ApiError(0, "NETWORK_UNAVAILABLE");
      return pair("alice", "renewed");
    },
  }), () => now);
  await session.signIn("alice@example.test", "password");
  now = 3_590_000;

  // 실행 및 검증
  await assert.rejects(session.accessToken(), { code: "NETWORK_UNAVAILABLE" });
  assert.equal(session.getSnapshot().status, "signedIn");
  assert.equal(memory.value(), saved());
  assert.equal(await session.accessToken(), "alice:access:renewed");
  assert.equal(refreshCalls, 2);
  assert.equal(memory.value(), saved("alice", "renewed"));
});

test("기기 refresh 복원은 서버 사용자 신원을 확인하고 access를 저장하지 않는다", async () => {
  // 준비
  const memory = memoryStorage(saved());
  const calls: string[] = [];
  const base = transport();
  const session = new AuthSession(memory.storage, transport({
    refresh: async token => { calls.push("refresh:" + token); return pair("alice", "restored"); },
    profile: async token => { calls.push("profile:" + token); return base.profile(token); },
  }));

  // 실행
  await session.restore();

  // 검증
  assert.deepEqual(calls, ["refresh:alice:refresh:initial", "profile:alice:access:restored"]);
  assert.equal(session.getSnapshot().status, "signedIn");
  assert.equal(session.getSnapshot().user?.publicId, "alice");
  assert.equal(await session.accessToken(), "alice:access:restored");
  assert.equal(memory.value(), saved("alice", "restored"));
});

for (const status of [401, 403]) {
  test("현재 세션 refresh의 " + status + "는 인증과 저장소를 폐기한다", async () => {
    // 준비
    const memory = memoryStorage();
    let now = 0;
    const session = new AuthSession(memory.storage, transport({
      refresh: async () => { throw new ApiError(status, "HTTP_" + status); },
    }), () => now);
    await session.signIn("alice@example.test", "password");
    now = 3_590_000;

    // 실행 및 검증
    await assert.rejects(session.accessToken(), { status, code: "HTTP_" + status });
    assert.equal(session.getSnapshot().status, "signedOut");
    assert.equal(session.getSnapshot().error, "SESSION_EXPIRED");
    assert.equal(memory.value(), null);
    assert.equal(await session.accessToken(), null);
  });
}

test("refresh 결과 저장에 실패하면 새 access를 반환하지 않고 저장소 재시도 오류를 구분한다", async () => {
  // 준비
  const memory = memoryStorage();
  let failWrite = false;
  let now = 0;
  const session = new AuthSession({
    ...memory.storage,
    write: async value => {
      if (failWrite) throw new Error("synthetic storage write detail");
      await memory.storage.write(value);
    },
  }, transport(), () => now);
  await session.signIn("alice@example.test", "password");
  failWrite = true;
  now = 3_590_000;

  // 실행 및 검증: 서버 성공과 기기 저장 성공을 혼동하지 않는다.
  await assert.rejects(session.accessToken(), { code: "SESSION_REFRESH_UNAVAILABLE", message: "SESSION_REFRESH_UNAVAILABLE" });
  assert.equal(session.getSnapshot().status, "signedIn");
  assert.equal(memory.value(), saved());

  // 실행 및 검증: 저장소가 회복되면 기존 refresh로 다시 갱신할 수 있다.
  failWrite = false;
  assert.equal(await session.accessToken(), "alice:access:renewed");
  assert.equal(memory.value(), saved("alice", "renewed"));
});


test("겹친 로그아웃은 만료 자격 refresh와 sid 폐기를 한 번만 실행한다", async () => {
  // 준비: 부가 정리와 서버 refresh가 겹치는 같은 캡처 자격을 만든다.
  const memory = memoryStorage();
  const refreshed = deferred<TokenPair>();
  const logouts: string[] = [];
  let now = 0;
  let refreshes = 0;
  let releases = 0;
  const session = new AuthSession(memory.storage, transport({
    refresh: async () => { refreshes++; return refreshed.promise; },
    logout: async token => { logouts.push(token); },
  }), () => now, () => {}, async () => { releases++; });
  await session.signIn("alice@example.test", "password");
  now = 3_700_000;

  // 실행: 첫 정리를 끝내기 전에 같은 로그아웃을 다시 요청한다.
  const first = session.signOut();
  const second = session.signOut();
  assert.equal(refreshes, 1);
  refreshed.resolve(pair("alice", "one-cleanup"));
  await Promise.all([first, second]);

  // 검증: UI 자격은 즉시 없애고 같은 sid의 원격 요청은 공유한다.
  assert.equal(releases, 1);
  assert.deepEqual(logouts, ["alice:access:one-cleanup"]);
  assert.equal(memory.value(), null);
  assert.equal(session.getSnapshot().error, null);
});

test("계정 교체 취소의 일시적 sid 폐기 실패는 메모리에서 재시도한다", async () => {
  // 준비: 저장소에 별도 refresh 복사본을 만들지 않는 오프라인 정리 실패다.
  const memory = memoryStorage();
  let now = 0;
  let offline = true;
  let refreshes = 0;
  const logouts: string[] = [];
  const session = new AuthSession(memory.storage, transport({
    refresh: async token => {
      refreshes++;
      assert.equal(token, "alice:refresh:initial");
      if (offline) throw new ApiError(0, "NETWORK_UNAVAILABLE");
      return pair("alice", "cleanup-retry");
    },
    logout: async token => { logouts.push(token); },
  }), () => now);
  await session.signIn("alice@example.test", "password");
  now = 3_700_000;

  // 실행: B 로그인 취소와 A 정리 실패를 각각 끝낸 뒤 사용자가 로그아웃을 재시도한다.
  await assert.rejects(session.signInExternal(async () => { throw new ApiError(0, "MOBILE_AUTH_CANCELLED"); }), { code: "MOBILE_AUTH_CANCELLED" });
  await setImmediate();
  assert.equal(session.getSnapshot().error, "SIGN_OUT_INCOMPLETE");
  assert.equal(memory.value(), null);
  offline = false;
  await session.signOut();

  // 검증: 재시도는 A 자격만 사용하고 B 세션을 새로 만들거나 취소하지 않는다.
  assert.equal(refreshes, 2);
  assert.deepEqual(logouts, ["alice:access:cleanup-retry"]);
  assert.equal(session.getSnapshot().status, "signedOut");
  assert.equal(session.getSnapshot().error, null);
  assert.equal(memory.value(), null);
});

test("rejectCurrent의 늦은 캡처 정리는 새 계정과 저장소를 취소하지 않는다", async () => {
  // 준비: A logout의 401 뒤 같은 A refresh가 늦게 도착하게 한다.
  const memory = memoryStorage();
  const started = deferred<void>();
  const refreshed = deferred<TokenPair>();
  const logouts: string[] = [];
  const releases: string[] = [];
  const session = new AuthSession(memory.storage, transport({
    refresh: async token => {
      assert.equal(token, "alice:refresh:initial");
      started.resolve();
      return refreshed.promise;
    },
    logout: async token => {
      logouts.push(token);
      if (token === "alice:access:initial") throw new ApiError(401, "HTTP_401");
    },
  }), Date.now, () => {}, async token => { releases.push(token); });
  await session.signIn("alice@example.test", "password");

  // 실행: 보호 요청의 확정401은 즉시 로컬 해제하고 B 로그인은 A cleanup을 기다리지 않는다.
  session.rejectCurrent("alice:access:initial");
  assert.equal(session.getSnapshot().error, "SESSION_EXPIRED");
  await started.promise;
  await session.signIn("bob@example.test", "password");
  const bobKey = session.getSnapshot().sessionKey;
  refreshed.resolve(pair("alice", "rejected-cleanup"));
  await setImmediate();
  session.rejectCurrent("alice:access:initial");

  // 검증: release와 revoke는 A만 받고 늦은 결과·401은 B를 건드리지 않는다.
  assert.deepEqual(releases, ["alice:access:initial"]);
  assert.deepEqual(logouts, ["alice:access:initial", "alice:access:rejected-cleanup"]);
  assert.equal(session.getSnapshot().user?.publicId, "bob");
  assert.equal(session.getSnapshot().sessionKey, bobKey);
  assert.equal(session.getSnapshot().error, null);
  assert.equal(memory.value(), saved("bob"));
});

test("이전 계정 정리 실패는 새 로그인 뒤에도 보존하되 새 계정을 자동 폐기하지 않는다", async () => {
  // 준비: A 서버 정리가 늦게 실패하는 동안 B 로그인은 이미 완료된다.
  const memory = memoryStorage();
  const started = deferred<void>();
  const failed = deferred<TokenPair>();
  let now = 0;
  let attempts = 0;
  const logouts: string[] = [];
  const session = new AuthSession(memory.storage, transport({
    refresh: async token => {
      assert.equal(token, "alice:refresh:initial");
      if (++attempts === 1) { started.resolve(); return failed.promise; }
      return pair("alice", "pending-cleanup");
    },
    logout: async token => { logouts.push(token); },
  }), () => now);
  await session.signIn("alice@example.test", "password");
  now = 3_700_000;
  const switching = session.signIn("bob@example.test", "password");
  await started.promise;
  await switching;

  // 실행: 늦은 A 실패는 B의 상태에 반사하지 않고 이후 명시적 로그아웃에서만 재시도한다.
  failed.reject(new ApiError(0, "NETWORK_UNAVAILABLE"));
  await setImmediate();
  assert.equal(session.getSnapshot().user?.publicId, "bob");
  assert.equal(session.getSnapshot().error, null);
  assert.equal(memory.value(), saved("bob"));
  assert.deepEqual(logouts, []);
  await session.signOut();

  // 검증: 보관된 A와 사용자가 명시적으로 종료한 B를 각각 정확히 한 번 폐기한다.
  assert.equal(attempts, 2);
  assert.deepEqual(logouts.sort(), ["alice:access:pending-cleanup", "bob:access:initial"]);
  assert.equal(memory.value(), null);
  assert.equal(session.getSnapshot().error, null);
});

test("이전 계정 cleanup refresh의 다른 신원은 새 계정 logout에 사용하지 않는다", async () => {
  // 준비: 캡처한 A refresh의 잘못된 응답이 현재 B와 같은 신원을 가리킨다.
  const memory = memoryStorage();
  const logouts: string[] = [];
  let now = 0;
  const session = new AuthSession(memory.storage, transport({
    refresh: async () => pair("bob", "wrong-for-alice"),
    logout: async token => { logouts.push(token); },
  }), () => now);
  await session.signIn("alice@example.test", "password");
  now = 3_700_000;

  // 실행
  await session.signIn("bob@example.test", "password");
  await setImmediate();

  // 검증: 잘못된 pair는 폐기에 사용하지 않고 이미 성공한 B는 그대로 보존한다.
  assert.deepEqual(logouts, []);
  assert.equal(session.getSnapshot().user?.publicId, "bob");
  assert.equal(session.getSnapshot().error, null);
  assert.equal(memory.value(), saved("bob"));
});


for (const retryAccessDenied of [false, true]) {
  test("cleanup은 갱신 pair를 보관해 logout 재시도" + (retryAccessDenied ? "의401도 최신 refresh로 확인한다" : "에 최신 access를 쓴다"), async () => {
    // 준비: 현재 BE는 refresh를 재사용하지만 교체하는 transport에서도 관찰한 새 자격을 보존한다.
    const memory = memoryStorage();
    const refreshes: string[] = [];
    const logouts: string[] = [];
    let now = 0;
    let oldSessionActive = true;
    const session = new AuthSession(memory.storage, transport({
      refresh: async token => {
        refreshes.push(token);
        if (token === "alice:refresh:initial" && refreshes.length === 1) return pair("alice", "rotated-one");
        if (token === "alice:refresh:rotated-one") return pair("alice", "rotated-two");
        throw new ApiError(401, "OLD_REFRESH_REJECTED");
      },
      logout: async token => {
        logouts.push(token);
        if (logouts.length === 1) throw new ApiError(0, "NETWORK_UNAVAILABLE");
        if (retryAccessDenied && token === "alice:access:rotated-one") throw new ApiError(401, "HTTP_401");
        oldSessionActive = false;
      },
    }), () => now);
    await session.signIn("alice@example.test", "password");
    now = 3_700_000;

    // 실행: 갱신은 성공했으나 logout 응답이 실패한 뒤 명시적으로 정리를 재시도한다.
    await session.signOut();
    assert.equal(session.getSnapshot().error, "SIGN_OUT_INCOMPLETE");
    assert.equal(oldSessionActive, true);
    await session.signOut();

    // 검증: old refresh의 거절을 새 sid 폐기 성공으로 오인하지 않고 새 자격만 재사용한다.
    assert.equal(oldSessionActive, false);
    assert.deepEqual(refreshes, retryAccessDenied
      ? ["alice:refresh:initial", "alice:refresh:rotated-one"] : ["alice:refresh:initial"]);
    assert.deepEqual(logouts, retryAccessDenied
      ? ["alice:access:rotated-one", "alice:access:rotated-one", "alice:access:rotated-two"]
      : ["alice:access:rotated-one", "alice:access:rotated-one"]);
    assert.equal(session.getSnapshot().error, null);
    assert.equal(memory.value(), null);
  });
}
