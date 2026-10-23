import assert from "node:assert/strict";
import test from "node:test";

import { ApiError } from "../src/api/client.ts";
import { capabilities, createRoomManagementController, memberActions, type RoomManagementConnection, type RoomManagementState } from "../src/features/room-management/controller.ts";
import type { ManagedRoom, RoomMember } from "../src/features/room-management/contracts.ts";
import type { RoomManagementService } from "../src/features/room-management/service.ts";

const room: ManagedRoom = { id: "9", roomType: "OPEN", sourceType: "OPEN", name: "합성 실시간 방", myRole: "OWNER",
  active: true, memberCount: 2, unreadCount: 0, updatedAt: "2026-10-22T00:00:00Z", partner: null };
const self: RoomMember = { id: "71", displayName: "합성 본인", publicId: null, memberCode: "A", role: "OWNER", active: true };
const target: RoomMember = { ...self, id: "72", displayName: "합성 대상", memberCode: "B", role: "MEMBER" };
const ban = { id: "90", memberId: "80", displayName: "합성 차단", memberCode: "C", reason: "합성 사유", releasable: true };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  return { promise: new Promise<T>((done, fail) => { resolve = done; reject = fail; }), resolve, reject };
}
const settle = () => new Promise<void>(done => setImmediate(done));

function scheduler() {
  // 취소된 콜백도 보존하여 실제 타이머 경합처럼 늦은 실행을 별도로 검증한다.
  const jobs: { callback: () => void; delay: number; cancelled: boolean; fired: boolean }[] = [];
  return {
    jobs,
    schedule: (callback: () => void, delay: number) => {
      const job = { callback, delay, cancelled: false, fired: false };
      jobs.push(job);
      return () => { job.cancelled = true; };
    },
    pending: () => jobs.filter(job => !job.cancelled && !job.fired),
    run: async (delay: number) => {
      const job = jobs.find(candidate => !candidate.cancelled && !candidate.fired && candidate.delay === delay);
      assert.ok(job, `${delay}ms 예약이 있어야 한다`);
      job.fired = true;
      job.callback();
      await settle();
    },
  };
}

interface Model { room: ManagedRoom; self: RoomMember; target: RoomMember; roomError: unknown }
let sequence = 0;
function setup(overrides: (model: Model) => Partial<RoomManagementService> = () => ({}), scope = `realtime:${++sequence}`) {
  // 준비: 연결·시계·서비스를 실제 controller에 주입하고 상태 공개를 기록한다.
  const model: Model = { room: { ...room }, self: { ...self }, target: { ...target }, roomError: null };
  const calls = { room: 0, members: 0, me: 0, bans: 0, writes: 0, connects: 0, stops: 0 };
  const api: RoomManagementService = {
    room: async () => { calls.room++; if (model.roomError) throw model.roomError; return { ...model.room }; },
    members: async () => { calls.members++; return [{ ...model.self }, { ...model.target }]; },
    me: async () => { calls.me++; return { ...model.self }; },
    friends: async () => [],
    sendOpenInvitation: async () => ({ invitationId: "1", roomId: "9", createdAt: "2026-10-22T00:00:00Z", duplicate: false }),
    bans: async () => { calls.bans++; return { items: [ban], hasNext: false, nextCursor: null }; },
    invite: async () => { calls.writes++; }, leave: async () => { calls.writes++; }, close: async () => { calls.writes++; },
    transfer: async () => { calls.writes++; }, changeAdmin: async () => { calls.writes++; },
    ban: async () => { calls.writes++; }, releaseBan: async () => { calls.writes++; }, ...overrides(model),
  };
  const clock = scheduler();
  const snapshots: RoomManagementState[] = [];
  let handlers: RoomManagementConnection | null = null;
  let current = true;
  const controller = createRoomManagementController(api, "9", "1", scope, () => current,
    state => { snapshots.push(state); }, 1000, {
      connect: connection => { calls.connects++; handlers = connection; return () => { calls.stops++; }; },
      schedule: clock.schedule,
    });
  return {
    controller, api, model, calls, clock, snapshots,
    connection: () => { assert.ok(handlers); return handlers; },
    changeRole: (role: RoomMember["role"]) => { model.room.myRole = role; model.self.role = role; },
    changeSession: () => { current = false; },
    refresh: () => { assert.ok(handlers); handlers.onEvent({ kind: "refresh", roomId: "9" }); },
  };
}

test("외부 관리자 권한 회수는 즉시 확인창 세대와 민감 목록을 폐기하고 GET 역할만 반영한다", async () => {
  // 준비
  const h = setup();
  await h.controller.load();
  assert.equal(h.connection().open, true);
  assert.equal(h.controller.getState().bans.length, 1);

  // 실행: 이벤트에는 권한을 싣지 않고 서버 모델만 변경한다.
  h.changeRole("MEMBER");
  const revision = h.controller.getState().revision;
  h.refresh();
  assert.equal(h.controller.getState().revision, revision + 1);
  assert.equal(h.controller.getState().ready, false);
  assert.equal(h.controller.getState().room, null);
  assert.deepEqual(h.controller.getState().bans, []);
  assert.deepEqual(h.controller.getState().members, []);
  assert.equal(await h.controller.ban("72", "합성 사유"), false);
  await h.clock.run(50);

  // 검증
  assert.equal(h.controller.getState().room?.myRole, "MEMBER");
  assert.equal(h.controller.getState().ready, true);
  assert.equal(capabilities(h.controller.getState().room).bans, false);
  assert.equal(h.calls.room, 2);
  assert.equal(h.calls.writes, 0);
  h.controller.dispose();
});

test("짧은 관리 이벤트 폭주는 즉시 모두 무효화하되 GET은 한 묶음으로 합친다", async () => {
  // 준비
  const h = setup();
  await h.controller.load();

  // 실행
  for (let index = 0; index < 100; index++) h.refresh();
  assert.equal(h.controller.getState().revision, 100);
  assert.equal(h.clock.pending().length, 1);
  await h.clock.run(50);

  // 검증
  assert.equal(h.calls.room, 2);
  assert.equal(h.calls.members, 2);
  assert.equal(h.calls.connects, 1);
  assert.equal(h.calls.writes, 0);
  assert.equal(h.controller.getState().ready, true);
  h.controller.dispose();
});

test("조회 await 중 이벤트가 오면 오래된 역할을 공개하지 않고 최신 조회 한 번만 대기한다", async () => {
  // 준비
  const wait = deferred<RoomMember[]>();
  let blockMembers = false;
  const h = setup(model => ({ members: async () => blockMembers ? wait.promise : [{ ...model.self }, { ...model.target }] }));
  await h.controller.load();
  blockMembers = true;
  const loading = h.controller.load();
  await settle();

  // 실행: 진행 중 조회가 OWNER 목록을 반환하더라도 다음 조회만 공개할 수 있다.
  h.changeRole("MEMBER");
  const fromEvent = h.snapshots.length;
  for (let index = 0; index < 30; index++) h.refresh();
  blockMembers = false;
  wait.resolve([{ ...self }, { ...target }]);
  assert.equal(await loading, true);

  // 검증
  assert.equal(h.calls.room, 3);
  assert.equal(h.controller.getState().room?.myRole, "MEMBER");
  assert.equal(h.snapshots.slice(fromEvent).some(state => state.ready && state.room?.myRole === "OWNER"), false);
  assert.deepEqual(h.clock.pending().map(job => job.delay), [30000]);
  h.controller.dispose();
});

test("mutation preflight GET 중 이벤트가 오면 과거 권한 응답으로 POST하지 않는다", async () => {
  // 준비
  const wait = deferred<ManagedRoom>();
  let reads = 0;
  let writes = 0;
  const h = setup(model => ({ room: async () => ++reads === 2 ? wait.promise : { ...model.room },
    changeAdmin: async () => { writes++; } }));
  await h.controller.load();
  const changing = h.controller.assignAdmin("72");
  await settle();

  // 실행
  h.changeRole("MEMBER");
  h.refresh();
  wait.resolve({ ...room });
  assert.equal(await changing, false);

  // 검증
  assert.equal(writes, 0);
  assert.equal(reads, 3);
  assert.equal(h.controller.getState().ready, true);
  assert.equal(h.controller.getState().room?.myRole, "MEMBER");
  h.controller.dispose();
});

test("진행 중 POST에 이벤트가 겹치면 완료 후 최신 권한만 조회하고 POST는 재전송하지 않는다", async () => {
  // 준비
  const wait = deferred<void>();
  let writes = 0;
  const h = setup(() => ({ changeAdmin: () => { writes++; return wait.promise; } }));
  await h.controller.load();
  const changing = h.controller.assignAdmin("72");
  await settle();
  assert.equal(writes, 1);

  // 실행
  h.changeRole("MEMBER");
  for (let index = 0; index < 20; index++) h.refresh();
  assert.equal(h.controller.getState().ready, false);
  assert.equal(h.clock.pending().length, 0);
  wait.resolve();
  assert.equal(await changing, true);

  // 검증
  assert.equal(writes, 1);
  assert.equal(h.calls.room, 3);
  assert.equal(h.controller.getState().room?.myRole, "MEMBER");
  assert.equal(h.controller.getState().busy, false);
  assert.equal(h.controller.getState().ready, true);
  h.controller.dispose();
});

test("이벤트와 결과 불명 POST 실패가 겹쳐도 권한 재조회 뒤 불확실 잠금과 단일 전송을 유지한다", async () => {
  // 준비
  const wait = deferred<void>();
  let writes = 0;
  const h = setup(() => ({ ban: () => { writes++; return wait.promise; } }));
  await h.controller.load();
  const changing = h.controller.ban("72", "합성 사유");
  await settle();

  // 실행
  h.refresh();
  wait.reject(new ApiError(0, "NETWORK_UNAVAILABLE"));
  assert.equal(await changing, false);
  assert.equal(await h.controller.ban("72", "합성 사유"), false);
  await h.clock.run(30000);

  // 검증
  assert.equal(writes, 1);
  assert.equal(h.controller.getState().uncertain, true);
  assert.equal(h.controller.getState().ready, true);
  assert.equal(h.controller.acknowledge(), true);
  h.controller.dispose();
});

test("강퇴 후 room GET 접근 거부 또는 비활성 상태는 목록과 연결·타이머를 정리한다", async () => {
  // 준비·실행: room 접근 결과만 퇴장 근거로 사용한다.
  for (const error of [new ApiError(400, "HTTP_400"), new ApiError(403, "HTTP_ERROR"), new ApiError(404, "HTTP_ERROR"), null]) {
    const h = setup();
    await h.controller.load();
    if (error) h.model.roomError = error;
    else h.model.room.active = false;
    h.refresh();
    await h.clock.run(50);

    // 검증: 마지막 private 이벤트 이후 들어오는 늦은 콜백도 종료를 뒤집지 않는다.
    const ended = h.controller.getState();
    assert.equal(ended.exited, true);
    assert.equal(ended.room, null);
    assert.deepEqual(ended.members, []);
    assert.deepEqual(ended.bans, []);
    assert.equal(h.calls.stops, 1);
    assert.equal(h.clock.pending().length, 0);
    h.connection().onConnect();
    h.refresh();
    assert.equal(h.controller.getState(), ended);
    assert.equal(h.calls.writes, 0);
    h.controller.dispose();
  }
});

test("외부 CLOSED는 자동 퇴장·종료 POST 없이 읽기와 ADMIN 나가기를 유지한다", async () => {
  // 준비
  const h = setup();
  h.changeRole("ADMIN");
  await h.controller.load();

  // 실행
  h.model.room.closed = true;
  h.refresh();
  await h.clock.run(50);

  // 검증
  const state = h.controller.getState();
  assert.equal(state.exited, false);
  assert.equal(state.ready, true);
  assert.equal(state.room?.closed, true);
  assert.match(state.notice ?? "", /종료/);
  assert.equal(capabilities(state.room).leave, true);
  assert.equal(capabilities(state.room).bans, false);
  assert.equal(Object.values(memberActions(state.room, target, self.id)).some(Boolean), false);
  assert.deepEqual(state.bans, []);
  assert.equal(h.calls.stops, 1);
  const closedState = h.controller.getState();
  h.connection().onConnect();
  h.refresh();
  assert.equal(h.controller.getState(), closedState);
  assert.equal(h.calls.writes, 0);
  assert.equal(await h.controller.close(), false);
  await h.controller.load();
  assert.equal(await h.controller.leave(), true);
  assert.equal(h.calls.writes, 1);
  h.controller.dispose();
});

test("직접 종료 성공은 기존 명시적 목록 복귀를 유지한다", async () => {
  // 준비
  const h = setup();
  await h.controller.load();

  // 실행·검증
  assert.equal(await h.controller.close(), true);
  assert.equal(h.controller.getState().exited, true);
  assert.equal(h.calls.writes, 1);
  assert.equal(h.calls.stops, 1);
  assert.equal(h.clock.pending().length, 0);
  h.controller.dispose();
});

test("재연결은 누락된 역할 변경을 GET으로 회복하고 기존 연결을 중복 생성하지 않는다", async () => {
  // 준비
  const h = setup();
  await h.controller.load();

  // 실행: 토픽 이벤트 없이 서버 역할이 변경된다.
  h.changeRole("ADMIN");
  h.connection().onConnect();
  assert.equal(h.controller.getState().ready, false);
  await h.clock.run(50);
  h.changeRole("MEMBER");
  h.connection().onStatus("DISCONNECTED");
  h.connection().onStatus("CONNECTED");
  h.connection().onConnect();
  await h.clock.run(50);

  // 검증
  assert.equal(h.controller.getState().room?.myRole, "MEMBER");
  assert.equal(h.calls.room, 3);
  assert.equal(h.calls.connects, 1);
  assert.equal(h.calls.writes, 0);
  h.controller.dispose();
});

test("일시적인 읽기 실패는 권한을 잠그고 GET backoff 뒤 복구하며 POST를 만들지 않는다", async () => {
  // 준비
  const h = setup();
  await h.controller.load();
  h.model.roomError = new ApiError(503, "HTTP_ERROR");

  // 실행: 첫 실패 1초, 다음 실패 2초를 기다리고 권한을 다시 읽는다.
  h.refresh();
  await h.clock.run(50);
  assert.equal(h.controller.getState().ready, false);
  assert.equal(h.controller.getState().exited, false);
  assert.deepEqual(h.clock.pending().map(job => job.delay), [1000]);
  await h.clock.run(1000);
  assert.deepEqual(h.clock.pending().map(job => job.delay), [2000]);
  h.model.roomError = null;
  h.changeRole("MEMBER");
  await h.clock.run(2000);

  // 검증
  assert.equal(h.controller.getState().ready, true);
  assert.equal(h.controller.getState().error, null);
  assert.equal(h.controller.getState().room?.myRole, "MEMBER");
  assert.deepEqual(h.clock.pending().map(job => job.delay), [30000]);
  assert.equal(h.calls.writes, 0);
  h.controller.dispose();
});

test("이벤트가 누락되어도 30초 안전망은 최신 서버 권한으로 수렴한다", async () => {
  // 준비
  const h = setup();
  await h.controller.load();
  h.changeRole("MEMBER");

  // 실행
  const revision = h.controller.getState().revision;
  await h.clock.run(30000);
  assert.equal(h.controller.getState().revision, revision + 1);

  // 검증
  assert.equal(h.controller.getState().room?.myRole, "MEMBER");
  assert.equal(h.calls.room, 2);
  assert.equal(h.calls.writes, 0);
  h.controller.dispose();
});

test("다른 방·읽음 이벤트는 관리 상태와 조회 예약에 영향을 주지 않는다", async () => {
  // 준비
  const h = setup();
  await h.controller.load();
  const before = h.controller.getState();
  const pending = h.clock.pending();

  // 실행
  h.connection().onEvent({ kind: "refresh", roomId: "10" });
  h.connection().onEvent({ kind: "read", roomId: "9", last: "100" });

  // 검증
  assert.equal(h.controller.getState(), before);
  assert.deepEqual(h.clock.pending(), pending);
  assert.equal(h.calls.room, 1);
  h.controller.dispose();
});

test("bans 403은 새 room·members·me를 확인하여 권한 회수를 반영하고 퇴장으로 오판하지 않는다", async () => {
  // 준비
  let reads = 0;
  const h = setup(model => ({ bans: async () => {
    if (++reads === 1) return { items: [ban], hasNext: false, nextCursor: null };
    model.room.myRole = "MEMBER";
    model.self.role = "MEMBER";
    throw new ApiError(403, "HTTP_ERROR");
  } }));
  await h.controller.load();

  // 실행
  h.refresh();
  await h.clock.run(50);

  // 검증
  assert.equal(h.controller.getState().exited, false);
  assert.equal(h.controller.getState().ready, true);
  assert.equal(h.controller.getState().room?.myRole, "MEMBER");
  assert.equal(h.controller.getState().bansError, null);
  assert.deepEqual(h.controller.getState().bans, []);
  assert.equal(h.calls.room, 3);
  assert.equal(reads, 2);
  h.controller.dispose();
});

test("잘못된 bans 403이 반복되어도 재확인 한 번 뒤 부가 오류로 남고 무한 조회·퇴장은 없다", async () => {
  // 준비
  let bans = 0;
  const h = setup(() => ({ bans: async () => { bans++; throw new ApiError(403, "HTTP_ERROR"); } }));

  // 실행
  assert.equal(await h.controller.load(), true);

  // 검증
  assert.equal(h.controller.getState().room?.myRole, "OWNER");
  assert.equal(h.controller.getState().exited, false);
  assert.ok(h.controller.getState().bansError);
  assert.equal(h.calls.room, 2);
  assert.equal(bans, 1);
  h.controller.dispose();
});

test("dispose 뒤 늦은 GET·이벤트·이미 취소된 타이머는 이전 화면에 상태를 공개하지 않는다", async () => {
  // 준비
  const wait = deferred<RoomMember[]>();
  let block = false;
  const h = setup(model => ({ members: () => block ? wait.promise : Promise.resolve([{ ...model.self }, { ...model.target }]) }));
  await h.controller.load();
  const oldPoll = h.clock.pending()[0];
  block = true;
  const reading = h.controller.load();
  await settle();

  // 실행
  h.controller.dispose();
  const snapshot = h.controller.getState();
  const published = h.snapshots.length;
  h.connection().onConnect();
  h.connection().onStatus("DISCONNECTED");
  h.connection().onInvalidEvent(new Error("합성 잘못된 이벤트"));
  h.refresh();
  oldPoll.callback();
  wait.resolve([{ ...self }, { ...target }]);
  await reading;
  await settle();

  // 검증
  assert.equal(h.controller.getState(), snapshot);
  assert.equal(h.snapshots.length, published);
  assert.equal(h.calls.stops, 1);
  assert.equal(h.clock.pending().length, 0);
});

test("계정 전환 동안 도착한 private 이벤트와 늦은 POST는 새 계정에 영향을 주지 않는다", async () => {
  // 준비
  const wait = deferred<void>();
  let writes = 0;
  const first = setup(() => ({ changeAdmin: () => { writes++; return wait.promise; } }));
  await first.controller.load();
  const changing = first.controller.assignAdmin("72");
  await settle();

  // 실행: 이전 controller를 폐기하고 다른 scope로 새 계정을 연다.
  first.changeSession();
  first.controller.dispose();
  const second = setup();
  second.changeRole("MEMBER");
  await second.controller.load();
  const fresh = second.controller.getState();
  first.refresh();
  first.connection().onConnect();
  wait.resolve();
  assert.equal(await changing, false);

  // 검증
  assert.equal(second.controller.getState(), fresh);
  assert.equal(second.controller.getState().uncertain, false);
  assert.equal(second.controller.getState().room?.myRole, "MEMBER");
  assert.equal(writes, 1);
  assert.equal(first.clock.pending().length, 0);
  second.controller.dispose();
});

test("members·me 조회 사이 강퇴된 경우 HTTP400을 room 접근으로 재확인하여 퇴장한다", async () => {
  // 준비: 강퇴 HTTP400은 서버가 별도 semantic code 없이 전달하는 실제 공개 응답이다.
  for (const endpoint of ["members", "me"] as const) {
    let blocked = false;
    const h = setup(model => ({
      [endpoint]: async () => {
        if (blocked) {
          model.roomError = new ApiError(400, "HTTP_400");
          throw new ApiError(400, "HTTP_400");
        }
        return endpoint === "members" ? [{ ...model.self }, { ...model.target }] : { ...model.self };
      },
    }));
    await h.controller.load();

    // 실행
    blocked = true;
    h.refresh();
    await h.clock.run(50);

    // 검증: 목록의 400만으로 단정하지 않고 room을 다시 읽은 뒤 자원을 종료한다.
    assert.equal(h.calls.room, 3);
    assert.equal(h.controller.getState().exited, true);
    assert.equal(h.calls.stops, 1);
    assert.equal(h.clock.pending().length, 0);
    assert.equal(h.calls.writes, 0);
    h.controller.dispose();
  }
});

test("차단 목록 페이지 조회 중 권한 회수 이벤트가 오면 과거 차단 사유를 재공개하지 않는다", async () => {
  // 준비
  const wait = deferred<Awaited<ReturnType<RoomManagementService["bans"]>>>();
  const h = setup(() => ({ bans: async (_roomId, cursor) => cursor ? wait.promise
    : { items: [ban], hasNext: true, nextCursor: ban.id } }));
  await h.controller.load();
  const more = h.controller.loadMoreBans();
  await settle();

  // 실행
  h.changeRole("MEMBER");
  h.refresh();
  const fromEvent = h.snapshots.length;
  wait.resolve({ items: [{ ...ban, id: "89", memberId: "81" }], hasNext: false, nextCursor: null });
  assert.equal(await more, false);
  await h.clock.run(0);

  // 검증
  assert.equal(h.controller.getState().room?.myRole, "MEMBER");
  assert.equal(h.controller.getState().ready, true);
  assert.equal(h.snapshots.slice(fromEvent).some(state => state.bans.length > 0), false);
  assert.equal(h.calls.room, 2);
  h.controller.dispose();
});

test("연결 함수가 동기로 onConnect를 호출해도 초기 조회 이후 최신 권한 조회가 유실되지 않는다", async () => {
  // 준비
  const h = setup();
  let connects = 0;
  const controller = createRoomManagementController(h.api, "9", "1", `immediate:${++sequence}`, () => true, () => {}, 1000, {
    schedule: h.clock.schedule,
    connect: handlers => {
      connects++;
      h.changeRole("MEMBER");
      handlers.onConnect();
      return () => {};
    },
  });

  // 실행
  assert.equal(await controller.load(), true);

  // 검증
  assert.equal(controller.getState().room?.myRole, "MEMBER");
  assert.equal(controller.getState().revision, 1);
  assert.equal(h.calls.room, 2);
  assert.equal(connects, 1);
  assert.deepEqual(h.clock.pending().map(job => job.delay), [30000]);
  controller.dispose();
  h.controller.dispose();
});

test("연결 생성 실패는 동기 무한 조회 없이 읽기 안전망에서만 다시 시도한다", async () => {
  // 준비
  const h = setup();
  let connects = 0;
  const controller = createRoomManagementController(h.api, "9", "1", `connect-error:${++sequence}`, () => true, () => {}, 1000, {
    schedule: h.clock.schedule,
    connect: () => { connects++; throw new Error("합성 연결 생성 실패"); },
  });

  // 실행
  assert.equal(await controller.load(), true);
  assert.equal(h.calls.room, 1);
  assert.equal(connects, 1);
  await h.clock.run(30000);

  // 검증
  assert.equal(h.calls.room, 2);
  assert.equal(connects, 2);
  assert.equal(controller.getState().ready, true);
  assert.equal(h.calls.writes, 0);
  controller.dispose();
  h.controller.dispose();
});

test("권한 변화 없는 30초 poll은 확인창 revision과 조회 중 기존 목록·ready를 유지한다", async () => {
  // 준비
  const wait = deferred<ManagedRoom>();
  let blocked = false;
  const h = setup(model => ({ room: async () => blocked ? wait.promise : { ...model.room } }));
  await h.controller.load();
  const before = h.controller.getState();
  blocked = true;

  // 실행: poll이 응답을 기다리는 동안에도 입력 중인 확인창의 근거가 사라지지 않는다.
  await h.clock.run(30000);
  assert.equal(h.controller.getState().ready, true);
  assert.equal(h.controller.getState().loading, true);
  assert.equal(h.controller.getState().revision, before.revision);
  assert.equal(h.controller.getState().room, before.room);
  assert.equal(h.controller.getState().members, before.members);
  wait.resolve({ ...room });
  await settle();

  // 검증
  assert.equal(h.controller.getState().loading, false);
  assert.equal(h.controller.getState().ready, true);
  assert.equal(h.controller.getState().revision, before.revision);
  h.controller.dispose();
});

test("poll에서 대상 역할 변경을 발견해도 본인 역할과 무관하게 기존 확인창 세대를 폐기한다", async () => {
  // 준비
  const h = setup();
  await h.controller.load();
  const revision = h.controller.getState().revision;
  h.model.target.role = "ADMIN";

  // 실행
  await h.clock.run(30000);

  // 검증
  assert.equal(h.controller.getState().room?.myRole, "OWNER");
  assert.equal(h.controller.getState().members.find(member => member.id === "72")?.role, "ADMIN");
  assert.equal(h.controller.getState().revision, revision + 1);
  assert.equal(h.calls.writes, 0);
  h.controller.dispose();
});

test("처음부터 CLOSED인 방은 관리 GET은 허용하지만 실시간 구독을 생성하지 않는다", async () => {
  // 준비
  const h = setup();
  h.model.room.closed = true;
  h.changeRole("MEMBER");

  // 실행
  assert.equal(await h.controller.load(), true);
  await h.clock.run(30000);

  // 검증
  assert.equal(h.calls.connects, 0);
  assert.equal(h.controller.getState().exited, false);
  assert.equal(h.controller.getState().ready, true);
  assert.equal(capabilities(h.controller.getState().room).leave, true);
  assert.equal(h.calls.writes, 0);
  h.controller.dispose();
});

test("poll 시각에 POST가 진행 중이면 GET을 미루고 실패 후에도 다음 안전망 예약을 보존한다", async () => {
  // 준비
  const wait = deferred<void>();
  let writes = 0;
  const h = setup(() => ({ changeAdmin: () => { writes++; return wait.promise; } }));
  await h.controller.load();
  const changing = h.controller.assignAdmin("72");
  await settle();
  const reads = h.calls.room;

  // 실행: 쓰기 400을 퇴장으로 취급하지 않고, 이미 예약한 GET만 나중에 재개한다.
  await h.clock.run(30000);
  assert.equal(h.calls.room, reads);
  assert.deepEqual(h.clock.pending().map(job => job.delay), [30000]);
  h.changeRole("MEMBER");
  wait.reject(new ApiError(400, "HTTP_400"));
  assert.equal(await changing, false);
  assert.equal(h.controller.getState().exited, false);
  await h.clock.run(30000);

  // 검증
  assert.equal(h.controller.getState().ready, true);
  assert.equal(h.controller.getState().room?.myRole, "MEMBER");
  assert.equal(h.calls.room, reads + 1);
  assert.equal(writes, 1);
  assert.deepEqual(h.clock.pending().map(job => job.delay), [30000]);
  h.controller.dispose();
});

test("정상 poll의 읽기 실패도 기존 민감 자료와 확인창 세대를 폐기하고 backoff로 전환한다", async () => {
  // 준비
  const h = setup();
  await h.controller.load();
  const revision = h.controller.getState().revision;
  h.model.roomError = new ApiError(503, "HTTP_ERROR");

  // 실행
  await h.clock.run(30000);

  // 검증
  assert.equal(h.controller.getState().ready, false);
  assert.equal(h.controller.getState().revision, revision + 1);
  assert.deepEqual(h.controller.getState().bans, []);
  assert.deepEqual(h.controller.getState().members, []);
  assert.equal(h.controller.getState().room, null);
  assert.deepEqual(h.clock.pending().map(job => job.delay), [1000]);
  assert.equal(h.calls.writes, 0);
  h.controller.dispose();
});

test("ADMIN snapshot 직후 강등 이벤트가 누락돼도 bans HTTP400은 최신 MEMBER 권한을 다시 확인한다", async () => {
  // 준비: 첫 조회 이후 두 번째 bans 요청 직전에만 서버 역할이 바뀐다.
  let changed = false;
  let bans = 0;
  const h = setup(model => ({ bans: async () => {
    bans++;
    if (!changed) return { items: [ban], hasNext: false, nextCursor: null };
    model.room.myRole = "MEMBER";
    model.self.role = "MEMBER";
    throw new ApiError(400, "HTTP_400");
  } }));
  h.changeRole("ADMIN");
  await h.controller.load();
  const fromRefresh = h.snapshots.length;

  // 실행: 소켓 이벤트 없이 room/members/me의 과거 ADMIN 응답 다음에 실제 bans 400이 도착한다.
  changed = true;
  assert.equal(await h.controller.load(), true);

  // 검증: 과거 ADMIN ready 상태나 차단 사유를 다시 공개하지 않는다.
  assert.equal(h.controller.getState().exited, false);
  assert.equal(h.controller.getState().room?.myRole, "MEMBER");
  assert.equal(h.controller.getState().bansError, null);
  assert.deepEqual(h.controller.getState().bans, []);
  assert.equal(h.snapshots.slice(fromRefresh).some(state => state.ready && state.room?.myRole === "ADMIN"), false);
  assert.equal(h.calls.room, 3);
  assert.equal(bans, 2);
  assert.equal(h.calls.writes, 0);
  h.controller.dispose();
});

test("다음 bans 페이지의 HTTP400도 즉시 무효화한 뒤 최신 room·members·me로 권한을 다시 확인한다", async () => {
  // 준비
  const h = setup(model => ({ bans: async (_roomId, cursor) => {
    if (!cursor) return { items: [ban], hasNext: true, nextCursor: ban.id };
    model.room.myRole = "MEMBER";
    model.self.role = "MEMBER";
    throw new ApiError(400, "HTTP_400");
  } }));
  h.changeRole("ADMIN");
  await h.controller.load();
  const revision = h.controller.getState().revision;

  // 실행: private 이벤트가 누락된 상태에서도 페이지 오류가 권한 재확인 계기가 된다.
  assert.equal(await h.controller.loadMoreBans(), false);
  assert.equal(h.controller.getState().ready, false);
  assert.equal(h.controller.getState().revision, revision + 1);
  assert.equal(h.controller.getState().room, null);
  assert.deepEqual(h.controller.getState().bans, []);
  await h.clock.run(0);

  // 검증
  assert.equal(h.controller.getState().ready, true);
  assert.equal(h.controller.getState().room?.myRole, "MEMBER");
  assert.equal(h.controller.getState().exited, false);
  assert.equal(h.calls.room, 2);
  assert.equal(h.calls.writes, 0);
  h.controller.dispose();
});

test("잘못된 bans HTTP400이 반복되어도 room 접근 성공은 퇴장시키지 않고 재확인을 한 번으로 제한한다", async () => {
  // 준비
  let bans = 0;
  const h = setup(() => ({ bans: async () => { bans++; throw new ApiError(400, "HTTP_400"); } }));

  // 실행
  assert.equal(await h.controller.load(), true);

  // 검증: 쓰기 재전송·무한 조회·목록 복귀 없이 부가 조회 오류만 남긴다.
  assert.equal(h.controller.getState().ready, true);
  assert.equal(h.controller.getState().exited, false);
  assert.equal(h.controller.getState().room?.myRole, "OWNER");
  assert.ok(h.controller.getState().bansError);
  assert.equal(h.calls.room, 2);
  assert.equal(bans, 1);
  assert.equal(h.calls.writes, 0);
  h.controller.dispose();
});

test("동일 권한 poll은 펼친 bans 두 페이지와 cursor를 보존하고 두 번째 페이지 대상 해제를 허용한다", async () => {
  // 준비: 세 페이지를 구분하여 poll 전후 cursor가 실제 서비스에 그대로 전달되는지 확인한다.
  const second = { ...ban, id: "89", memberId: "81" };
  const cursors: (string | null)[] = [];
  let releases = 0;
  const h = setup(() => ({
    bans: async (_roomId, cursor) => {
      cursors.push(cursor);
      if (cursor === null) return { items: [ban], hasNext: true, nextCursor: ban.id };
      if (cursor === ban.id) return { items: [second], hasNext: true, nextCursor: second.id };
      assert.equal(cursor, second.id);
      return { items: [], hasNext: false, nextCursor: null };
    },
    releaseBan: async (_roomId, id) => { assert.equal(id, second.id); releases++; },
  }));
  await h.controller.load();
  assert.equal(await h.controller.loadMoreBans(), true);
  const before = h.controller.getState();
  assert.deepEqual(before.bans.map(item => item.id), [ban.id, second.id]);

  // 실행: 권한만 재확인하는 poll은 보조 목록 GET을 하지 않는다.
  await h.clock.run(30000);
  assert.equal(h.controller.getState().bans, before.bans);
  assert.equal(h.controller.getState().hasMoreBans, true);
  assert.equal(h.controller.getState().revision, before.revision);
  assert.deepEqual(cursors, [null, ban.id]);
  assert.equal(await h.controller.loadMoreBans(), true);
  assert.deepEqual(cursors, [null, ban.id, second.id]);

  // 검증: 확인창이 참조하던 두 번째 페이지 대상은 poll 이후에도 변경 자격을 유지한다.
  assert.equal(await h.controller.releaseBan(second.id), true);
  assert.equal(releases, 1);
  h.controller.dispose();
});

test("GROUP의 동일 권한 poll도 초대용 friends를 다시 읽거나 기존 배열을 교체하지 않는다", async () => {
  // 준비
  let friends = 0;
  const h = setup(() => ({ friends: async () => { friends++; return []; } }));
  h.model.room.roomType = "GROUP";
  h.model.room.sourceType = "FRIEND";
  h.model.self.id = "1";
  await h.controller.load();
  const before = h.controller.getState();

  // 실행
  await h.clock.run(30000);

  // 검증
  assert.equal(h.controller.getState().friends, before.friends);
  assert.equal(h.controller.getState().revision, before.revision);
  assert.equal(friends, 1);
  assert.equal(h.calls.room, 2);
  h.controller.dispose();
});
