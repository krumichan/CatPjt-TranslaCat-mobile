import assert from "node:assert/strict";
import test from "node:test";

import { ApiError, createApiClient } from "../src/api/client.ts";
import { ChatContractError } from "../src/domain/chat/contracts.ts";
import { createChatService } from "../src/features/chat/service.ts";
import { createOpenRoomService, OpenRoomInputError, prepareOpenRoomCreate, type OpenRoomCreateInput, type OpenRoomVisibility } from "../src/features/open-chat/create-service.ts";
import { createOpenRoomSubmission } from "../src/features/open-chat/create-session.ts";

const draft: OpenRoomCreateInput = { name: "  언어 이야기  ", description: "  서로의 언어를 배우는 방  ", visibility: "PUBLIC", maxMemberCount: "50", nickname: "  방별 고양이  " };

function detail(id = 31, visibility: OpenRoomVisibility = "PUBLIC", joined = true) {
  return {
    id, roomType: "OPEN", sourceType: "MANUAL", name: draft.name.trim(), description: draft.description.trim(),
    visibility, status: "ACTIVE", memberCount: 1, maxMemberCount: 50,
    joined, joinable: !joined, joinBlockedReason: joined ? "ALREADY_JOINED" : "NONE", myRole: joined ? "OWNER" : null,
    myOpenProfile: joined ? { openChatMemberId: 21, nickname: draft.nickname.trim(), memberCode: "OC-TEST1", joinedAt: "2026-10-20T10:00:00Z" } : null,
    ai: { aiEnabled: false, aiMemberCount: 0, disclosureType: null },
  };
}

function response(body: unknown, status = 201) {
  return new Response(JSON.stringify({ resultCode: status, message: "Created", body, guid: "synthetic", createDate: "2026-10-20T10:00:00Z" }), { status });
}

function api(fetcher: typeof fetch, assertCurrentSession?: () => void) {
  return createApiClient({ baseUrl: "https://unit.test/api/v1", accessToken: async () => "synthetic-owner", fetcher, assertCurrentSession });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(finish => { resolve = finish; });
  return { promise, resolve };
}

test("OPEN 생성은 웹과 같은 필드만 보내며 방별 닉네임과 공개 범위를 보존한다", async () => {
  // 준비: 생성자는 이미 OWNER로 참여하여 joinable=false인 실제 계약을 사용한다.
  const requests: { path: string; method: string | undefined; body: unknown }[] = [];
  const service = createOpenRoomService(api(async (url, options) => {
    requests.push({ path: new URL(String(url)).pathname, method: options?.method, body: JSON.parse(String(options?.body)) });
    return response(detail());
  }));

  // 실행
  const room = await service.create(draft);

  // 검증: sourceType=MANUAL은 정상이며 일반 계정·AI 설정·이미지 자격을 임의로 덧붙이지 않는다.
  assert.equal(room.id, "31");
  assert.equal(room.joined, true);
  assert.equal(room.joinable, false);
  assert.deepEqual(requests, [{ path: "/api/v1/chat/open-rooms", method: "POST", body: {
    name: "언어 이야기", description: "서로의 언어를 배우는 방", visibility: "PUBLIC", maxMemberCount: 50,
    ownerProfile: { nickname: "방별 고양이", profileImageObjectKey: null },
  } }]);
});

test("서버 UTF-16 길이와 정원 경계에 맞춰 요청 전에 검사한다", () => {
  // 준비
  const valid = { ...draft, name: "😀".repeat(50), description: "가".repeat(500), nickname: "😀".repeat(25), maxMemberCount: "2" };
  const invalid: Partial<OpenRoomCreateInput>[] = [
    { name: " \t\n " }, { name: "😀".repeat(51) }, { description: " " }, { description: "가".repeat(501) },
    { nickname: "\n" }, { nickname: "😀".repeat(26) }, { visibility: "HIDDEN" as OpenRoomVisibility },
    ...["", "1", "101", "2.5", "2e1", "-2", "Infinity", "NaN"].map(maxMemberCount => ({ maxMemberCount })),
  ];

  // 실행·검증
  assert.equal(prepareOpenRoomCreate(valid).maxMemberCount, 2);
  assert.equal(prepareOpenRoomCreate({ ...draft, maxMemberCount: "100" }).maxMemberCount, 100);
  for (const change of invalid) assert.throws(() => prepareOpenRoomCreate({ ...draft, ...change }), OpenRoomInputError);
});

test("잘못된 입력은 생성 POST를 보내지 않는다", async () => {
  // 준비
  let posts = 0;
  const service = createOpenRoomService(api(async () => { posts += 1; return response(detail()); }));

  // 실행·검증
  await assert.rejects(service.create({ ...draft, nickname: " " }), OpenRoomInputError);
  assert.equal(posts, 0);
});

test("생성 응답은 안전한 ID·방장 참여·일치하는 공개 범위와 방별 프로필이 있어야 한다", async () => {
  // 준비
  const malformed = [
    { id: Number.MAX_SAFE_INTEGER + 1 }, { roomType: "GROUP" }, { status: "CLOSED" },
    { visibility: "UNLISTED" }, { joined: false }, { myRole: "MEMBER" }, { myOpenProfile: null },
    { name: "다른 방" }, { maxMemberCount: 100 }, { myOpenProfile: { ...detail().myOpenProfile, nickname: "다른 프로필" } },
  ];

  // 실행·검증: 서버가 저장했을 수 있으므로 서비스도 자동 재호출하지 않는다.
  for (const change of malformed) {
    let posts = 0;
    const service = createOpenRoomService(api(async () => { posts += 1; return response({ ...detail(), ...change }); }));
    await assert.rejects(service.create(draft), ChatContractError);
    assert.equal(posts, 1);
  }
});

test("빠르게 두 번 눌러도 생성 POST는 하나이고 성공 뒤 재생성하지 않는다", async () => {
  // 준비
  const reply = deferred<Response>();
  let posts = 0;
  const submission = createOpenRoomSubmission(createOpenRoomService(api(async () => { posts += 1; return reply.promise; })), () => true);
  submission.attach();

  // 실행
  const first = submission.submit(draft);
  const duplicate = submission.submit(draft);
  await Promise.resolve();
  reply.resolve(response(detail()));

  // 검증
  assert.equal(await duplicate, null);
  assert.equal((await first)?.id, "31");
  assert.equal(await submission.submit(draft), null);
  assert.equal(posts, 1);
  assert.equal(submission.getSnapshot().status, "created");
});

for (const failureKind of ["network", "server", "timeout", "invalid-response"] as const) {
  test(`생성 결과가 불명확한 ${failureKind} 오류 뒤에는 재제출을 잠근다`, async () => {
    // 준비
    let posts = 0;
    const service = createOpenRoomService(api(async () => {
      posts += 1;
      if (failureKind === "network") throw new Error("SYNTHETIC_PRIVATE_ERROR");
      if (failureKind === "invalid-response") return response({ ...detail(), myOpenProfile: null });
      return response({}, failureKind === "timeout" ? 408 : 503);
    }));
    const submission = createOpenRoomSubmission(service, () => true);
    submission.attach();

    // 실행
    assert.equal(await submission.submit(draft), null);
    assert.equal(await submission.submit(draft), null);

    // 검증: UNLISTED 방도 찾을 수 있는 내 채팅 확인을 안내하고 원문 오류를 반사하지 않는다.
    assert.equal(posts, 1);
    assert.equal(submission.getSnapshot().status, "uncertain");
    assert.match(submission.getSnapshot().message ?? "", /내 채팅/);
    assert.doesNotMatch(JSON.stringify(submission.getSnapshot()), /SYNTHETIC_PRIVATE_ERROR/);
  });
}

for (const status of [400, 401, 403, 404, 409, 429]) {
  test(`명시적인 HTTP ${status} 거절은 안내 후 사용자의 재요청만 허용한다`, async () => {
    // 준비
    let posts = 0;
    const service = createOpenRoomService(api(async () => {
      posts += 1;
      return posts === 1 ? response({ errorCode: "SYNTHETIC_UNTRUSTED_ERROR", message: "PRIVATE" }, status) : response(detail());
    }));
    const submission = createOpenRoomSubmission(service, () => true);
    submission.attach();

    // 실행·검증: 첫 실패만으로 자동 재호출하지 않는다.
    await submission.submit(draft);
    assert.equal(posts, 1);
    assert.equal(submission.getSnapshot().status, "rejected");
    assert.doesNotMatch(JSON.stringify(submission.getSnapshot()), /PRIVATE|SYNTHETIC_UNTRUSTED_ERROR/);
    assert.equal((await submission.submit(draft))?.id, "31");
    assert.equal(posts, 2);
  });
}

test("입력 오류를 고친 뒤에는 첫 네트워크 요청으로 생성할 수 있다", async () => {
  // 준비
  let posts = 0;
  const submission = createOpenRoomSubmission(createOpenRoomService(api(async () => { posts += 1; return response(detail()); })), () => true);
  submission.attach();

  // 실행
  await submission.submit({ ...draft, nickname: " " });
  assert.equal(submission.getSnapshot().status, "rejected");
  assert.ok(submission.getSnapshot().fields.nickname);
  submission.clearValidation();
  const created = await submission.submit(draft);

  // 검증
  assert.equal(created?.id, "31");
  assert.equal(posts, 1);
});

test("취소 뒤 늦은 성공 응답은 방 이동 결과로 반환하지 않고 재제출도 막는다", async () => {
  // 준비
  const reply = deferred<Response>();
  let signal: AbortSignal | null | undefined;
  let posts = 0;
  const submission = createOpenRoomSubmission(createOpenRoomService(api(async (_url, options) => {
    posts += 1; signal = options?.signal; return reply.promise;
  })), () => true);
  submission.attach();

  // 실행
  const pending = submission.submit(draft);
  await Promise.resolve();
  await Promise.resolve();
  submission.cancel();
  reply.resolve(response(detail()));

  // 검증: abort가 서버 저장을 되돌렸다고 가정하지 않는다.
  assert.equal((signal as AbortSignal | undefined)?.aborted, true);
  assert.equal(await pending, null);
  assert.equal(submission.getSnapshot().status, "uncertain");
  assert.equal(await submission.submit(draft), null);
  assert.equal(posts, 1);
});

test("화면 정리 뒤 늦은 결과는 무시하고 StrictMode 초기 재연결은 사용할 수 있다", async () => {
  // 준비
  const reply = deferred<Response>();
  const submission = createOpenRoomSubmission(createOpenRoomService(api(async () => reply.promise)), () => true);
  submission.attach();
  submission.detach();
  submission.attach();

  // 실행
  const pending = submission.submit(draft);
  await Promise.resolve();
  submission.detach();
  reply.resolve(response(detail()));

  // 검증
  assert.equal(await pending, null);
  assert.equal(submission.getSnapshot().status, "uncertain");
});

test("StrictMode setup-cleanup-setup 뒤 같은 컨트롤러로 한 번 생성할 수 있다", async () => {
  // 준비: 화면의 effect가 재실행되어도 동일 useMemo 컨트롤러의 소유권을 다시 연결한다.
  let posts = 0;
  const submission = createOpenRoomSubmission(createOpenRoomService(api(async () => { posts += 1; return response(detail()); })), () => true);
  submission.attach();
  submission.detach();
  submission.attach();

  // 실행
  const created = await submission.submit(draft);

  // 검증: 영구 disposed 상태나 중복 POST 없이 현재 effect 소유권으로 성공한다.
  assert.equal(created?.id, "31");
  assert.equal(submission.getSnapshot().status, "created");
  assert.equal(posts, 1);
});

test("요청 중 cleanup 후 다시 setup되어도 이전 effect의 성공은 재사용하지 않는다", async () => {
  // 준비
  const reply = deferred<Response>();
  let posts = 0;
  const submission = createOpenRoomSubmission(createOpenRoomService(api(async () => { posts += 1; return reply.promise; })), () => true);
  submission.attach();
  const pending = submission.submit(draft);
  await Promise.resolve();

  // 실행: 새 setup이 attached를 복원해도 generation이 이전 요청과 다르다.
  submission.detach();
  submission.attach();
  reply.resolve(response(detail()));

  // 검증: 늦은 생성으로 방 이동하거나 또 만들지 않고 내 채팅 확인 상태를 유지한다.
  assert.equal(await pending, null);
  assert.equal(submission.getSnapshot().status, "uncertain");
  assert.equal(await submission.submit(draft), null);
  assert.equal(posts, 1);
});

test("계정이 바뀐 뒤 이전 생성 응답은 새 계정의 상태를 덮지 않는다", async () => {
  // 준비
  const oldReply = deferred<Response>();
  let owner = "account-a";
  const old = createOpenRoomSubmission(createOpenRoomService(api(async () => oldReply.promise)), () => owner === "account-a");
  old.attach();
  const pendingOld = old.submit(draft);
  await Promise.resolve();
  owner = "account-b";
  const current = createOpenRoomSubmission(createOpenRoomService(api(async () => response(detail(32)))), () => owner === "account-b");
  current.attach();

  // 실행
  const newRoom = await current.submit(draft);
  oldReply.resolve(response(detail(31)));

  // 검증
  assert.equal(newRoom?.id, "32");
  assert.equal(await pendingOld, null);
  assert.equal(current.getSnapshot().roomId, "32");
});

test("현재 계정이 아닌 화면에서는 제출하지 않고 현재 계정의 화면만 생성한다", async () => {
  // 준비
  let posts = 0;
  let current = false;
  const service = createOpenRoomService(api(async () => { posts += 1; return response(detail()); }, () => {
    if (!current) throw new ApiError(0, "SESSION_CHANGED");
  }));
  const submission = createOpenRoomSubmission(service, () => current);
  submission.attach();

  // 실행·검증
  assert.equal(await submission.submit(draft), null);
  assert.equal(posts, 0);
  assert.equal(submission.getSnapshot().status, "idle");
  current = true;
  assert.equal((await submission.submit(draft))?.id, "31");
});

test("토큰을 기다리는 사이 계정이 바뀌면 API guard가 POST를 차단한다", async () => {
  // 준비: 실제 API 클라이언트의 토큰 획득 앞뒤 세션 검사를 지연 응답으로 통과시킨다.
  const token = deferred<string>();
  let current = true;
  let posts = 0;
  const guardedApi = createApiClient({
    baseUrl: "https://unit.test/api/v1", accessToken: () => token.promise,
    assertCurrentSession: () => { if (!current) throw new ApiError(0, "SESSION_CHANGED"); },
    fetcher: async () => { posts += 1; return response(detail()); },
  });
  const submission = createOpenRoomSubmission(createOpenRoomService(guardedApi), () => current);
  submission.attach();

  // 실행
  const pending = submission.submit(draft);
  current = false;
  token.resolve("synthetic-old-session");

  // 검증: 이전 계정의 토큰이나 입력을 다음 계정으로 재전송하지 않는다.
  assert.equal(await pending, null);
  assert.equal(posts, 0);
  assert.equal(submission.getSnapshot().roomId, null);
});

for (const visibility of ["PUBLIC", "UNLISTED"] as const) {
  test(`${visibility} 생성 뒤 다른 계정의 검색 노출과 기존 참여 API가 맞물린다`, async () => {
    // 준비: 원격 서버 없이 실제 create/list/detail/join 클라이언트를 같은 합성 HTTP 경계에 연결한다.
    let created = false;
    let guestJoined = false;
    const paths: string[] = [];
    const fetcher: typeof fetch = async (url, options) => {
      const target = new URL(String(url));
      const actor = new Headers(options?.headers).get("Authorization");
      paths.push(`${options?.method} ${target.pathname}`);
      if (options?.method === "POST" && target.pathname.endsWith("/open-rooms")) {
        assert.equal(actor, "Bearer synthetic-owner");
        assert.equal(JSON.parse(String(options?.body)).visibility, visibility);
        created = true;
        return response(detail(31, visibility));
      }
      assert.equal(created, true);
      assert.equal(actor, "Bearer synthetic-guest");
      if (target.pathname.endsWith("/open-rooms")) {
        return response({ openChatRooms: visibility === "PUBLIC" ? [detail(31, visibility, false)] : [], nextCursorId: null, hasNext: false }, 200);
      }
      if (target.pathname.endsWith("/join")) {
        assert.deepEqual(JSON.parse(String(options?.body)), { profile: { nickname: "다른 참여자", profileImageObjectKey: null } });
        guestJoined = true;
      }
      const room = detail(31, visibility, guestJoined);
      return response({ ...room, memberCount: guestJoined ? 2 : 1, myRole: guestJoined ? "MEMBER" : null,
        myOpenProfile: guestJoined ? { ...room.myOpenProfile, nickname: "다른 참여자" } : null }, 200);
    };
    const owner = createOpenRoomService(api(fetcher));
    const guest = createChatService(createApiClient({ baseUrl: "https://unit.test/api/v1", accessToken: async () => "synthetic-guest", fetcher }));

    // 실행
    const room = await owner.create({ ...draft, visibility });
    const listing = await guest.openRooms("언어", null);
    const beforeJoin = await guest.openRoom(room.id);
    const joined = await guest.join(room.id, "다른 참여자");

    // 검증: UNLISTED를 공개 검색으로 복구·노출하지 않으며 방별 프로필로 참여한다.
    assert.equal(listing.rooms.some(item => item.id === room.id), visibility === "PUBLIC");
    assert.equal(beforeJoin.joined, false);
    assert.equal(joined.joined, true);
    assert.equal(joined.myOpenProfile?.nickname, "다른 참여자");
    assert.equal(paths.filter(path => path === "POST /api/v1/chat/open-rooms").length, 1);
  });
}
