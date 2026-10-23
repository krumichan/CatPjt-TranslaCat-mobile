import assert from "node:assert/strict";
import test from "node:test";

import { ApiError, createApiClient } from "../src/api/client.ts";
import { ChatContractError, parseMessage, parseRoom } from "../src/domain/chat/contracts.ts";
import { createFriendActionSession } from "../src/features/friends/action-session.ts";
import { createFriendService, groupRequest, parseFriend, parseFriendRequest, parseFriendSearch } from "../src/features/friends/service.ts";

const person = { userId: 2, publicId: "fixture-person", nickname: "테스트 친구" };
const room = { id: 7, roomType: "DIRECT", sourceType: "FRIEND", name: null, memberCount: 2, unreadCount: 0,
  updatedAt: "2026-10-20T00:00:00Z", active: true, myRole: "MEMBER", directPartner: { userId: 2, displayName: "테스트 친구" } };
const envelope = (body: unknown) => new Response(JSON.stringify({ body }), { status: 200 });

function client(body: unknown, calls: { url: string; method: string; body: unknown }[]) {
  return createApiClient({ baseUrl: "https://fixture.invalid/api/v1", accessToken: async () => "synthetic-access", fetcher: async (url, options) => {
    calls.push({ url: String(url), method: options?.method as string, body: options?.body ? JSON.parse(options.body as string) : null });
    return envelope(body);
  } });
}

test("친구 관계와 받은 요청은 현재 서버의 중첩 프로필 DTO를 파싱한다", () => {
  // 준비
  const request = { id: 5, status: "PENDING", requester: person, receiver: { ...person, userId: 1 } };

  // 실행
  const friend = parseFriend({ id: 8, friend: person, createdAt: "2026-10-20T00:00:00Z" });
  const parsedRequest = parseFriendRequest(request);

  // 검증
  assert.equal(friend.userId, "2");
  assert.equal(friend.relationId, "8");
  assert.equal(parsedRequest.requester.nickname, person.nickname);
  assert.equal(parsedRequest.receiver.userId, "1");
  assert.throws(() => parseFriend({ id: 8, friend: { ...person, userId: Number.MAX_SAFE_INTEGER + 1 } }), ChatContractError);
  assert.throws(() => parseFriendRequest({ ...request, status: "OTHER" }), ChatContractError);
});

test("검색 관계는 허용된 상태만 수락하고 publicId는 query 값으로만 인코딩한다", async () => {
  // 준비
  const calls: { url: string; method: string; body: unknown }[] = [];
  const service = createFriendService(client({ ...person, friendStatus: "NONE" }, calls));

  // 실행
  const found = await service.search("  abc+/?next=https://else.invalid  ");

  // 검증
  assert.equal(found.friendStatus, "NONE");
  const url = new URL(calls[0]!.url);
  assert.equal(url.pathname, "/api/v1/users/search");
  assert.equal(url.searchParams.get("publicId"), "abc+/?next=https://else.invalid");
  assert.equal(url.searchParams.size, 1);
  assert.throws(() => parseFriendSearch({ ...person, friendStatus: "UNKNOWN" }), ChatContractError);
});

test("친구 요청 전송과 수락은 다른 DTO를 소비하고 정확한 method와 path를 사용한다", async () => {
  // 준비
  const sent: { url: string; method: string; body: unknown }[] = [];
  const accepted: typeof sent = [];
  const send = createFriendService(client({ id: 9, status: "PENDING", requesterUserId: 1, receiverUserId: 2 }, sent));
  const accept = createFriendService(client({ id: 9, status: "ACCEPTED", requester: person, receiver: { ...person, userId: 1 } }, accepted));

  // 실행
  await send.request("  fixture-person  ");
  await accept.respond("9", "accept");

  // 검증
  assert.deepEqual(sent[0]?.body, { receiverPublicId: "fixture-person" });
  assert.equal(sent[0]?.method, "POST");
  assert.equal(accepted[0]?.method, "PATCH");
  assert.equal(new URL(accepted[0]!.url).pathname, "/api/v1/friend-requests/9/accept");
  await assert.rejects(accept.respond("../9", "accept"), ChatContractError);
});

test("친구 DIRECT는 같은 상대와 안전한 방을 확인하며 상세 DTO의 partner 생략도 허용한다", async () => {
  // 준비
  const calls: { url: string; method: string; body: unknown }[] = [];

  // 실행
  const direct = await createFriendService(client(room, calls)).direct("2");
  const noPartner = await createFriendService(client({ ...room, directPartner: null }, [])).direct("2");

  // 검증
  assert.equal(direct.id, "7");
  assert.equal(noPartner.roomType, "DIRECT");
  assert.equal(new URL(calls[0]!.url).pathname, "/api/v1/chat/friends/2/direct-room");
  await assert.rejects(createFriendService(client({ ...room, directPartner: { userId: 3, displayName: "다른 상대" } }, [])).direct("2"), ChatContractError);
  await assert.rejects(createFriendService(client({ ...room, roomType: "GROUP" }, [])).direct("2"), ChatContractError);
});

test("그룹 요청은 현재 친구만 포함하며 중복·자신·오래된 선택·unsafe ID를 검사한다", () => {
  // 준비
  const friends = [parseFriend({ id: 8, friend: person })];

  // 실행
  const request = groupRequest(" 새 그룹 ", " 함께 대화 ", ["2", "2"], friends, "1");

  // 검증
  assert.deepEqual(request, { name: "새 그룹", description: "함께 대화", memberUserIds: [2] });
  for (const ids of [[], ["1"], ["3"], ["9007199254740992"], ["02"]]) {
    assert.throws(() => groupRequest("새 그룹", "", ids, friends, "1"), ChatContractError);
  }
  assert.throws(() => groupRequest(" ", "", ["2"], friends, "1"), ChatContractError);
  assert.throws(() => groupRequest("가".repeat(101), "", ["2"], friends, "1"), ChatContractError);
});

test("친구 그룹 생성은 기존 서버 request를 보내고 GROUP 응답만 수락한다", async () => {
  // 준비
  const calls: { url: string; method: string; body: unknown }[] = [];
  const request = { name: "그룹", description: "", memberUserIds: [2] };

  // 실행
  const created = await createFriendService(client({ ...room, roomType: "GROUP", directPartner: null }, calls)).group(request);

  // 검증
  assert.equal(created.roomType, "GROUP");
  assert.deepEqual(calls[0]?.body, request);
  assert.equal(new URL(calls[0]!.url).pathname, "/api/v1/chat/friends/group-rooms");
  await assert.rejects(createFriendService(client(room, [])).group(request), ChatContractError);
});

test("빠른 두 번 탭은 첫 요청만 실행하고 계정 변경 뒤 늦은 방 응답은 무시한다", async () => {
  // 준비
  let current = true;
  let calls = 0;
  let finish!: (id: string) => void;
  const pending = new Promise<string>(resolve => { finish = resolve; });
  const owner = createFriendActionSession(() => current);

  // 실행
  const first = owner.run(async () => { calls += 1; return pending; }, true);
  const second = await owner.run(async () => { calls += 1; return "8"; }, true);
  current = false;
  finish("7");

  // 검증
  assert.equal(second.kind, "ignored");
  assert.equal((await first).kind, "ignored");
  assert.equal(calls, 1);
});

test("비멱등 방 생성의 전송 결과가 불명확하면 다시 POST하지 않는다", async () => {
  // 준비
  for (const failure of [new ApiError(0, "NETWORK_UNAVAILABLE"), new ApiError(503, "HTTP_503"), new ApiError(408, "HTTP_408"), new ApiError(200, "INVALID_API_RESPONSE"), new ApiError(201, "INVALID_API_RESPONSE"), new ChatContractError()]) {
    const owner = createFriendActionSession(() => true);
    let requests = 0;

    // 실행
    const first = await owner.run(async () => { requests += 1; throw failure; }, true);
    const next = await owner.run(async () => { requests += 1; return "another"; }, true);

    // 검증
    assert.equal(first.kind, "failure");
    assert.equal(owner.uncertainRoom, true);
    assert.equal(next.kind, "ignored");
    assert.equal(requests, 1);
  }
});

test("명시적 4xx 거절 뒤 수정 요청은 허용하고 화면 정리 뒤 결과는 노출하지 않는다", async () => {
  // 준비
  const owner = createFriendActionSession(() => true);
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });

  // 실행
  await owner.run(async () => { throw new ApiError(400, "HTTP_400"); }, true);
  const corrected = await owner.run(async () => "7", true);
  const last = owner.run(async () => pending, false);
  owner.dispose();
  finish();

  // 검증
  assert.equal(corrected.kind, "success");
  assert.equal((await last).kind, "ignored");
  assert.equal((await owner.run(async () => "8", true)).kind, "ignored");
});

test("계정이 token을 기다리는 동안 바뀌면 새 그룹 POST를 전송하지 않는다", async () => {
  // 준비
  let current = true;
  let release!: (token: string) => void;
  let requests = 0;
  const api = createApiClient({ baseUrl: "https://fixture.invalid/api/v1", assertCurrentSession: () => {
    if (!current) throw new ApiError(0, "SESSION_CHANGED");
  }, accessToken: () => new Promise(resolve => { release = resolve; }), fetcher: async () => { requests += 1; return envelope(room); } });

  // 실행
  const pending = createFriendService(api).group({ name: "그룹", description: "", memberUserIds: [2] });
  current = false;
  release("synthetic-access");

  // 검증
  await assert.rejects(pending, { code: "SESSION_CHANGED" });
  assert.equal(requests, 0);
});

test("방 역할과 AI 발신자 ID를 보존하되 잘못된 권한과 unsafe ID는 거절한다", () => {
  // 준비
  const message = { id: 9, chatRoomId: 7, senderUserId: null, senderAiMemberId: 4, senderType: "AI", senderName: "합성 AI",
    messageType: "TEXT", content: "합성 응답", status: "SENT", translations: [], createdAt: "2026-10-20T00:00:00Z", updatedAt: "2026-10-20T00:00:00Z", sender: null };

  // 실행·검증
  assert.equal(parseRoom(room).myRole, "MEMBER");
  assert.equal(parseMessage(message).senderAiMemberId, "4");
  assert.throws(() => parseRoom({ ...room, myRole: "ROOT" }), ChatContractError);
  assert.throws(() => parseMessage({ ...message, senderAiMemberId: Number.MAX_SAFE_INTEGER + 1 }), ChatContractError);
});
