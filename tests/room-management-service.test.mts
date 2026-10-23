import assert from "node:assert/strict";
import test from "node:test";

import { ApiError, createApiClient } from "../src/api/client.ts";
import { ChatContractError } from "../src/domain/chat/contracts.ts";
import { banBody, inviteBody, ManagementInputError, parseBanPage, parseMembers } from "../src/features/room-management/contracts.ts";
import { createRoomManagementService, type RoomManagementService } from "../src/features/room-management/service.ts";

interface Call { url: URL; method: string; body: unknown; signal: AbortSignal | null | undefined }
const openMember = { openChatMemberId: 21, memberCode: "OPEN-21", nickname: "방별 이름", role: "MEMBER", active: true };
const generalMember = { id: 31, chatRoomId: 7, userId: 41, publicId: "account-41", displayName: "일반 이름", role: "MEMBER", active: true };
const banItem = { banId: 91, targetOpenChatMemberId: 21, nickname: "방별 이름", memberCode: "OPEN-21", reason: "운영 규칙", releasable: true };
const action = { roomId: 7, banId: 91, targetOpenChatMemberId: 21, active: true };
const targets = { userIds: ["41"], publicIds: [] };

function fixture(body: unknown, status = 200) {
  const calls: Call[] = [];
  const api = createApiClient({
    baseUrl: "https://fixture.invalid/api/v1", accessToken: async () => "synthetic-access",
    fetcher: async (url, options) => {
      calls.push({ url: new URL(String(url)), method: options?.method ?? "GET",
        body: options?.body ? JSON.parse(String(options.body)) : null, signal: options?.signal });
      return new Response(JSON.stringify({ body }), { status });
    },
  });
  return { service: createRoomManagementService(api), calls };
}

function roomFixture(roomType: "OPEN" | "GROUP", detail: unknown) {
  const calls: string[] = [];
  const body = { id: 7, roomType, sourceType: roomType === "OPEN" ? "OPEN" : "FRIEND", name: "테스트 방",
    memberCount: 2, unreadCount: 0, updatedAt: "2026-10-21T00:00:00Z", active: true, myRole: "OWNER" };
  const api = createApiClient({
    baseUrl: "https://fixture.invalid/api/v1", accessToken: async () => "synthetic-access",
    fetcher: async url => {
      calls.push(new URL(String(url)).pathname);
      return new Response(JSON.stringify({ body: calls.length === 1 ? body : detail }));
    },
  });
  return { service: createRoomManagementService(api), calls };
}

test("OPEN 종료 상태는 활성 멤버십과 방장 역할을 보존하고 별도 closed 상태로 전달한다", async () => {
  // 준비
  const closed = roomFixture("OPEN", { id: 7, status: "CLOSED", joined: true, myRole: "OWNER" });
  const active = roomFixture("OPEN", { id: 7, status: "ACTIVE", joined: true, myRole: "OWNER" });

  // 실행
  const closedRoom = await closed.service.room("7");
  const activeRoom = await active.service.room("7");

  // 검증
  assert.equal(closedRoom.active, true);
  assert.equal(closedRoom.closed, true);
  assert.equal(closedRoom.myRole, "OWNER");
  assert.equal(activeRoom.active, true);
  assert.equal(activeRoom.closed, false);
  assert.deepEqual(closed.calls, ["/api/v1/chat/rooms/7", "/api/v1/chat/open-rooms/7"]);
});

test("OPEN 관리용 상세는 다른 방이나 알 수 없는 종료 상태를 거절한다", async () => {
  // 준비
  const invalid = [{ id: 8, status: "ACTIVE" }, { id: 7, status: "UNKNOWN" }, { id: 7, active: true }];

  // 실행·검증
  for (const detail of invalid) await assert.rejects(roomFixture("OPEN", detail).service.room("7"), ChatContractError);
});

test("일반 그룹 상세를 확인할 때 OPEN 상세 API를 추가로 요청하지 않는다", async () => {
  // 준비
  const { service, calls } = roomFixture("GROUP", null);

  // 실행
  const room = await service.room("7");

  // 검증
  assert.equal(room.roomType, "GROUP");
  assert.equal(room.active, true);
  assert.deepEqual(calls, ["/api/v1/chat/rooms/7"]);
});

test("일반 참여자 목록은 가입 행 ID와 계정 ID를 구분하고 AI를 인간 목록에 섞지 않는다", async () => {
  // 준비
  const { service, calls } = fixture({ members: [generalMember], aiMembers: [{ aiMemberId: 41 }] });

  // 실행
  const members = await service.members("7", false);

  // 검증
  assert.deepEqual(members, [{ id: "41", displayName: "일반 이름", publicId: "account-41", memberCode: null, role: "MEMBER", active: true }]);
  assert.equal(calls[0]?.url.pathname, "/api/v1/chat/rooms/7/members");
  assert.equal(calls[0]?.method, "GET");
});

test("일반 참여자 응답의 다른 방·중복 사용자·비활성 회원은 거절한다", () => {
  // 준비
  const invalid = [
    [{ ...generalMember, chatRoomId: 8 }],
    [generalMember, { ...generalMember, id: 32 }],
    [{ ...generalMember, active: false }],
    [{ ...generalMember, userId: Number.MAX_SAFE_INTEGER + 1 }],
    [{ ...generalMember, role: "ROOT" }],
  ];

  // 실행·검증
  for (const members of invalid) assert.throws(() => parseMembers({ members }, "7", false), ChatContractError);
  assert.throws(() => parseMembers({ members: {} }, "7", false), ChatContractError);
});

test("OPEN 참여자는 방별 ID만 노출하며 응답에 섞인 계정 신원을 복사하지 않는다", async () => {
  // 준비
  const { service, calls } = fixture({ members: [{ ...openMember, userId: 41, publicId: "private-account", email: "private@example.invalid" }] });

  // 실행
  const members = await service.members("7", true);

  // 검증
  assert.deepEqual(members, [{ id: "21", displayName: "방별 이름", publicId: null, memberCode: "OPEN-21", role: "MEMBER", active: true }]);
  assert.equal(calls[0]?.url.pathname, "/api/v1/chat/open-rooms/7/members");
  assert.equal(JSON.stringify(members).includes("private"), false);
});

test("OPEN 목록은 계정 ID로 방별 ID를 대신하거나 중복·비활성 회원을 허용하지 않는다", () => {
  // 준비
  const invalid = [
    [{ ...openMember, openChatMemberId: undefined, userId: 21 }],
    [{ ...openMember, openChatMemberId: "9007199254740992" }],
    [openMember, openMember],
    [{ ...openMember, active: false }],
  ];

  // 실행·검증
  for (const members of invalid) assert.throws(() => parseMembers({ members }, "7", true), ChatContractError);
});

test("내 OPEN 프로필은 활성 회원만 수락한다", async () => {
  // 준비
  const valid = fixture(openMember);
  const inactive = fixture({ ...openMember, active: false });

  // 실행·검증
  assert.equal((await valid.service.me("7")).id, "21");
  assert.equal(valid.calls[0]?.url.pathname, "/api/v1/chat/open-rooms/7/me/profile");
  await assert.rejects(inactive.service.me("7"), ChatContractError);
});

test("초대 대상은 계정 ID와 public ID를 별도 필드로 유지하며 중복과 공백만 정리한다", () => {
  // 준비
  const input = { userIds: ["41", "41"], publicIds: [" account-42 ", "account-42", " ", "00021"] };

  // 실행
  const body = inviteBody(input);

  // 검증
  assert.deepEqual(body, { targetUserIds: [41], targetPublicIds: ["account-42", "00021"] });
  assert.throws(() => inviteBody({ userIds: [], publicIds: [" "] }), ManagementInputError);
  for (const id of ["0", "-1", "041", "../41", "9007199254740992"]) {
    assert.throws(() => inviteBody({ userIds: [id], publicIds: [] }), ChatContractError);
  }
});

test("그룹 초대는 현재 방의 POST에 요청과 취소 신호를 전달한다", async () => {
  // 준비
  const { service, calls } = fixture({ roomId: 7, createdNewGroupRoom: false, invitedMembers: [{ userId: 41 }] }, 201);
  const abort = new AbortController();

  // 실행
  await service.invite("7", targets, abort.signal);

  // 검증
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url.pathname, "/api/v1/chat/rooms/7/members/invitations");
  assert.equal(calls[0]?.method, "POST");
  assert.deepEqual(calls[0]?.body, { targetUserIds: [41], targetPublicIds: [] });
  assert.equal(calls[0]?.signal, abort.signal);
});

test("기존 그룹 초대 응답은 다른 방·새 그룹 생성·빈 결과·unsafe 사용자 ID를 거절한다", async () => {
  // 준비
  const valid = { roomId: 7, createdNewGroupRoom: false, invitedMembers: [{ userId: 41 }] };
  const invalid = [
    { ...valid, roomId: 8 }, { ...valid, createdNewGroupRoom: true },
    { ...valid, invitedMembers: [] }, { ...valid, invitedMembers: [{ userId: Number.MAX_SAFE_INTEGER + 1 }] },
  ];

  // 실행·검증
  for (const body of invalid) await assert.rejects(fixture(body).service.invite("7", targets), ChatContractError);
});

test("OPEN 나가기는 실제 joined 응답을 받고 과거 웹 DTO를 완료로 처리하지 않는다", async () => {
  // 준비
  const valid = fixture({ roomId: 7, joined: false, myRole: "MEMBER", myOpenProfile: { ...openMember, active: false } });
  const invalid = [{ roomId: 7, active: false, role: "MEMBER", profile: openMember }, { roomId: 8, joined: false }, { roomId: 7, joined: true }];

  // 실행
  await valid.service.leave("7");

  // 검증
  assert.equal(valid.calls[0]?.method, "DELETE");
  assert.equal(valid.calls[0]?.url.pathname, "/api/v1/chat/open-rooms/7/leave");
  assert.equal(valid.calls[0]?.body, null);
  for (const body of invalid) await assert.rejects(fixture(body).service.leave("7"), ChatContractError);
});

test("방 종료는 멤버십을 유지하는 CLOSED 상세 응답을 수락한다", async () => {
  // 준비
  const body = { id: 7, status: "CLOSED", joined: true, myRole: "OWNER", myOpenProfile: { ...openMember, role: "OWNER", active: true } };
  const { service, calls } = fixture(body);

  // 실행
  await service.close("7");

  // 검증
  assert.equal(calls[0]?.method, "POST");
  assert.equal(calls[0]?.url.pathname, "/api/v1/chat/open-rooms/7/close");
  assert.equal(calls[0]?.body, null);
  for (const invalid of [{ ...body, id: 8 }, { ...body, status: "ACTIVE" }, { id: 7, active: false }]) {
    await assert.rejects(fixture(invalid).service.close("7"), ChatContractError);
  }
});

test("방장 위임은 방별 멤버 ID를 사용하고 응답 방을 검증한다", async () => {
  // 준비
  const body = { id: 7, status: "ACTIVE", myRole: "MEMBER", ownerProfile: { ...openMember, role: "OWNER" } };
  const { service, calls } = fixture(body);

  // 실행
  await service.transfer("7", "21");

  // 검증
  assert.equal(calls[0]?.url.pathname, "/api/v1/chat/open-rooms/7/owner-transfer");
  assert.equal(calls[0]?.method, "POST");
  assert.deepEqual(calls[0]?.body, { targetOpenChatMemberId: 21 });
  for (const invalid of [
    { ...body, id: 8 }, { ...body, myRole: "OWNER" },
    { ...body, ownerProfile: { ...body.ownerProfile, openChatMemberId: 22 } },
    { ...body, ownerProfile: { ...body.ownerProfile, active: false } },
    { ...body, ownerProfile: { ...body.ownerProfile, role: "MEMBER" } },
  ]) {
    await assert.rejects(fixture(invalid).service.transfer("7", "21"), ChatContractError);
  }
});

test("관리자 지정과 해제는 POST와 DELETE를 구분하고 적용된 역할을 확인한다", async () => {
  // 준비
  const assign = fixture({ ...openMember, role: "ADMIN" });
  const revoke = fixture(openMember);

  // 실행
  await assign.service.changeAdmin("7", "21", true);
  await revoke.service.changeAdmin("7", "21", false);

  // 검증
  assert.equal(assign.calls[0]?.method, "POST");
  assert.equal(revoke.calls[0]?.method, "DELETE");
  assert.equal(assign.calls[0]?.url.pathname, "/api/v1/chat/open-rooms/7/admins/21");
  assert.equal(assign.calls[0]?.body, null);
  for (const body of [{ ...openMember, role: "ADMIN", openChatMemberId: 22 }, { ...openMember, role: "ADMIN", active: false }, openMember]) {
    await assert.rejects(fixture(body).service.changeAdmin("7", "21", true), ChatContractError);
  }
  await assert.rejects(fixture({ ...openMember, role: "ADMIN" }).service.changeAdmin("7", "21", false), ChatContractError);
});

test("강퇴 요청은 사유를 정리하고 대상 방·회원·활성 차단 응답을 확인한다", async () => {
  // 준비
  const { service, calls } = fixture(action);

  // 실행
  await service.ban("7", "21", " 운영 규칙 ");

  // 검증
  assert.equal(calls[0]?.url.pathname, "/api/v1/chat/open-rooms/7/bans");
  assert.equal(calls[0]?.method, "POST");
  assert.deepEqual(calls[0]?.body, { targetOpenChatMemberId: 21, reason: "운영 규칙" });
  for (const body of [{ ...action, roomId: 8 }, { ...action, targetOpenChatMemberId: 22 }, { ...action, active: false }, { ...action, banId: "9007199254740992" }]) {
    await assert.rejects(fixture(body).service.ban("7", "21", "사유"), ChatContractError);
  }
});

test("비어 있거나 너무 긴 강퇴 사유는 서버에 보내기 전에 거절한다", async () => {
  // 준비
  const { service, calls } = fixture(action);

  // 실행·검증
  for (const reason of ["", " \n ", "가".repeat(501)]) {
    await assert.rejects(service.ban("7", "21", reason), ManagementInputError);
  }
  assert.equal(calls.length, 0);
  assert.equal(banBody("21", "가".repeat(500)).reason.length, 500);
});

test("차단 해제는 ban ID로 PATCH하고 멤버 재입장을 별도로 실행하지 않는다", async () => {
  // 준비
  const { service, calls } = fixture({ ...action, active: false });

  // 실행
  await service.releaseBan("7", "91");

  // 검증
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.method, "PATCH");
  assert.equal(calls[0]?.url.pathname, "/api/v1/chat/open-rooms/7/bans/91/release");
  assert.equal(calls[0]?.body, null);
  for (const body of [{ ...action, roomId: 8, active: false }, { ...action, banId: 92, active: false }, action]) {
    await assert.rejects(fixture(body).service.releaseBan("7", "91"), ChatContractError);
  }
});

test("차단 목록은 cursor 쿼리로 다음 페이지를 요청하고 nextCursorId를 정규화한다", async () => {
  // 준비
  const { service, calls } = fixture({ items: [banItem, { ...banItem, banId: 90 }], hasNext: true, nextCursorId: 90 });

  // 실행
  const page = await service.bans("7", "92");

  // 검증
  assert.equal(calls[0]?.url.pathname, "/api/v1/chat/open-rooms/7/bans");
  assert.equal(calls[0]?.url.searchParams.get("cursor"), "92");
  assert.equal(calls[0]?.url.searchParams.has("cursorId"), false);
  assert.equal(calls[0]?.url.searchParams.get("size"), "20");
  assert.deepEqual(page.items.map(item => item.id), ["91", "90"]);
  assert.equal(page.nextCursor, "90");
  assert.equal(page.items[0]?.memberId, "21");
});

test("차단 페이지의 역순·중복·현재 커서 반복·불일치 nextCursor는 거절한다", () => {
  // 준비
  const invalid = [
    { items: [banItem, { ...banItem, banId: 92 }], hasNext: false, nextCursorId: null },
    { items: [banItem, banItem], hasNext: false, nextCursorId: null },
    { items: [{ ...banItem, banId: 92 }], hasNext: false, nextCursorId: null },
    { items: [banItem], hasNext: true, nextCursorId: 90 },
    { items: [banItem], hasNext: false, nextCursorId: 91 },
    { items: [], hasNext: true, nextCursorId: 91 },
    { items: [banItem], hasNext: true, nextCursorId: null },
    { items: Array.from({ length: 21 }, (_, index) => ({ ...banItem, banId: 91 - index })), hasNext: false, nextCursorId: null },
  ];

  // 실행·검증
  for (const page of invalid) assert.throws(() => parseBanPage(page, "92"), ChatContractError);
  assert.deepEqual(parseBanPage({ items: [], hasNext: false, nextCursorId: null }, null), { items: [], hasNext: false, nextCursor: null });
});

test("차단 목록은 unsafe ID와 잘못된 해제 가능 플래그를 거절한다", () => {
  // 준비
  const invalid = [{ ...banItem, banId: Number.MAX_SAFE_INTEGER + 1 }, { ...banItem, targetOpenChatMemberId: "021" }, { ...banItem, releasable: "true" }];

  // 실행·검증
  for (const item of invalid) assert.throws(() => parseBanPage({ items: [item], hasNext: false, nextCursorId: null }, null), ChatContractError);
});

test("경로와 요청 본문의 unsafe ID는 HTTP 전송 전에 차단한다", async () => {
  // 준비
  const { service, calls } = fixture({});
  const requests = [
    () => service.members("../7", false), () => service.members("9007199254740992", true),
    () => service.me("07"), () => service.invite("7", { userIds: ["../41"], publicIds: [] }),
    () => service.leave("0"), () => service.close("-7"), () => service.transfer("7", "9007199254740992"),
    () => service.changeAdmin("7", "../21", true), () => service.ban("7", "021", "사유"),
    () => service.bans("7", "../91"), () => service.releaseBan("7", "91?x=1"),
  ];

  // 실행·검증
  for (const request of requests) await assert.rejects(request(), ChatContractError);
  assert.equal(calls.length, 0);
});

test("실패한 관리 변경 요청은 네트워크·408·503·401에서도 자동 재전송하지 않는다", async () => {
  // 준비
  const mutations: ((service: RoomManagementService) => Promise<unknown>)[] = [
    service => service.invite("7", targets), service => service.leave("7"), service => service.close("7"),
    service => service.transfer("7", "21"), service => service.changeAdmin("7", "21", true),
    service => service.ban("7", "21", "사유"), service => service.releaseBan("7", "91"),
  ];

  // 실행·검증: 각 실패 경로는 독립 클라이언트에서 요청 한 번만 허용한다.
  for (const status of [0, 408, 503, 401]) {
    for (const mutation of mutations) {
      let count = 0;
      const service = createRoomManagementService(createApiClient({
        baseUrl: "https://fixture.invalid/api/v1", accessToken: async () => "synthetic-access",
        fetcher: async () => {
          count += 1;
          if (status === 0) throw new TypeError("synthetic transport failure");
          return new Response(JSON.stringify({ body: { errorCode: "SYNTHETIC_FAILURE" } }), { status });
        },
      }));
      await assert.rejects(mutation(service), ApiError);
      assert.equal(count, 1);
    }
  }
});

test("계정이 인증 토큰 대기 중 바뀌면 방장 위임을 보내지 않는다", async () => {
  // 준비
  let current = true;
  let requests = 0;
  let resolveToken!: (token: string) => void;
  const service = createRoomManagementService(createApiClient({
    baseUrl: "https://fixture.invalid/api/v1",
    assertCurrentSession: () => { if (!current) throw new ApiError(0, "SESSION_CHANGED"); },
    accessToken: () => new Promise(resolve => { resolveToken = resolve; }),
    fetcher: async () => { requests += 1; return new Response(JSON.stringify({ body: { id: 7 } })); },
  }));

  // 실행
  const pending = service.transfer("7", "21");
  current = false;
  resolveToken("synthetic-access");

  // 검증
  await assert.rejects(pending, { code: "SESSION_CHANGED" });
  assert.equal(requests, 0);
});
