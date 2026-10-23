import assert from "node:assert/strict";
import test from "node:test";

import { ApiError, createApiClient } from "../src/api/client.ts";
import { ChatContractError, parseRoom } from "../src/domain/chat/contracts.ts";
import type { ChatRoom } from "../src/domain/chat/types.ts";
import { parseAiMember, parseAiSafeProfile, parseAiSettings } from "../src/features/ai-chat/contracts.ts";
import { createAiRoomController, type AiRoomState } from "../src/features/ai-chat/controller.ts";
import { createAiService, type AiService } from "../src/features/ai-chat/service.ts";
import type { RoomConnection } from "../src/features/chat/controller.ts";

const roomDto = { id: 3, roomType: "OPEN", sourceType: "OPEN", myRole: "OWNER", name: "합성 방", active: true,
  memberCount: 2, unreadCount: 0, updatedAt: "2026-10-22T00:00:00Z" };
const input = { nickname: "합성 AI", bio: "합성 소개", originalLanguageCode: "ja", personaPrompt: "관리자 전용 합성 성격" };
const member = parseAiMember({ aiMemberId: 7, aiAgentId: 9, chatRoomId: 3, ...input, active: true, joinedAt: "2026-10-22" }, "3");
const settings = parseAiSettings({ chatRoomId: 3, aiEnabled: true, currentAiMemberCount: 1, maxAiMembersPerRoom: 3,
  disclosureType: "PUBLIC", mentionPermission: "ALL_MEMBERS", conversationEnabled: true, revivalEnabled: false }, "3");
const room = (myRole = "OWNER", closed = false): ChatRoom => ({ ...parseRoom({ ...roomDto, myRole }), closed });

function fakeService(overrides: Partial<AiService> = {}): AiService {
  return { room: async () => room(), settings: async () => settings,
    members: async () => ({ members: [member], currentCount: 1, maxCount: 3 }),
    profile: async () => parseAiSafeProfile(member), create: async () => member, update: async () => member,
    remove: async () => ({ ...member, active: false }), updateSettings: async () => settings, ...overrides };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
async function settle() {
  // 실제 네트워크·시간을 쓰지 않고 예약된 Promise 후속 처리만 완료한다.
  for (let i = 0; i < 30; i++) await Promise.resolve();
}
function fixture(service: AiService = fakeService(), isCurrent: () => boolean = () => true, scope = "realtime") {
  let handlers!: RoomConnection;
  let stopped = 0;
  let sequence = 0;
  const timers = new Map<number, { delay: number; callback: () => void }>();
  const snapshots: AiRoomState[] = [];
  const controller = createAiRoomController(service, "3", scope, isCurrent, state => snapshots.push(state), {
    connect: value => { handlers = value; return () => { stopped++; }; },
    schedule: (callback, delay) => {
      const id = ++sequence;
      timers.set(id, { callback, delay });
      return () => { timers.delete(id); };
    },
  });
  return { controller, snapshots, timers, socket: () => handlers, stopped: () => stopped,
    async tick(delay: number) {
      // 원하는 안전망·병합 타이머만 한 번 실행하고 새 주기 타이머는 그대로 남긴다.
      const next = [...timers].find(([, task]) => task.delay === delay);
      assert.ok(next, "예약된 지연 " + delay);
      timers.delete(next[0]);
      next[1].callback();
      await settle();
    } };
}

test("AI 관리 신호는 persona·설정·권한을 즉시 지우고 폭주를 한 GET으로 합친다", async () => {
  // 준비
  let role = "OWNER";
  let rooms = 0;
  let lists = 0;
  const f = fixture(fakeService({ room: async () => { rooms++; return room(role); },
    members: async () => { lists++; return { members: [member], currentCount: 1, maxCount: 3 }; } }));
  await f.controller.load();
  const previous = f.controller.getState().revision;
  assert.equal(f.socket().open, true);

  // 실행: 신호 자체에는 역할이 없으며 즉시 캐시부터 지운다.
  role = "MEMBER";
  f.socket().onEvent({ kind: "refresh", roomId: "99" });
  assert.equal(f.controller.getState().managementAvailable, true);
  for (let i = 0; i < 12; i++) f.socket().onEvent({ kind: "refresh", roomId: "3" });
  assert.equal(f.controller.getState().room, null);
  assert.equal(f.controller.getState().settings, null);
  assert.deepEqual(f.controller.getState().members, []);
  assert.equal(f.controller.getState().managementAvailable, false);
  assert.ok(f.controller.getState().revision > previous);
  await f.tick(75);

  // 검증
  assert.equal(rooms, 2);
  assert.equal(lists, 1);
  assert.equal(f.controller.getState().room?.myRole, "MEMBER");
  assert.equal(await f.controller.create(input), false);
  f.controller.dispose();
  assert.equal(f.timers.size, 0);
});

test("조회 중 강등 신호 뒤 도착한 persona 응답을 게시하지 않는다", async () => {
  // 준비
  const pending = deferred<Awaited<ReturnType<AiService["members"]>>>();
  let role = "OWNER";
  let lists = 0;
  const f = fixture(fakeService({ room: async () => room(role),
    members: async () => { lists++; return pending.promise; } }));
  const loading = f.controller.load();
  await settle();
  assert.equal(lists, 1);

  // 실행
  role = "MEMBER";
  f.socket().onEvent({ kind: "refresh", roomId: "3" });
  pending.resolve({ members: [member], currentCount: 1, maxCount: 3 });
  await loading;

  // 검증
  assert.equal(f.controller.getState().room?.myRole, "MEMBER");
  assert.ok(f.snapshots.every(state => state.members.length === 0));
  assert.equal(lists, 1);
  f.controller.dispose();
});

test("AI 생성·수정·삭제·설정은 각각 새 HTTP 강등을 확인하고 쓰기를 생략한다", async () => {
  // 준비
  const actions = [
    (controller: ReturnType<typeof createAiRoomController>) => controller.create(input),
    (controller: ReturnType<typeof createAiRoomController>) => controller.update("7", input),
    (controller: ReturnType<typeof createAiRoomController>) => controller.remove("7"),
    (controller: ReturnType<typeof createAiRoomController>) => controller.settings({ revivalEnabled: true }),
  ];
  for (const [index, action] of actions.entries()) {
    let role = "OWNER";
    let writes = 0;
    let reads = 0;
    const write = async () => { writes++; return member; };
    const f = fixture(fakeService({ room: async () => { reads++; return room(role); },
      create: write, update: write, remove: write, updateSettings: async () => { writes++; return settings; } }),
    () => true, "preflight-" + index);
    await f.controller.load();

    // 실행
    role = "MEMBER";
    assert.equal(await action(f.controller), false);

    // 검증: preflight와 이후 일반 참여자 재조회만 수행하고 변경은 한 번도 보내지 않는다.
    assert.equal(writes, 0);
    assert.equal(reads, 3);
    assert.equal(f.controller.getState().room?.myRole, "MEMBER");
    assert.deepEqual(f.controller.getState().members, []);
    f.controller.dispose();
  }
});

test("변경 preflight 중 역할 이벤트가 오면 이전 GET이 OWNER여도 쓰지 않는다", async () => {
  // 준비
  const pending = deferred<ChatRoom>();
  let reads = 0;
  let writes = 0;
  const f = fixture(fakeService({ room: async () => ++reads === 2 ? pending.promise : room(reads > 2 ? "MEMBER" : "OWNER"),
    create: async () => { writes++; return member; } }));
  await f.controller.load();
  const saving = f.controller.create(input);
  await settle();

  // 실행
  f.socket().onEvent({ kind: "refresh", roomId: "3" });
  pending.resolve(room());
  const saved = await saving;

  // 검증
  assert.equal(saved, false);
  assert.equal(writes, 0);
  assert.equal(f.controller.getState().room?.myRole, "MEMBER");
  assert.equal(f.controller.getState().busy, false);
  f.controller.dispose();
});

test("POST 중 강등은 자동 재전송 없이 저장 완료 뒤 최신 권한 GET까지 기다린다", async () => {
  // 준비
  const pendingWrite = deferred<typeof member>();
  const pendingRead = deferred<ChatRoom>();
  let reads = 0;
  let writes = 0;
  let finished = false;
  const f = fixture(fakeService({ room: async () => ++reads >= 3 ? pendingRead.promise : room(),
    create: async () => { writes++; return pendingWrite.promise; } }));
  await f.controller.load();
  const saving = f.controller.create(input).then(result => { finished = true; return result; });
  await settle();

  // 실행
  f.socket().onEvent({ kind: "refresh", roomId: "3" });
  assert.equal(f.controller.getState().managementAvailable, false);
  pendingWrite.resolve(member);
  await settle();
  assert.equal(finished, false);
  assert.equal(reads, 3);
  pendingRead.resolve(room("MEMBER"));
  const saved = await saving;

  // 검증
  assert.equal(saved, false);
  assert.equal(writes, 1);
  assert.equal(finished, true);
  assert.equal(f.controller.getState().room?.myRole, "MEMBER");
  assert.equal(f.controller.getState().busy, false);
  f.controller.dispose();
});

test("정상 30초 안전망은 초안을 보존하고 누락된 강등에서만 revision을 바꾼다", async () => {
  // 준비
  let role = "OWNER";
  let reads = 0;
  const f = fixture(fakeService({ room: async () => { reads++; return room(role); } }));
  await f.controller.load();
  const initial = f.controller.getState().revision;

  // 실행·검증: unchanged poll은 화면 편집 세대를 그대로 둔다.
  await f.tick(30000);
  assert.equal(f.controller.getState().revision, initial);
  assert.equal(f.controller.getState().managementAvailable, true);
  role = "MEMBER";
  await f.tick(30000);
  assert.ok(f.controller.getState().revision > initial);
  assert.equal(f.controller.getState().managementAvailable, false);
  assert.deepEqual(f.controller.getState().members, []);
  assert.equal(reads, 3);
  f.controller.dispose();
});

test("재연결은 즉시 이전 동의를 지우고 일반 채팅 이벤트는 재조회를 만들지 않는다", async () => {
  // 준비
  let role = "OWNER";
  let reads = 0;
  const f = fixture(fakeService({ room: async () => { reads++; return room(role); } }));
  await f.controller.load();
  const initial = f.controller.getState().revision;

  // 실행
  f.socket().onEvent({ kind: "read", roomId: "3", last: "1" });
  assert.equal(f.controller.getState().revision, initial);
  role = "MEMBER";
  f.socket().onStatus("DISCONNECTED");
  f.socket().onConnect();
  assert.equal(f.controller.getState().managementAvailable, false);
  await f.tick(75);

  // 검증
  assert.equal(reads, 2);
  assert.equal(f.controller.getState().room?.myRole, "MEMBER");
  f.controller.dispose();
});

test("CLOSED는 active:true여도 관리를 숨기고 퇴장과 구분하며 소켓·타이머를 닫는다", async () => {
  // 준비
  let closed = false;
  let reads = 0;
  const f = fixture(fakeService({ room: async () => { reads++; return room("OWNER", closed); } }));
  await f.controller.load();
  const oldSocket = f.socket();

  // 실행
  closed = true;
  oldSocket.onEvent({ kind: "refresh", roomId: "3" });
  await f.tick(75);
  oldSocket.onConnect();
  oldSocket.onEvent({ kind: "refresh", roomId: "3" });

  // 검증
  assert.equal(f.controller.getState().room?.active, true);
  assert.equal(f.controller.getState().room?.closed, true);
  assert.equal(f.controller.getState().accessLost, false);
  assert.match(f.controller.getState().notice ?? "", /종료된/);
  assert.equal(f.controller.getState().managementAvailable, false);
  assert.equal(f.stopped(), 1);
  assert.equal(f.timers.size, 0);
  assert.equal(await f.controller.load(), false);
  assert.equal(reads, 2);
  f.controller.dispose();
});

test("초기 CLOSED 화면은 새 소켓이나 AI 설정·persona 조회를 시작하지 않는다", async () => {
  // 준비
  let settingsReads = 0;
  const f = fixture(fakeService({ room: async () => room("OWNER", true),
    settings: async () => { settingsReads++; return settings; } }));

  // 실행
  await f.controller.load();

  // 검증
  assert.equal(f.socket(), undefined);
  assert.equal(settingsReads, 0);
  assert.equal(f.controller.getState().room?.closed, true);
  assert.equal(f.timers.size, 0);
  f.controller.dispose();
});

test("강퇴 뒤 방 GET 400은 참여 상실이고 목록 GET 400은 재확인 가능한 읽기 실패다", async () => {
  // 준비
  let banned = false;
  const f = fixture(fakeService({ room: async () => { if (banned) throw new ApiError(400, "HTTP_400"); return room(); } }));
  await f.controller.load();

  // 실행·검증: private 구독의 마지막 신호를 받아 방 GET으로 강퇴를 확정한다.
  banned = true;
  f.socket().onEvent({ kind: "refresh", roomId: "3" });
  await f.tick(75);
  assert.equal(f.controller.getState().accessLost, true);
  assert.match(f.controller.getState().notice ?? "", /참여하고 있지/);
  assert.equal(f.stopped(), 1);
  assert.equal(f.timers.size, 0);
  f.controller.dispose();

  // 준비·실행·검증: 다른 endpoint의 동일 HTTP 상태는 퇴장으로 확대하지 않는다.
  let denied = true;
  const other = fixture(fakeService({ members: async () => {
    if (denied) throw new ApiError(400, "HTTP_400");
    return { members: [member], currentCount: 1, maxCount: 3 };
  } }));
  await other.controller.load();
  assert.equal(other.controller.getState().accessLost, false);
  assert.equal(other.stopped(), 0);
  assert.match(other.controller.getState().error ?? "", /권한/);
  denied = false;
  await other.tick(1000);
  assert.equal(other.controller.getState().managementAvailable, true);
  other.controller.dispose();
});

test("읽기 실패는 persona를 비우고 backoff 후 복구하며 변경 요청을 만들지 않는다", async () => {
  // 준비
  let reads = 0;
  let writes = 0;
  const f = fixture(fakeService({ room: async () => {
    reads++;
    if (reads === 2 || reads === 3) throw new ApiError(503, "HTTP_503");
    return room();
  }, create: async () => { writes++; return member; } }));
  await f.controller.load();

  // 실행·검증
  await f.tick(30000);
  assert.equal(f.controller.getState().managementAvailable, false);
  assert.deepEqual(f.controller.getState().members, []);
  assert.equal(await f.controller.create(input), false);
  await f.tick(1000);
  await f.tick(2000);
  assert.equal(f.controller.getState().managementAvailable, true);
  assert.equal(writes, 0);
  f.controller.dispose();
});

test("preflight 네트워크 실패는 쓰기 불확실성이 아니며 캐시 권한을 폐기한다", async () => {
  // 준비
  let reads = 0;
  let writes = 0;
  const f = fixture(fakeService({ room: async () => {
    if (++reads === 2) throw new ApiError(0, "NETWORK_UNAVAILABLE");
    return room();
  }, create: async () => { writes++; return member; } }), () => true, "preflight-network");
  await f.controller.load();

  // 실행
  assert.equal(await f.controller.create(input), false);

  // 검증
  assert.equal(writes, 0);
  assert.equal(f.controller.getState().uncertain, false);
  assert.equal(f.controller.getState().managementAvailable, false);
  await f.tick(1000);
  assert.equal(f.controller.getState().managementAvailable, true);
  f.controller.dispose();
});

test("POST 결과 불명확 중 이벤트가 와도 재조회 뒤 uncertain을 유지하고 자동 재송신하지 않는다", async () => {
  // 준비
  const pending = deferred<typeof member>();
  let writes = 0;
  const f = fixture(fakeService({ create: async () => { writes++; return pending.promise; } }), () => true, "event-uncertain");
  await f.controller.load();
  const saving = f.controller.create(input);
  await settle();

  // 실행
  f.socket().onEvent({ kind: "refresh", roomId: "3" });
  pending.reject(new ApiError(503, "HTTP_503"));
  assert.equal(await saving, false);
  await f.tick(30000);

  // 검증
  assert.equal(f.controller.getState().uncertain, true);
  assert.equal(await f.controller.create(input), false);
  assert.equal(writes, 1);
  assert.equal(f.controller.acknowledge(), true);
  f.controller.dispose();
});

test("dispose·계정 전환 뒤 이전 소켓·예약 작업·늦은 persona 응답은 게시하지 않는다", async () => {
  // 준비
  let current = true;
  let readSignal: AbortSignal | undefined;
  const pending = deferred<Awaited<ReturnType<AiService["members"]>>>();
  const f = fixture(fakeService({ members: async (_id, signal) => { readSignal = signal; return pending.promise; } }), () => current);
  const loading = f.controller.load();
  await settle();
  const old = f.socket();

  // 실행
  current = false;
  f.controller.dispose();
  const count = f.snapshots.length;
  old.onConnect();
  old.onEvent({ kind: "refresh", roomId: "3" });
  pending.resolve({ members: [member], currentCount: 1, maxCount: 3 });
  await loading;

  // 검증
  assert.equal(readSignal?.aborted, true);
  assert.equal(f.snapshots.length, count);
  assert.equal(f.stopped(), 1);
  assert.equal(f.timers.size, 0);
  assert.equal(await f.controller.create(input), false);
});

test("AI room 서비스도 OPEN 상세 CLOSED를 확인하고 다른 방·알 수 없는 상태를 거절한다", async () => {
  // 준비
  const paths: string[] = [];
  let detail: unknown = { id: 3, status: "CLOSED" };
  const api = createApiClient({ baseUrl: "https://fixture.invalid/api/v1", accessToken: async () => "synthetic",
    fetcher: async url => {
      const path = new URL(String(url)).pathname;
      paths.push(path);
      return new Response(JSON.stringify({ body: path.endsWith("/chat/rooms/3") ? roomDto : detail }), { status: 200 });
    } });
  const service = createAiService(api);

  // 실행·검증
  const result = await service.room("3");
  assert.equal(result.active, true);
  assert.equal(result.closed, true);
  assert.deepEqual(paths, ["/api/v1/chat/rooms/3", "/api/v1/chat/open-rooms/3"]);
  detail = { id: 4, status: "ACTIVE" };
  await assert.rejects(service.room("3"), ChatContractError);
  detail = { id: 3, status: "UNKNOWN" };
  await assert.rejects(service.room("3"), ChatContractError);
});

test("변경 HTTP400은 강퇴로 단정하지 않고 새 권한 GET을 기다리며 재송신하지 않는다", async () => {
  // 준비
  let reads = 0;
  let writes = 0;
  const f = fixture(fakeService({ room: async () => room(++reads >= 3 ? "MEMBER" : "OWNER"),
    create: async () => { writes++; throw new ApiError(400, "HTTP_400"); } }));
  await f.controller.load();

  // 실행
  const saved = await f.controller.create(input);

  // 검증
  assert.equal(saved, false);
  assert.equal(writes, 1);
  assert.equal(reads, 3);
  assert.equal(f.controller.getState().room?.myRole, "MEMBER");
  assert.equal(f.controller.getState().accessLost, false);
  assert.equal(f.controller.getState().managementAvailable, false);
  assert.equal(f.controller.getState().uncertain, false);
  f.controller.dispose();
});

test("읽기 HTTP401은 퇴장 안내 대신 로그인 오류를 유지한다", async () => {
  // 준비·실행
  const f = fixture(fakeService({ room: async () => { throw new ApiError(401, "HTTP_401"); } }));
  await f.controller.load();

  // 검증
  assert.equal(f.controller.getState().accessLost, false);
  assert.equal(f.controller.getState().notice, null);
  assert.match(f.controller.getState().error ?? "", /로그인/);
  assert.equal(f.controller.getState().managementAvailable, false);
  f.controller.dispose();
});

test("무응답 persona GET은 15초에 취소하고 backoff로 복구한 뒤 늦은 응답을 버린다", async () => {
  // 준비
  const pending = deferred<Awaited<ReturnType<AiService["members"]>>>();
  let reads = 0;
  let pendingSignal: AbortSignal | undefined;
  const f = fixture(fakeService({ members: async (_id, signal) => {
    if (++reads === 1) { pendingSignal = signal; return pending.promise; }
    return { members: [member], currentCount: 1, maxCount: 3 };
  } }));
  const loading = f.controller.load();
  await settle();

  // 실행
  await f.tick(15000);
  assert.equal(await loading, false);
  assert.equal(pendingSignal?.aborted, true);
  assert.equal(f.controller.getState().loading, false);
  assert.equal(f.controller.getState().managementAvailable, false);
  await f.tick(1000);
  const count = f.snapshots.length;
  pending.resolve({ members: [{ ...member, nickname: "늦은 비공개 결과" }], currentCount: 1, maxCount: 3 });
  await settle();

  // 검증
  assert.equal(f.controller.getState().managementAvailable, true);
  assert.equal(f.controller.getState().members[0]?.nickname, member.nickname);
  assert.equal(f.snapshots.length, count);
  f.controller.dispose();
  assert.equal(f.timers.size, 0);
});

test("무응답 preflight와 이벤트가 겹쳐도 deadline 뒤 최신 GET을 읽고 POST는 보내지 않는다", async () => {
  // 준비
  const pending = deferred<ChatRoom>();
  let reads = 0;
  let writes = 0;
  let pendingSignal: AbortSignal | undefined;
  const f = fixture(fakeService({ room: async (_id, signal) => {
    reads++;
    if (reads === 2) { pendingSignal = signal; return pending.promise; }
    return room(reads > 2 ? "MEMBER" : "OWNER");
  }, create: async () => { writes++; return member; } }));
  await f.controller.load();
  const saving = f.controller.create(input);
  await settle();

  // 실행
  f.socket().onEvent({ kind: "refresh", roomId: "3" });
  await f.tick(15000);
  assert.equal(await saving, false);
  const count = f.snapshots.length;
  pending.resolve(room());
  await settle();

  // 검증
  assert.equal(pendingSignal?.aborted, true);
  assert.equal(writes, 0);
  assert.equal(f.controller.getState().room?.myRole, "MEMBER");
  assert.equal(f.controller.getState().busy, false);
  assert.equal(f.controller.getState().uncertain, false);
  assert.equal(f.snapshots.length, count);
  f.controller.dispose();
});

test("POST deadline은 uncertain을 보존하고 조회·재진입 중 생성 요청을 재전송하지 않는다", async () => {
  // 준비
  const pending = deferred<typeof member>();
  let writes = 0;
  const f = fixture(fakeService({ create: async () => { writes++; return pending.promise; } }), () => true, "post-deadline");
  await f.controller.load();
  const saving = f.controller.create(input);
  await settle();

  // 실행
  await f.tick(15000);
  assert.equal(await saving, false);
  await f.controller.load();

  // 검증
  assert.equal(f.controller.getState().uncertain, true);
  assert.equal(await f.controller.create(input), false);
  assert.equal(writes, 1);
  f.controller.dispose();
  const reopened = fixture(fakeService(), () => true, "post-deadline");
  assert.equal(reopened.controller.getState().uncertain, true);
  reopened.controller.dispose();
});

