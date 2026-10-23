import assert from "node:assert/strict";
import test from "node:test";

import { ApiError } from "../src/api/client.ts";
import type { ChatRoom } from "../src/domain/chat/types.ts";
import { capabilities, createRoomManagementController, memberActions } from "../src/features/room-management/controller.ts";
import type { RoomMember } from "../src/features/room-management/contracts.ts";
import type { RoomManagementService } from "../src/features/room-management/service.ts";

const room: ChatRoom = { id: "9", roomType: "OPEN", sourceType: "OPEN", name: "합성 방", myRole: "OWNER",
  active: true, memberCount: 2, unreadCount: 0, updatedAt: "2026-10-21T00:00:00Z", partner: null };
const me: RoomMember = { id: "71", displayName: "합성 방장", publicId: null, memberCode: "A", role: "OWNER", active: true };
const other: RoomMember = { ...me, id: "72", displayName: "합성 참여자", memberCode: "B", role: "MEMBER" };

function service(overrides: Partial<RoomManagementService> = {}): RoomManagementService {
  return { room: async () => room, members: async () => [me, other], me: async () => me, friends: async () => [],
    sendOpenInvitation: async () => ({ invitationId: "1", roomId: "9", createdAt: "2026-10-22T00:00:00Z", duplicate: false }),
    invite: async () => {}, leave: async () => {}, close: async () => {}, transfer: async () => {}, changeAdmin: async () => {},
    ban: async () => {}, releaseBan: async () => {}, bans: async () => ({ items: [], hasNext: false, nextCursor: null }), ...overrides };
}
let sequence = 0;
function setup(overrides: Partial<RoomManagementService> = {}, timeout = 1000) {
  let current = true;
  const controller = createRoomManagementController(service(overrides), "9", "1", `synthetic:${++sequence}`, () => current, () => {}, timeout);
  return { controller, leaveSession: () => { current = false; } };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>(done => { resolve = done; }), resolve: (value: T) => resolve(value) };
}

test("방·대상 권한 매트릭스는 OPEN 관리와 GROUP 관리자 초대를 구분한다", () => {
  // 준비·실행
  const group = { ...room, roomType: "GROUP" as const, sourceType: "FRIEND" };

  // 검증: 자신·방장·닫힌방·일반회원은 관리 대상을 만들지 않는다.
  assert.equal(capabilities(room).leave, false);
  assert.equal(capabilities({ ...room, myRole: "MEMBER" }).leave, true);
  assert.equal(capabilities(group).invite, true);
  assert.equal(capabilities({ ...group, myRole: "MEMBER" }).invite, false);
  assert.equal(capabilities({ ...group, sourceType: "AI" }).invite, false);
  assert.equal(capabilities({ ...group, roomType: "DIRECT" }).invite, false);
  assert.equal(capabilities(group).leave, false);
  assert.equal(memberActions(room, other, me.id).transfer, true);
  assert.equal(memberActions(room, { ...other, role: "ADMIN" }, me.id).revokeAdmin, true);
  for (const candidate of [me, { ...other, role: "OWNER" as const }, { ...other, active: false }]) {
    assert.equal(Object.values(memberActions(room, candidate, me.id)).some(Boolean), false);
  }
  assert.equal(memberActions({ ...room, myRole: "ADMIN" }, other, me.id).ban, true);
  assert.equal(memberActions({ ...room, myRole: "ADMIN" }, { ...other, role: "ADMIN" }, me.id).ban, false);
  assert.equal(Object.values(memberActions({ ...room, active: false }, other, me.id)).some(Boolean), false);
});

test("종료된 OPEN 방은 관리 쓰기를 막지만 일반 참여자의 나가기는 허용한다", async () => {
  // 준비
  const closed = { ...room, closed: true, myRole: "MEMBER" as const };
  const self = { ...me, role: "MEMBER" as const };
  const { controller } = setup({ room: async () => closed, me: async () => self, members: async () => [self, other] });
  await controller.load();

  // 실행·검증
  assert.equal(capabilities(closed).leave, true);
  assert.equal(capabilities(closed).share, false);
  assert.equal(capabilities({ ...closed, myRole: "OWNER" }).close, false);
  assert.equal(Object.values(memberActions({ ...closed, myRole: "OWNER" }, other, me.id)).some(Boolean), false);
  assert.equal(await controller.leave(), true);
  controller.dispose();
});

test("OPEN은 전역 userId가 아닌 현재 방 프로필 ID로 자신을 식별한다", async () => {
  // 준비·실행
  const { controller } = setup();
  await controller.load();

  // 검증
  assert.equal(controller.getState().myMemberId, "71");
  assert.equal(controller.getState().ready, true);
  assert.equal(await controller.ban("71", "합성 사유"), false);
  controller.dispose();
});

test("일관되지 않은 자기 프로필이나 역할은 관리 권한을 열지 않는다", async () => {
  // 준비·실행
  for (const member of [{ ...me, id: "80" }, { ...me, role: "MEMBER" as const }]) {
    const { controller } = setup({ me: async () => member });
    await controller.load();

    // 검증
    assert.equal(controller.getState().ready, false);
    assert.equal(controller.getState().members.length, 0);
    assert.equal(await controller.close(), false);
    controller.dispose();
  }
});

test("조회 중 중복 새로고침은 한 번만 요청한다", async () => {
  // 준비
  const wait = deferred<ChatRoom>();
  let reads = 0;
  const { controller } = setup({ room: () => { reads++; return wait.promise; } });

  // 실행·검증
  const first = controller.load();
  assert.equal(await controller.load(), false);
  wait.resolve(room);
  await first;
  assert.equal(reads, 1);
  controller.dispose();
});

test("계정 전환 뒤 늦게 도착한 목록은 이전 계정 신원과 권한을 공개하지 않는다", async () => {
  // 준비
  const wait = deferred<RoomMember[]>();
  const { controller, leaveSession } = setup({ members: () => wait.promise });
  const load = controller.load();
  await new Promise(done => setTimeout(done, 0));

  // 실행
  leaveSession();
  const snapshot = controller.getState();
  wait.resolve([me, other]);
  await load;

  // 검증
  assert.equal(controller.getState(), snapshot);
  assert.equal(controller.getState().ready, false);
  controller.dispose();
});

test("확인 창을 연 뒤 관리자 권한이 사라지면 변경 POST를 보내지 않는다", async () => {
  // 준비
  let allowed = true;
  let writes = 0;
  const { controller } = setup({ room: async () => ({ ...room, myRole: allowed ? "OWNER" : "MEMBER" }), close: async () => { writes++; } });
  await controller.load();

  // 실행·검증
  allowed = false;
  assert.equal(await controller.close(), false);
  assert.equal(writes, 0);
  assert.equal(controller.getState().uncertain, false);
  controller.dispose();
});

test("나가기 성공 응답 후에만 목록 복귀를 허용한다", async () => {
  // 준비
  const memberRoom = { ...room, myRole: "MEMBER" as const };
  const memberMe = { ...me, role: "MEMBER" as const };
  const wait = deferred<void>();
  const { controller } = setup({ room: async () => memberRoom, me: async () => memberMe,
    members: async () => [memberMe, other], leave: () => wait.promise });
  await controller.load();

  // 실행·검증
  const leave = controller.leave();
  assert.equal(controller.getState().exited, false);
  wait.resolve();
  assert.equal(await leave, true);
  assert.equal(controller.getState().exited, true);
  assert.equal(await controller.load(), false);
  controller.dispose();
});

test("방장 위임 후 본인 역할을 재조회하고 나가기 권한을 갱신한다", async () => {
  // 준비
  let transferred = false;
  const self = () => ({ ...me, role: transferred ? "MEMBER" as const : "OWNER" as const });
  const { controller } = setup({ room: async () => ({ ...room, myRole: self().role }), me: async () => self(),
    members: async () => [self(), { ...other, role: transferred ? "OWNER" : "MEMBER" }], transfer: async () => { transferred = true; } });
  await controller.load();

  // 실행·검증
  assert.equal(await controller.transfer("72"), true);
  assert.equal(controller.getState().room?.myRole, "MEMBER");
  assert.equal(capabilities(controller.getState().room).leave, true);
  assert.equal(controller.getState().exited, false);
  controller.dispose();
});

test("변경 결과를 잃으면 중복 전송을 잠그고 재조회 후 명시적 확인이 필요하다", async () => {
  // 준비
  let writes = 0;
  const { controller } = setup({ ban: async () => { writes++; throw new ApiError(0, "NETWORK_UNAVAILABLE"); } });
  await controller.load();

  // 실행·검증
  assert.equal(await controller.ban("72", "합성 사유"), false);
  assert.equal(controller.getState().uncertain, true);
  assert.equal(controller.acknowledge(), false);
  assert.equal(await controller.ban("72", "합성 사유"), false);
  await controller.load();
  assert.equal(controller.getState().uncertain, true);
  assert.equal(controller.acknowledge(), true);
  assert.equal(writes, 1);
  controller.dispose();
});

test("처리 중 두 번 누르기와 타임아웃 뒤 늦은 성공은 종료·중복 전송을 일으키지 않는다", async () => {
  // 준비
  let writes = 0;
  const wait = deferred<void>();
  const { controller } = setup({ close: () => { writes++; return wait.promise; } }, 10);
  await controller.load();

  // 실행
  const close = controller.close();
  assert.equal(await controller.close(), false);
  assert.equal(await close, false);
  wait.resolve();
  await new Promise(done => setTimeout(done, 0));

  // 검증
  assert.equal(writes, 1);
  assert.equal(controller.getState().exited, false);
  assert.equal(controller.getState().uncertain, true);
  controller.dispose();
});

test("화면 이탈 중 변경 요청은 같은 세션·방을 다시 열어도 불확실 상태를 유지한다", async () => {
  // 준비
  let started!: () => void;
  const began = new Promise<void>(resolve => { started = resolve; });
  const wait = deferred<void>();
  const api = service({ close: () => { started(); return wait.promise; } });
  const key = `leave:${++sequence}`;
  const first = createRoomManagementController(api, "9", "1", key, () => true, () => {});
  await first.load();

  // 실행
  const close = first.close();
  await began;
  first.dispose();
  await close;
  const second = createRoomManagementController(api, "9", "1", key, () => true, () => {});
  await second.load();

  // 검증
  assert.equal(second.getState().uncertain, true);
  assert.equal(await second.close(), false);
  wait.resolve();
  second.dispose();
});

test("친구 조회 실패도 기존 참여자와 ID 초대 기능을 유지하되 현재 참여자는 거절한다", async () => {
  // 준비
  const group = { ...room, roomType: "GROUP" as const, sourceType: "FRIEND" };
  const myself = { ...me, id: "1", publicId: "my-id" };
  let writes = 0;
  const { controller } = setup({ room: async () => group, members: async () => [myself], friends: async () => { throw new Error(); },
    invite: async () => { writes++; } });
  await controller.load();

  // 실행·검증
  assert.equal(controller.getState().ready, true);
  assert.ok(controller.getState().friendsError);
  assert.equal(await controller.invite({ userIds: ["1"], publicIds: [] }), false);
  await controller.load();
  assert.equal(await controller.invite({ userIds: [], publicIds: ["new-id"] }), true);
  assert.equal(writes, 1);
  controller.dispose();
});

test("차단 해제는 서버 releasable과 현재 방 상태를 확인한다", async () => {
  // 준비
  let writes = 0;
  const { controller } = setup({ bans: async () => ({ items: [{ id: "2", memberId: "80", displayName: "합성",
    memberCode: "C", reason: "합성 사유", releasable: false }], hasNext: false, nextCursor: null }),
    releaseBan: async () => { writes++; } });
  await controller.load();

  // 실행·검증
  assert.equal(await controller.releaseBan("2"), false);
  assert.equal(writes, 0);
  controller.dispose();
});
