import assert from "node:assert/strict";
import test from "node:test";

import { createDeviceAcquisition, type PushDevicePort } from "../src/notifications/acquisition.ts";
import { InstallationIdentity, parseInstallation } from "../src/notifications/installation.ts";
import { PushLifecycle, type PushSession } from "../src/notifications/lifecycle.ts";
import { createPushRegistry, type PushRegistration } from "../src/notifications/registry.ts";
import { createApiClient } from "../src/api/client.ts";

const installationId = "d44af64d-9514-4f02-92ab-92fb655f64b1";
const installationProof = "ab".repeat(32);
const token = "ExpoPushToken[test-token]";
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function identity(initial: string | null = null, failure = false) {
  let raw = initial;
  const writes: string[] = [];
  let created = 0;
  const store = new InstallationIdentity({
    read: async () => raw,
    write: async value => { if (failure) throw new Error("STORAGE"); raw = value; writes.push(value); },
  }, async () => { created += 1; return { installationId, installationProof }; });
  return { store, writes, raw: () => raw, created: () => created };
}

function actor(key: string, registered: string[], deleted: string[]): PushSession {
  return { sessionKey: key, registry: {
    register: async (installation, value) => {
      registered.push(`${key}:${installation.generation}:${value}`);
      return { installationId, accountBindingId: `binding-${key}`, generation: installation.generation, tokenVersion: 1 };
    },
    disable: async installation => { deleted.push(`${key}:${installation.generation}`); },
  } };
}

test("설치 식별자와 proof는 한 record에 저장되고 병렬 요청도 지속 세대를 증가시킨다", async () => {
  // 준비 및 실행
  const fixture = identity();
  const values = await Promise.all([fixture.store.next(), fixture.store.next(), fixture.store.next()]);
  // 검증
  assert.deepEqual(values.map(value => value.generation), [1, 2, 3]);
  assert.equal(fixture.created(), 1);
  assert.ok(fixture.writes.every(value => parseInstallation(value).installationProof === installationProof));
  const restored = identity(fixture.raw());
  assert.equal((await restored.store.next()).generation, 4);
  assert.equal(restored.created(), 0);
});

test("손상·비정규 UUID·proof·최대 세대는 기존 식별자를 재발급하지 않고 닫힌 상태로 실패한다", async () => {
  // 준비
  const valid = { installationId, installationProof, generation: 1 };
  for (const raw of ["broken", JSON.stringify({ ...valid, installationId: installationId.toUpperCase() }),
    JSON.stringify({ ...valid, installationProof: "short" }), JSON.stringify({ ...valid, generation: -1 }),
    JSON.stringify({ ...valid, generation: Number.MAX_SAFE_INTEGER })]) {
    // 실행 및 검증
    const fixture = identity(raw);
    await assert.rejects(fixture.store.next());
    assert.equal(fixture.created(), 0);
    assert.equal(fixture.writes.length, 0);
  }
});

test("지속 저장이 실패하면 등록 API를 실행하지 않는다", async () => {
  // 준비
  const registered: string[] = [];
  const lifecycle = new PushLifecycle(identity(null, true).store, async () => ({ status: "ready", token }));
  // 실행
  await lifecycle.setSession(actor("a", registered, []));
  // 검증
  assert.equal(lifecycle.getSnapshot().status, "retry");
  assert.equal(registered.length, 0);
});

test("채널을 먼저 만들며 자동 연결은 권한을 묻지 않고 명시 켜기만 권한을 요청한다", async () => {
  // 준비
  const calls: string[] = [];
  const port: PushDevicePort = {
    supported: () => true,
    ensureChannel: async () => { calls.push("channel"); },
    permission: async () => { calls.push("permission"); return { granted: false, canAskAgain: true }; },
    requestPermission: async () => { calls.push("request"); return { granted: true, canAskAgain: false }; },
    expoToken: async () => { calls.push("expo"); return token; },
  };
  const acquire = createDeviceAcquisition(port);
  // 실행 및 검증
  assert.deepEqual(await acquire(false), { status: "permission-required" });
  assert.deepEqual(calls, ["channel", "permission"]);
  calls.length = 0;
  assert.deepEqual(await acquire(true), { status: "ready", token });
  assert.deepEqual(calls, ["channel", "permission", "request", "expo"]);
});

test("다시 묻기 불가 권한은 재요청하지 않고 native token은 Expo 변환 port로만 전달한다", async () => {
  // 준비
  let granted = false;
  let requests = 0;
  const nativeToken = { type: "android", data: "synthetic-native-token" };
  let received: unknown;
  const acquire = createDeviceAcquisition({
    supported: () => true, ensureChannel: async () => {},
    permission: async () => ({ granted, canAskAgain: false }),
    requestPermission: async () => { requests += 1; return { granted, canAskAgain: false }; },
    expoToken: async value => { received = value; return token; },
  });
  // 실행 및 검증
  assert.deepEqual(await acquire(true), { status: "permission-blocked" });
  assert.equal(requests, 0);
  granted = true;
  assert.deepEqual(await acquire(false, nativeToken), { status: "ready", token });
  assert.equal(received, nativeToken);
});

test("지원하지 않는 기기는 SecureStore와 등록 API를 호출하지 않는다", async () => {
  // 준비
  const fixture = identity();
  const registrations: string[] = [];
  const lifecycle = new PushLifecycle(fixture.store, async () => ({ status: "unavailable" }));
  // 실행
  await lifecycle.setSession(actor("a", registrations, []));
  // 검증
  assert.equal(lifecycle.getSnapshot().status, "unavailable");
  assert.equal(fixture.writes.length, 0);
  assert.equal(registrations.length, 0);
});

test("서버가 불통이어도 권한 켜기·설정 안내 상태를 잃지 않는다", async () => {
  // 준비
  const session = actor("a", [], []);
  session.registry.disable = async () => { throw new Error("OFFLINE"); };
  const lifecycle = new PushLifecycle(identity().store, async () => ({ status: "permission-required" }));
  // 실행
  await lifecycle.setSession(session);
  // 검증
  assert.equal(lifecycle.getSnapshot().status, "permission-required");
  assert.equal(lifecycle.getSnapshot().accountBindingId, null);
});

test("늦은 이전 계정 PUT 응답은 현재 binding을 덮지 않고 새 세대가 뒤에 등록된다", async () => {
  // 준비
  const fixture = identity();
  const late = deferred<PushRegistration>();
  const events: string[] = [];
  const old = actor("a", [], []);
  old.registry.register = async installation => {
    events.push(`a:${installation.generation}`);
    return late.promise;
  };
  const lifecycle = new PushLifecycle(fixture.store, async () => ({ status: "ready", token }));
  const seen: (string | null)[] = [];
  lifecycle.subscribe(() => { seen.push(lifecycle.getSnapshot().accountBindingId); });
  // 실행
  const first = lifecycle.setSession(old);
  await tick();
  const second = lifecycle.setSession(actor("b", events, []));
  late.resolve({ installationId, accountBindingId: "binding-a", generation: 1, tokenVersion: 1 });
  await Promise.all([first, second]);
  // 검증
  assert.equal(lifecycle.getSnapshot().accountBindingId, "binding-b");
  assert.equal(seen.includes("binding-a"), false);
  assert.deepEqual(events, ["a:1", `b:2:${token}`]);
});

test("SDK 결과가 늦게 도착한 이전 계정은 등록 API조차 실행하지 않는다", async () => {
  // 준비
  const sdk = deferred<{ status: "ready"; token: string }>();
  let count = 0;
  const registered: string[] = [];
  const lifecycle = new PushLifecycle(identity().store, async () => ++count === 1 ? sdk.promise : { status: "ready", token });
  // 실행
  const old = lifecycle.setSession(actor("a", registered, []));
  await tick();
  const current = lifecycle.setSession(actor("b", registered, []));
  sdk.resolve({ status: "ready", token: "ExpoPushToken[old-result]" });
  await Promise.all([old, current]);
  // 검증
  assert.deepEqual(registered, [`b:1:${token}`]);
});

test("로그아웃 cleanup은 캡처한 registry를 쓰고 null 세션 효과는 cleanup을 취소하지 않는다", async () => {
  // 준비
  const deleted: string[] = [];
  const lifecycle = new PushLifecycle(identity().store, async () => ({ status: "ready", token }));
  await lifecycle.setSession(actor("a", [], deleted));
  const captured = actor("captured-a", [], deleted);
  // 실행
  const cleanup = lifecycle.disableSession("a", captured.registry);
  await lifecycle.setSession(null);
  await cleanup;
  // 검증
  assert.deepEqual(deleted, ["captured-a:2"]);
  assert.deepEqual(lifecycle.getSnapshot(), { status: "signed-out", sessionKey: null, accountBindingId: null });
});

test("지연된 로그아웃과 이전 계정의 cleanup은 새 계정을 해제하지 않는다", async () => {
  // 준비
  const deleted: string[] = [];
  const lifecycle = new PushLifecycle(identity().store, async () => ({ status: "ready", token }));
  await lifecycle.setSession(actor("a", [], deleted));
  // 실행
  const cleanup = lifecycle.disableSession("a", actor("captured-a", [], deleted).registry);
  const current = lifecycle.setSession(actor("b", [], deleted));
  await Promise.all([cleanup, current]);
  await lifecycle.disableSession("a", actor("late-a", [], deleted).registry);
  // 검증
  assert.equal(deleted.length, 0);
  assert.equal(lifecycle.getSnapshot().accountBindingId, "binding-b");
});

test("토큰 회전과 resume은 단일 queue로 순서대로 저장·등록된다", async () => {
  // 준비
  const rotations: unknown[] = [];
  const events: string[] = [];
  const lifecycle = new PushLifecycle(identity().store, async (_ask, native) => {
    rotations.push(native);
    return { status: "ready", token: `ExpoPushToken[${typeof native === "string" ? native : "initial"}]` };
  });
  // 실행
  await lifecycle.setSession(actor("a", events, []));
  await Promise.all([lifecycle.sync(false, "rotation-1"), lifecycle.sync(false, "rotation-2"), lifecycle.sync()]);
  // 검증
  assert.deepEqual(rotations, [undefined, "rotation-1", "rotation-2", undefined]);
  assert.deepEqual(events.map(event => event.split(":")[1]), ["1", "2", "3", "4"]);
});

test("권한 회수는 새 세대 DELETE이며 409는 자동 세대 증가·재전송을 유발하지 않는다", async () => {
  // 준비
  let granted = true;
  const events: string[] = [];
  const deleted: string[] = [];
  const fixture = identity();
  const lifecycle = new PushLifecycle(fixture.store, async () => granted ? { status: "ready", token } : { status: "permission-blocked" });
  const session = actor("a", events, deleted);
  await lifecycle.setSession(session);
  // 실행 및 검증
  granted = false;
  await lifecycle.sync();
  assert.deepEqual(deleted, ["a:2"]);
  assert.equal(lifecycle.getSnapshot().accountBindingId, null);
  granted = true;
  session.registry.register = async () => { throw new Error("HTTP_409"); };
  await lifecycle.sync();
  await tick();
  assert.equal(fixture.writes.length, 3);
  assert.equal(lifecycle.getSnapshot().status, "retry");
});

test("registry는 JWT로만 계정을 정하고 토큰·proof를 반사하지 않는 envelope를 검사한다", async () => {
  // 준비
  const requests: { method: string; body: Record<string, unknown> }[] = [];
  let invalid = false;
  const api = createApiClient({ baseUrl: "https://example.test/api/v1", accessToken: async () => "synthetic-access",
    fetcher: async (_url, options) => {
      requests.push({ method: options!.method!, body: JSON.parse(options!.body as string) });
      if (options?.method === "DELETE") return new Response(null, { status: 204 });
      return new Response(JSON.stringify({ body: {
        installationId, accountBindingId: "binding-a", generation: invalid ? 99 : 1, tokenVersion: 1,
      } }));
    },
  });
  const registry = createPushRegistry(api, { platform: "android", appEnvironment: "development", projectId: installationId });
  const installation = { installationId, installationProof, generation: 1 };
  // 실행
  const result = await registry.register(installation, token);
  await registry.disable({ ...installation, generation: 2 });
  invalid = true;
  await assert.rejects(registry.register(installation, token));
  // 검증
  assert.deepEqual(Object.keys(result).sort(), ["accountBindingId", "generation", "installationId", "tokenVersion"]);
  assert.equal("userId" in requests[0].body, false);
  assert.equal("sid" in requests[0].body, false);
  assert.equal(requests[0].body.expoPushToken, token);
  assert.deepEqual(requests[1], { method: "DELETE", body: { installationProof, generation: 2 } });
});
