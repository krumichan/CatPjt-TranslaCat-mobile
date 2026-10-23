import assert from "node:assert/strict";
import test from "node:test";

import { ApiError, createApiClient } from "../src/api/client.ts";
import { ChatContractError } from "../src/domain/chat/contracts.ts";
import type { OpenRoom } from "../src/domain/chat/types.ts";
import type { ChatService } from "../src/features/chat/service.ts";
import { invitationInput, parseInvitationPage, parseInvitationSummary, parseOpenInvitation } from "../src/features/open-invitations/contracts.ts";
import { createInvitationPreviewController } from "../src/features/open-invitations/preview-controller.ts";
import { createOpenInvitationService, type OpenInvitationService } from "../src/features/open-invitations/service.ts";
import { createRoomManagementController } from "../src/features/room-management/controller.ts";
import type { ManagedRoom, RoomMember } from "../src/features/room-management/contracts.ts";
import type { RoomManagementService } from "../src/features/room-management/service.ts";

const uuid = "00000000-0000-4000-8000-000000000001";
const secondUuid = "00000000-0000-4000-8000-000000000002";
const at = "2026-10-22T01:00:00+09:00";
const wire = { id: 100, notificationType: "CHAT_INVITATION", roomId: 9,
  payload: { schemaVersion: 1, invitationKind: "OPEN_LINK", roomType: "OPEN", roomName: "합성 방",
    inviterOpenNickname: "방별 초대자", inviterMemberCode: "OC-AAA", url: "https://evil.invalid", email: "private@example.invalid" },
  isRead: false, readAt: null, createdAt: at };
const invitation = parseOpenInvitation(wire);
const preview: OpenRoom = { id: "9", name: "최신 방 이름", description: "합성 설명", memberCount: 2, maxMemberCount: 10,
  joined: false, joinable: true, joinBlockedReason: "NONE", myOpenProfile: null };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  return { promise: new Promise<T>((done, fail) => { resolve = done; reject = fail; }), resolve, reject };
}
function apiFixture(replies: unknown[], status = 200) {
  const calls: { path: string; method: string; body: unknown; signal?: AbortSignal | null }[] = [];
  const api = createApiClient({ baseUrl: "https://fixture.invalid/api/v1", accessToken: async () => "synthetic-access",
    fetcher: async (url, options) => {
      const target = new URL(String(url));
      calls.push({ path: target.pathname + target.search, method: options?.method ?? "GET",
        body: options?.body ? JSON.parse(String(options.body)) : null, signal: options?.signal });
      return new Response(JSON.stringify({ body: replies.shift() }), { status });
    } });
  return { service: createOpenInvitationService(api), calls };
}

test("OPEN 초대는 방별 신원과 내부 방 ID만 파싱하고 임의 URL·계정 정보를 버린다", () => {
  // 준비·실행
  const item = parseOpenInvitation(wire);

  // 검증
  assert.equal(item.id, "100");
  assert.equal(item.roomId, "9");
  assert.equal(item.inviterNickname, "방별 초대자");
  assert.equal(JSON.stringify(item).includes("evil"), false);
  assert.equal(JSON.stringify(item).includes("private"), false);
  assert.equal(parseOpenInvitation({ ...wire, payload: { ...wire.payload, roomName: null } }).roomName, null);
});

test("레거시 GROUP 초대·잘못된 schema·손상 읽음·unsafe 식별자는 OPEN 수신함으로 섞이지 않는다", () => {
  // 준비
  const invalid = [{ ...wire, payload: { ...wire.payload, invitationKind: undefined } },
    { ...wire, payload: { ...wire.payload, roomType: "GROUP" } }, { ...wire, notificationType: "FRIEND_REQUEST" },
    { ...wire, payload: { ...wire.payload, schemaVersion: 2 } }, { ...wire, isRead: true, readAt: null },
    { ...wire, id: Number.MAX_SAFE_INTEGER + 1 }, { ...wire, roomId: "../chat" }, { ...wire, createdAt: "invalid" }];

  // 실행·검증
  for (const value of invalid) assert.throws(() => parseOpenInvitation(value), ChatContractError);
});

test("초대 페이지는 엄격한 내림차순과 마지막 cursor를 검증하고 빈 요약은 허용한다", () => {
  // 준비·실행
  const page = parseInvitationPage({ items: [wire, { ...wire, id: 98 }], nextCursorId: 98, hasNext: true }, null);
  const empty = parseInvitationSummary({ unreadCount: 0, latestInvitation: null });

  // 검증
  assert.equal(page.nextCursorId, "98");
  assert.equal(page.items.length, 2);
  assert.equal(empty.latestInvitation, null);
  assert.throws(() => parseInvitationPage({ items: [wire, wire], nextCursorId: null, hasNext: false }, null), ChatContractError);
  assert.throws(() => parseInvitationPage({ items: [wire], nextCursorId: 99, hasNext: true }, null), ChatContractError);
  assert.throws(() => parseInvitationPage({ items: [wire], nextCursorId: null, hasNext: false }, "99"), ChatContractError);
  assert.throws(() => parseInvitationSummary({ unreadCount: 1, latestInvitation: null }), ChatContractError);
});

test("초대 POST는 단일 public ID와 UUID만 사용하고 현재 GROUP 즉시가입 계약을 호출하지 않는다", async () => {
  // 준비
  const h = apiFixture([{ invitationId: 100, roomId: 9, createdAt: at, duplicate: false }]);
  const abort = new AbortController();

  // 실행
  await h.service.send("9", " account-1 ", uuid, abort.signal);

  // 검증
  assert.deepEqual(h.calls, [{ path: "/api/v1/chat/open-rooms/9/invitations", method: "POST",
    body: { targetPublicId: "account-1", requestId: uuid }, signal: abort.signal }]);
  for (const input of ["", " ", "a".repeat(256)]) assert.throws(() => invitationInput(input, uuid), ChatContractError);
  assert.deepEqual(invitationInput("  Legacy ID,one  ", uuid), { targetPublicId: "Legacy ID,one", requestId: uuid });
  assert.throws(() => invitationInput("account-1", "not-a-uuid"), ChatContractError);
});

test("초대 POST·단건·읽음 응답은 다른 방이나 다른 초대를 성공으로 처리하지 않는다", async () => {
  // 준비
  const sent = apiFixture([{ invitationId: 100, roomId: 10, createdAt: at, duplicate: false }]);
  const detail = apiFixture([{ ...wire, id: 101 }]);
  const read = apiFixture([{ ...wire, roomId: 10, isRead: true, readAt: at }]);

  // 실행·검증
  await assert.rejects(sent.service.send("9", "account-1", uuid), ChatContractError);
  await assert.rejects(detail.service.detail("100"), ChatContractError);
  await assert.rejects(read.service.read("100", "9"), ChatContractError);
});

test("계정 전용 목록·요약·단건·읽음은 API 경계와 취소 신호를 그대로 사용한다", async () => {
  // 준비
  const h = apiFixture([{ items: [{ ...wire, id: 98 }], nextCursorId: null, hasNext: false },
    { unreadCount: 1, latestInvitation: wire }, wire, { ...wire, isRead: true, readAt: at }]);
  const abort = new AbortController();

  // 실행
  await h.service.list("99", abort.signal);
  await h.service.summary(abort.signal);
  await h.service.detail("100", abort.signal);
  await h.service.read("100", "9", abort.signal);

  // 검증
  assert.deepEqual(h.calls.map(call => call.path), ["/api/v1/chat/open-invitations?size=20&cursorId=99",
    "/api/v1/chat/open-invitations/summary", "/api/v1/chat/open-invitations/100", "/api/v1/chat/open-invitations/100/read"]);
  assert.equal(h.calls[3].method, "PATCH");
  assert.equal(h.calls.every(call => call.signal === abort.signal), true);
});

let sequence = 0;
function setup(options: { detail?: OpenInvitationService["detail"]; room?: ChatService["openRoom"];
  read?: OpenInvitationService["read"]; join?: ChatService["join"]; timeoutMs?: number; scope?: string } = {}) {
  let current = true;
  const calls = { detail: 0, room: 0, read: 0, join: [] as (string | null)[], navigations: [] as string[] };
  const invitations = { detail: async (...args: Parameters<OpenInvitationService["detail"]>) => {
    calls.detail++; return options.detail ? options.detail(...args) : invitation;
  }, read: async (...args: Parameters<OpenInvitationService["read"]>) => {
    calls.read++; return options.read ? options.read(...args) : { ...invitation, isRead: true, readAt: at };
  } } as OpenInvitationService;
  const chat = { openRoom: async (...args: Parameters<ChatService["openRoom"]>) => {
    calls.room++; return options.room ? options.room(...args) : preview;
  }, join: async (...args: Parameters<ChatService["join"]>) => {
    calls.join.push(args[1]); return options.join ? options.join(...args) : { ...preview, joined: true, joinable: false };
  } } as ChatService;
  const controller = createInvitationPreviewController(invitations, chat, "100", options.scope ?? `preview-${++sequence}`,
    () => current, () => {}, room => calls.navigations.push(room), () => {}, options.timeoutMs ?? 1000);
  return { controller, calls, leave: () => { current = false; } };
}

test("받은 초대를 여는 것은 읽음과 방 미리보기만 처리하며 참여나 DIRECT 생성을 요청하지 않는다", async () => {
  // 준비·실행
  const h = setup();
  await h.controller.load();

  // 검증
  assert.equal(h.controller.getState().room?.name, "최신 방 이름");
  assert.equal(h.calls.read, 1);
  assert.deepEqual(h.calls.join, []);
  assert.deepEqual(h.calls.navigations, []);
  h.controller.dispose();
});

test("닉네임을 명시한 참여 버튼은 초대 소유권·현재 방을 재확인하고 한 번만 join한다", async () => {
  // 준비
  const h = setup();
  await h.controller.load();

  // 실행
  assert.equal(await h.controller.join("  방별 새 이름  "), true);

  // 검증
  assert.equal(h.calls.detail, 2);
  assert.equal(h.calls.room, 2);
  assert.deepEqual(h.calls.join, ["방별 새 이름"]);
  assert.deepEqual(h.calls.navigations, ["9"]);
  h.controller.dispose();
});

test("방이 닫힘·정원 초과·차단으로 바뀌면 과거 초대를 가지고 join하지 않는다", async () => {
  // 준비·실행
  for (const reason of ["ROOM_CLOSED", "ROOM_FULL", "BANNED"]) {
    let allowed = true;
    const h = setup({ room: async () => allowed ? preview : { ...preview, joinable: false, joinBlockedReason: reason } });
    await h.controller.load();
    allowed = false;
    const joined = await h.controller.join("새 이름");

    // 검증
    assert.equal(joined, false);
    assert.equal(h.calls.join.length, 0);
    assert.ok(h.controller.getState().notice);
    h.controller.dispose();
  }
});

test("수신권한이 사라진 초대와 다른 방 응답은 참여와 탐색을 모두 막는다", async () => {
  // 준비
  let owned = true;
  const denied = setup({ detail: async () => { if (!owned) throw new ApiError(400, "HTTP_400"); return invitation; } });
  const mismatched = setup({ room: async () => ({ ...preview, id: "10" }) });
  await denied.controller.load();
  owned = false;

  // 실행
  await denied.controller.join("이름");
  await mismatched.controller.load();

  // 검증
  assert.equal(denied.calls.join.length, 0);
  assert.equal(mismatched.controller.getState().room, null);
  assert.deepEqual(denied.calls.navigations, []);
  denied.controller.dispose(); mismatched.controller.dispose();
});

test("이전 방별 프로필의 재참여는 일반 계정 이름으로 덮어쓰지 않는다", async () => {
  // 준비
  const h = setup({ room: async () => ({ ...preview, myOpenProfile: { openChatMemberId: "50", nickname: "이전 방별 이름", memberCode: "OC-50", joinedAt: at } }) });
  await h.controller.load();

  // 실행·검증
  await h.controller.join("");
  assert.deepEqual(h.calls.join, [null]);
  h.controller.dispose();
});

test("이미 참여한 초대는 새 join 없이 기존 방만 열고 닉네임 없는 첫 참여는 차단한다", async () => {
  // 준비
  const joined = setup({ room: async () => ({ ...preview, joined: true }) });
  const fresh = setup();
  await joined.controller.load(); await fresh.controller.load();

  // 실행
  joined.controller.openJoined();
  await fresh.controller.join(" ");

  // 검증
  assert.deepEqual(joined.calls.navigations, ["9"]);
  assert.equal(joined.calls.join.length, 0);
  assert.equal(fresh.calls.join.length, 0);
  joined.controller.dispose(); fresh.controller.dispose();
});

test("읽음 PATCH 실패는 미리보기만 유지하고 join 성공으로 표시하지 않는다", async () => {
  // 준비
  const h = setup({ read: async () => { throw new ApiError(503, "HTTP_503"); } });

  // 실행
  await h.controller.load();

  // 검증
  assert.ok(h.controller.getState().room);
  assert.ok(h.controller.getState().notice);
  assert.equal(h.calls.join.length, 0);
  h.controller.dispose();
});

test("진행 중 조회 뒤 로그아웃·계정 변경·dispose가 오면 방 내용을 공개하지 않는다", async () => {
  // 준비
  const wait = deferred<OpenRoom>();
  const h = setup({ room: async () => wait.promise });
  const reading = h.controller.load();
  await tick();

  // 실행
  h.leave(); h.controller.dispose();
  wait.resolve(preview);
  await reading;

  // 검증
  assert.equal(h.controller.getState().room, null);
  assert.equal(h.calls.read, 0);
  assert.deepEqual(h.calls.navigations, []);
});

test("join 대기 중 이탈한 결과는 탐색하지 않고 같은 scope에 불확실 상태를 유지한다", async () => {
  // 준비
  const scope = `lost-${++sequence}`;
  const wait = deferred<OpenRoom>();
  const h = setup({ scope, join: async () => wait.promise });
  await h.controller.load();
  const joining = h.controller.join("이름");
  await tick();

  // 실행
  h.controller.dispose();
  wait.resolve({ ...preview, joined: true });
  await joining;
  const next = setup({ scope });
  await next.controller.load();

  // 검증
  assert.deepEqual(h.calls.navigations, []);
  assert.equal(next.controller.getState().uncertain, true);
  assert.equal(await next.controller.join("이름"), false);
  assert.equal(next.calls.join.length, 0);
  next.controller.dispose();
});

test("join 전송 실패는 자동 재전송하지 않고 새 조회에서 실제 참여가 확인되면 잠금을 푼다", async () => {
  // 준비
  let nowJoined = false;
  const h = setup({ room: async () => ({ ...preview, joined: nowJoined }), join: async () => { throw new ApiError(0, "NETWORK_UNAVAILABLE"); } });
  await h.controller.load();

  // 실행
  await h.controller.join("이름");
  await tick();
  assert.equal(await h.controller.join("이름"), false);
  nowJoined = true;
  await h.controller.load();

  // 검증
  assert.equal(h.calls.join.length, 1);
  assert.equal(h.controller.getState().uncertain, false);
  assert.equal(h.controller.getState().room?.joined, true);
  h.controller.dispose();
});

test("조회·join이 signal을 무시해도 deadline으로 대기를 끝내고 POST를 반복하지 않는다", async () => {
  // 준비
  const read = setup({ detail: () => new Promise(() => {}), timeoutMs: 5 });
  const send = setup({ join: () => new Promise(() => {}), timeoutMs: 5 });

  // 실행
  await read.controller.load();
  await send.controller.load();
  await send.controller.join("이름");

  // 검증
  assert.equal(read.controller.getState().loading, false);
  assert.ok(read.controller.getState().error);
  assert.equal(send.controller.getState().busy, false);
  assert.equal(send.controller.getState().uncertain, true);
  assert.equal(send.calls.join.length, 1);
  read.controller.dispose(); send.controller.dispose();
});

function manager(overrides: Partial<RoomManagementService> = {}, scope = `manager-${++sequence}`) {
  const room: ManagedRoom = { id: "9", roomType: "OPEN", sourceType: "OPEN", active: true, myRole: "MEMBER",
    name: "합성 방", memberCount: 1, unreadCount: 0, updatedAt: at, partner: null };
  const me: RoomMember = { id: "71", displayName: "방별 이름", publicId: null, memberCode: "OC-71", role: "MEMBER", active: true };
  const service: RoomManagementService = { room: async () => room, members: async () => [me], me: async () => me,
    friends: async () => [], bans: async () => ({ items: [], nextCursor: null, hasNext: false }),
    invite: async () => {}, leave: async () => {}, close: async () => {}, transfer: async () => {}, changeAdmin: async () => {},
    ban: async () => {}, releaseBan: async () => {}, sendOpenInvitation: async () => ({ invitationId: "100", roomId: "9", createdAt: at, duplicate: false }), ...overrides };
  return createRoomManagementController(service, "9", "1", scope, () => true, () => {}, 1000, { schedule: () => () => {} });
}

test("OPEN 일반 참여자도 초대를 보내되 불확실한 명시 재시도는 동일 UUID를 보존한다", async () => {
  // 준비
  const calls: string[] = [];
  let fail = true;
  const controller = manager({ sendOpenInvitation: async (_room, _target, request) => {
    calls.push(request);
    if (fail) throw new ApiError(0, "NETWORK_UNAVAILABLE");
    return { invitationId: "100", roomId: "9", createdAt: at, duplicate: true };
  } });
  await controller.load();

  // 실행: 불확실 결과는 명시적인 상태 재확인·해제 전에는 재전송하지 않는다.
  await controller.sendOpenInvitation("target-id", uuid);
  assert.equal(await controller.sendOpenInvitation("target-id", secondUuid), false);
  fail = false;
  await controller.load(); controller.acknowledge();
  assert.equal(await controller.sendOpenInvitation("target-id", secondUuid), true);

  // 검증
  assert.deepEqual(calls, [uuid, uuid]);
  assert.equal(controller.getState().uncertain, false);
  controller.dispose();
});

test("CLOSED preflight와 잘못된 단일 ID는 OPEN 초대 POST를 보내지 않는다", async () => {
  // 준비
  let writes = 0;
  let closed = false;
  const controller = manager({
    room: async () => ({ id: "9", roomType: "OPEN", sourceType: "OPEN", active: true, closed, myRole: "MEMBER",
      name: "합성 방", memberCount: 1, unreadCount: 0, updatedAt: at, partner: null }),
    sendOpenInvitation: async () => { writes++; throw new Error("unexpected"); },
  });
  await controller.load();

  // 실행·검증
  assert.equal(await controller.sendOpenInvitation(" ", uuid), false);
  closed = true;
  assert.equal(await controller.sendOpenInvitation("target-id", uuid), false);
  assert.equal(writes, 0);
  controller.dispose();
});

test("초대 전송 중 이탈 뒤 늦은 성공이 와도 다음 명시 확인은 원래 requestId를 재사용한다", async () => {
  // 준비
  const scope = `sender-late-${++sequence}`;
  const wait = deferred<Awaited<ReturnType<RoomManagementService["sendOpenInvitation"]>>>();
  const attempts: string[] = [];
  const first = manager({ sendOpenInvitation: async (_room, _target, id) => { attempts.push(id); return wait.promise; } }, scope);
  await first.load();
  const sending = first.sendOpenInvitation("target-id", uuid);
  await tick();

  // 실행
  first.dispose();
  wait.resolve({ invitationId: "100", roomId: "9", createdAt: at, duplicate: false });
  await sending;
  const next = manager({ sendOpenInvitation: async (_room, _target, id) => {
    attempts.push(id); return { invitationId: "100", roomId: "9", createdAt: at, duplicate: true };
  } }, scope);
  await next.load(); next.acknowledge();
  await next.sendOpenInvitation("target-id", secondUuid);

  // 검증
  assert.deepEqual(attempts, [uuid, uuid]);
  next.dispose();
});

test("A의 불확실 초대 뒤 B를 성공시켜도 A를 다시 확인할 때 원래 UUID를 보존한다", async () => {
  // 준비
  const calls: { target: string; request: string }[] = [];
  let first = true;
  const controller = manager({ sendOpenInvitation: async (_room, target, request) => {
    calls.push({ target, request });
    if (first) { first = false; throw new ApiError(0, "NETWORK_UNAVAILABLE"); }
    return { invitationId: target === "target-a" ? "100" : "101", roomId: "9", createdAt: at, duplicate: target === "target-a" };
  } });
  await controller.load();

  // 실행: 다른 대상의 성공은 아직 확인하지 못한 원래 대상의 시도 키를 지우지 않는다.
  await controller.sendOpenInvitation("target-a", uuid);
  await controller.load(); controller.acknowledge();
  await controller.sendOpenInvitation("target-b", secondUuid);
  await controller.sendOpenInvitation("target-a", "00000000-0000-4000-8000-000000000003");

  // 검증
  assert.deepEqual(calls, [{ target: "target-a", request: uuid }, { target: "target-b", request: secondUuid }, { target: "target-a", request: uuid }]);
  controller.dispose();
});
