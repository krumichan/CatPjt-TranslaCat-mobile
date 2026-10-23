import assert from "node:assert/strict";
import test from "node:test";
import { ApiError, createApiClient } from "../src/api/client.ts";
import { ChatContractError } from "../src/domain/chat/contracts.ts";
import { createUserBlockController } from "../src/features/user-blocks/controller.ts";
import { createUserBlockService, parseUserBlock, type UserBlock, type UserBlockService } from "../src/features/user-blocks/service.ts";

const person = { userId: "2", publicId: "fixture-person", nickname: "테스트 친구" };
const candidate = { ...person, friendStatus: "FRIEND" as const };
const wireBlock = { id: 91, blockedUser: { ...person, userId: 2 }, createdAt: "2026-10-22T00:00:00Z" };
const entry = (): UserBlock => parseUserBlock(wireBlock);
const envelope = (body: unknown) => new Response(JSON.stringify({ body }), { status: 200 });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function fixture(overrides: Partial<UserBlockService> = {}, extra: { current?: () => boolean; timeout?: number } = {}) {
  let list: UserBlock[] = [];
  let writes = 0;
  let changes = 0;
  const service: UserBlockService = { list: async () => list, search: async () => candidate,
    block: async () => { writes += 1; list = [entry()]; return entry(); },
    unblock: async () => { writes += 1; list = []; }, ...overrides };
  const controller = createUserBlockController({ service, selfId: "1", isCurrent: extra.current ?? (() => true),
    onChange: () => {}, onRelationshipsChanged: () => { changes += 1; }, requestTimeoutMs: extra.timeout ?? 500 });
  return { controller, writes: () => writes, changes: () => changes, setList: (next: UserBlock[]) => { list = next; } };
}
async function prepare(f: ReturnType<typeof fixture>) {
  await f.controller.load();
  await f.controller.search(person.publicId);
  f.controller.prepareBlock();
}

test("중첩 차단 목록은 중복 행·계정과 unsafe ID를 거절한다", async () => {
  // 준비
  let body: unknown = [wireBlock];
  const service = createUserBlockService(createApiClient({ baseUrl: "https://fixture.invalid/api/v1", accessToken: async () => "synthetic-access", fetcher: async () => envelope(body) }));
  // 실행·검증
  assert.deepEqual((await service.list())[0]?.user, person);
  body = [wireBlock, { ...wireBlock, id: 92 }];
  await assert.rejects(service.list(), ChatContractError);
  body = [wireBlock, { ...wireBlock, blockedUser: { ...wireBlock.blockedUser, userId: 3 } }];
  await assert.rejects(service.list(), ChatContractError);
  assert.throws(() => parseUserBlock({ ...wireBlock, blockedUser: { ...person, userId: Number.MAX_SAFE_INTEGER + 1 } }), ChatContractError);
});

test("차단 POST는 확인한 공개 ID만 보내고 다른 계정 응답은 거절한다", async () => {
  // 준비
  const calls: { path: string; method: unknown; body: unknown }[] = [];
  let body: unknown = wireBlock;
  const service = createUserBlockService(createApiClient({ baseUrl: "https://fixture.invalid/api/v1", accessToken: async () => "synthetic-access",
    fetcher: async (url, options) => { calls.push({ path: new URL(String(url)).pathname, method: options?.method, body: JSON.parse(options?.body as string) }); return envelope(body); } }));
  // 실행
  await service.block(person);
  body = { ...wireBlock, blockedUser: { ...wireBlock.blockedUser, userId: 3 } };
  // 검증
  assert.deepEqual(calls[0], { path: "/api/v1/blocks", method: "POST", body: { blockedPublicId: person.publicId } });
  await assert.rejects(service.block(person), ChatContractError);
  body = { ...wireBlock, blockedUser: { ...wireBlock.blockedUser, publicId: "another-person" } };
  await assert.rejects(service.block(person), ChatContractError);
});

test("해제는 차단 행 91이 아닌 사용자 2의 DELETE이며 true만 확인한다", async () => {
  // 준비
  const paths: string[] = [];
  let body: unknown = true;
  const service = createUserBlockService(createApiClient({ baseUrl: "https://fixture.invalid/api/v1", accessToken: async () => "synthetic-access",
    fetcher: async (url, options) => { assert.equal(options?.method, "DELETE"); paths.push(new URL(String(url)).pathname); return envelope(body); } }));
  // 실행·검증
  await service.unblock("2");
  assert.equal(paths[0], "/api/v1/blocks/2");
  body = false;
  await assert.rejects(service.unblock("2"), ChatContractError);
  await assert.rejects(service.unblock("../2"), ChatContractError);
  assert.equal(paths.length, 2);
});

test("확인 전·취소 후에는 차단 쓰기를 보내지 않는다", async () => {
  // 준비
  const f = fixture();
  await f.controller.load();
  await f.controller.search(person.publicId);
  // 실행
  await f.controller.confirm();
  f.controller.prepareBlock();
  f.controller.cancel();
  await f.controller.confirm();
  // 검증
  assert.equal(f.writes(), 0);
  assert.equal(f.controller.getSnapshot().confirmation, null);
  f.controller.dispose();
});

test("자기 계정은 검색 상태와 무관하게 차단 대상으로 선택하지 않는다", async () => {
  // 준비
  const f = fixture({ search: async () => ({ ...candidate, userId: "1" }) });
  // 실행
  await prepare(f);
  await f.controller.confirm();
  // 검증
  assert.equal(f.writes(), 0);
  assert.match(f.controller.getSnapshot().error!, /내 계정/);
  f.controller.dispose();
});

test("확인 연타는 한 번의 쓰기와 현재 목록 재조회로 수렴한다", async () => {
  // 준비
  const held = deferred<UserBlock>();
  let writes = 0;
  const f = fixture({ block: async () => { writes += 1; return held.promise; }, list: async () => writes ? [entry()] : [] });
  await prepare(f);
  // 실행
  const first = f.controller.confirm();
  await f.controller.confirm();
  held.resolve(entry());
  await first;
  // 검증
  assert.equal(writes, 1);
  assert.equal(f.changes(), 1);
  assert.equal(f.controller.getSnapshot().blocks.length, 1);
  assert.equal(f.controller.getSnapshot().pending, null);
  assert.equal(f.controller.getSnapshot().needsRefresh, false);
  f.controller.dispose();
});

test("이미 차단한 사용자는 중복 확인을 만들지 않는다", async () => {
  // 준비
  const f = fixture({ list: async () => [entry()] });
  // 실행
  await prepare(f);
  await f.controller.confirm();
  // 검증
  assert.equal(f.writes(), 0);
  assert.equal(f.controller.getSnapshot().confirmation, null);
  assert.match(f.controller.getSnapshot().notice!, /이미 차단/);
  f.controller.dispose();
});

test("해제 확인은 현재 목록의 정확한 사용자만 대상으로 삼는다", async () => {
  // 준비
  const f = fixture();
  f.setList([entry()]);
  await f.controller.load();
  // 실행
  f.controller.prepareUnblock("91");
  assert.equal(f.controller.getSnapshot().confirmation, null);
  f.controller.prepareUnblock("2");
  await f.controller.confirm();
  // 검증
  assert.equal(f.writes(), 1);
  assert.equal(f.controller.getSnapshot().blocks.length, 0);
  assert.match(f.controller.getSnapshot().notice!, /자동으로 복원되지/);
  f.controller.dispose();
});

test("응답 유실 후 반영된 차단은 POST 재시도 없이 GET으로 확인한다", async () => {
  // 준비
  let writes = 0;
  const f = fixture({ block: async () => { writes += 1; throw new ApiError(0, "NETWORK_UNAVAILABLE"); }, list: async () => writes ? [entry()] : [] });
  await prepare(f);
  // 실행
  await f.controller.confirm();
  // 검증
  assert.equal(writes, 1);
  assert.equal(f.controller.getSnapshot().error, null);
  assert.equal(f.controller.getSnapshot().needsRefresh, false);
  assert.equal(f.controller.getSnapshot().blocks.length, 1);
  f.controller.dispose();
});

test("미반영 차단은 성공으로 표시하거나 자동 재전송하지 않는다", async () => {
  // 준비
  let writes = 0;
  const f = fixture({ block: async () => { writes += 1; throw new ApiError(0, "NETWORK_UNAVAILABLE"); } });
  await prepare(f);
  // 실행
  await f.controller.confirm();
  await f.controller.confirm();
  // 검증
  assert.equal(writes, 1);
  assert.equal(f.controller.getSnapshot().notice, null);
  assert.match(f.controller.getSnapshot().error!, /요청한 상태/);
  f.controller.dispose();
});

test("쓰기 후 GET 실패 중에는 추가 변경을 막고 새로고침 후에 해제한다", async () => {
  // 준비
  let failing = false;
  let writes = 0;
  const f = fixture({ block: async () => { writes += 1; failing = true; return entry(); },
    list: async () => { if (failing) throw new ApiError(0, "NETWORK_UNAVAILABLE"); return []; } });
  await prepare(f);
  // 실행
  await f.controller.confirm();
  await f.controller.search(person.publicId);
  f.controller.prepareUnblock("2");
  await f.controller.confirm();
  // 검증
  assert.equal(writes, 1);
  assert.equal(f.controller.getSnapshot().needsRefresh, true);
  assert.match(f.controller.getSnapshot().error!, /자동으로 다시 보내지/);
  failing = false;
  await f.controller.load();
  assert.equal(f.controller.getSnapshot().needsRefresh, false);
  f.controller.dispose();
});

test("계정 전환 후 늦은 검색 응답은 대상·확인을 만들지 않는다", async () => {
  // 준비
  const held = deferred<typeof candidate>();
  let current = true;
  const f = fixture({ search: async () => held.promise }, { current: () => current });
  await f.controller.load();
  // 실행
  const search = f.controller.search(person.publicId);
  current = false;
  held.resolve(candidate);
  await search;
  f.controller.prepareBlock();
  await f.controller.confirm();
  // 검증
  assert.equal(f.writes(), 0);
  assert.equal(f.controller.getSnapshot().candidate, null);
  f.controller.dispose();
});

test("계정 전환 중 완료된 쓰기는 이전 계정 조회·캐시 효과·성공 표시를 막는다", async () => {
  // 준비
  const held = deferred<UserBlock>();
  let current = true;
  let reads = 0;
  const f = fixture({ block: async () => held.promise, list: async () => { reads += 1; return []; } }, { current: () => current });
  await prepare(f);
  // 실행
  const confirm = f.controller.confirm();
  current = false;
  held.resolve(entry());
  await confirm;
  // 검증
  assert.equal(reads, 1);
  assert.equal(f.changes(), 0);
  assert.equal(f.controller.getSnapshot().notice, null);
  f.controller.dispose();
});

test("제한 시간 뒤 늦은 읽기 응답이 현재 실패 상태를 덮지 않는다", async () => {
  // 준비
  const held = deferred<UserBlock[]>();
  const f = fixture({ list: async () => held.promise }, { timeout: 10 });
  // 실행
  await f.controller.load();
  held.resolve([entry()]);
  await Promise.resolve();
  // 검증
  assert.equal(f.controller.getSnapshot().pending, null);
  assert.equal(f.controller.getSnapshot().loaded, false);
  assert.equal(f.controller.getSnapshot().needsRefresh, true);
  assert.equal(f.controller.getSnapshot().blocks.length, 0);
  f.controller.dispose();
});

test("정리된 화면의 취소 무시 응답은 새 UI를 갱신하지 않는다", async () => {
  // 준비
  const held = deferred<UserBlock[]>();
  const f = fixture({ list: async () => held.promise });
  // 실행
  const loading = f.controller.load();
  f.controller.dispose();
  await loading;
  held.resolve([entry()]);
  // 검증
  assert.equal(f.controller.getSnapshot().loaded, false);
  assert.equal(f.controller.getSnapshot().blocks.length, 0);
});

