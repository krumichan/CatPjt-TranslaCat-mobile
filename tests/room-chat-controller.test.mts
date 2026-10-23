import assert from "node:assert/strict";
import test from "node:test";

import { ApiError } from "../src/api/client.ts";
import type { ChatMessage, ChatRoom, MessagePage } from "../src/domain/chat/types.ts";
import { createRoomChatController, type RoomConnection } from "../src/features/chat/controller.ts";
import type { ChatService } from "../src/features/chat/service.ts";

type Service = Parameters<typeof createRoomChatController>[0]["service"];
const room: ChatRoom = { id: "1", roomType: "GROUP", sourceType: "FRIEND", name: "합성 대화", memberCount: 3,
  unreadCount: 0, updatedAt: "2026-10-21T00:00:00Z", active: true, partner: null };
function message(id: number, count = 1): ChatMessage {
  return { id: String(id), chatRoomId: "1", senderUserId: "2", senderType: "USER", senderName: "합성 사용자", messageType: "TEXT",
    content: `메시지 ${id}`, status: "SENT", unreadMemberCount: count, translations: [], createdAt: "2026-10-21T00:00:00Z",
    updatedAt: "2026-10-21T00:00:00Z", sender: null };
}
const page = (ids: number[], count = 1): MessagePage => ({ messages: ids.map(id => message(id, count)), nextCursorId: null, hasNext: false });
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(overrides: Partial<Service> = {}) {
  let active = true;
  let current = true;
  let now = 0;
  const timers = new Set<{ due: number; work: () => void }>();
  const sockets: RoomConnection[] = [];
  let socketStops = 0;
  const reads: string[] = [];
  let sends = 0;
  const service: Service = {
    room: async () => room,
    myOpenProfile: async () => ({ openChatMemberId: "7", nickname: "합성", memberCode: "ABC", joinedAt: "2026-10-20T00:00:00Z" }),
    firstUnread: async () => null,
    messages: async () => page([10]), after: async () => page([]),
    language: async () => ({ translationLanguageCode: "ja", showOriginal: true, showTranslation: true }),
    read: async (_room, id) => { reads.push(id); return { lastReadMessageId: id, unreadCount: 0 }; },
    send: async () => { sends++; return message(11); }, ...overrides,
  };
  const controller = createRoomChatController({ key: "synthetic:1", roomId: "1", service,
    isActive: () => active, isCurrent: () => current,
    connect: handlers => { sockets.push(handlers); return () => { socketStops++; }; },
    schedule: (work, delay) => { const timer = { due: now + delay, work }; timers.add(timer); return () => { timers.delete(timer); }; },
  });
  const advance = async (ms: number) => {
    const until = now + ms;
    for (;;) {
      const next = [...timers].filter(timer => timer.due <= until).sort((a, b) => a.due - b.due)[0];
      if (!next) break;
      now = next.due; timers.delete(next); next.work(); await settle();
    }
    now = until;
    await settle();
  };
  return { controller, service, sockets, reads, advance, timers,
    get sends() { return sends; }, get socketStops() { return socketStops; },
    setActive: (value: boolean) => { active = value; }, setCurrent: (value: boolean) => { current = value; },
    start: async () => { controller.start(); await settle(); },
  };
}

test("외부 종료는 active가 true여도 기록을 보존하고 즉시 전송을 잠근다", async () => {
  // 준비: OPEN 종료 상태는 일반 방 active와 독립적으로 바뀐다.
  let closed = false;
  const f = fixture({ room: async () => ({ ...room, roomType: "OPEN", closed }) });
  await f.start();
  assert.equal(f.controller.getSnapshot().authorityReady, true);

  // 실행: 웹에서 종료한 이벤트가 먼저 오고 HTTP 상태가 뒤따른다.
  closed = true;
  f.sockets[0].onEvent({ kind: "refresh", roomId: "1" });
  assert.equal(await f.controller.send("종료 후 요청"), false);
  await f.advance(0);

  // 검증: 이전 기록은 그대로 읽고 새 POST와 재구독은 하지 않는다.
  assert.equal(f.controller.getSnapshot().room?.active, true);
  assert.equal(f.controller.getSnapshot().room?.closed, true);
  assert.deepEqual(f.controller.getSnapshot().messages.map(item => item.id), ["10"]);
  assert.equal(f.socketStops, 1);
  assert.equal(await f.controller.send("다시 시도"), false);
  assert.equal(f.sends, 0);
  f.controller.stop();
});

test("권한 조회 도중 외부 변경이 오면 오래된 방장 응답으로 메뉴와 전송을 열지 않는다", async () => {
  // 준비: 두 번째 조회만 이전 역할 응답으로 지연시킨다.
  let reads = 0;
  const wait = deferred<ChatRoom>();
  const owner: ChatRoom = { ...room, myRole: "OWNER" };
  const member: ChatRoom = { ...room, myRole: "MEMBER" };
  const f = fixture({ room: () => ++reads === 2 ? wait.promise : Promise.resolve(reads > 2 ? member : owner) });
  await f.start();
  const refresh = f.controller.refresh();
  await settle();

  // 실행: 조회 중 역할 이벤트가 오고 과거 역할 응답이 나중에 도착한다.
  f.sockets[0].onEvent({ kind: "refresh", roomId: "1" });
  wait.resolve(owner);
  await refresh;
  assert.equal(f.controller.getSnapshot().authorityReady, false);
  assert.equal(await f.controller.send("권한 미확인"), false);
  await f.advance(500);

  // 검증: 추가 HTTP 결과로만 권한 확인을 끝내고 이전 역할은 재사용하지 않는다.
  assert.equal(f.controller.getSnapshot().room?.myRole, "MEMBER");
  assert.equal(f.controller.getSnapshot().authorityReady, true);
  assert.equal(f.sends, 0);
  f.controller.stop();
});

test("화면 복귀는 권한을 재확인하고 실제 강퇴 HTTP400이면 이전 이력을 정리한다", async () => {
  // 준비: 화면 밖에서는 기록을 보존하되 돌아오는 조회를 지연시킨다.
  const wait = deferred<ChatRoom>();
  let returning = false;
  const f = fixture({ room: () => returning ? wait.promise : Promise.resolve(room) });
  await f.start();
  f.controller.stop();
  returning = true;

  // 실행: 재진입 시 새 권한 확인이 끝나기 전 전송을 시도한다.
  f.controller.start();
  await settle();
  assert.equal(f.controller.getSnapshot().authorityReady, false);
  assert.equal(await f.controller.send("이전 멤버십"), false);
  wait.reject(new ApiError(400, "HTTP_400"));
  await settle();

  // 검증: 서버가 접근을 거절하면 캐시와 메뉴 기준도 함께 제거한다.
  assert.equal(f.controller.getSnapshot().room, null);
  assert.deepEqual(f.controller.getSnapshot().messages, []);
  assert.equal(f.controller.getSnapshot().authorityReady, false);
  assert.equal(f.sends, 0);
  f.controller.stop();
});

test("첫 조회가 실패해도 연결이 돌아오면 재시도하여 실시간 구독을 시작한다", async () => {
  // 준비: 최초 방 조회만 실패한다.
  let calls = 0;
  const f = fixture({ room: async () => { if (++calls === 1) throw new ApiError(0, "NETWORK_ERROR"); return room; } });

  // 실행: 사용자 새로고침 없이 지연 재시도를 진행한다.
  await f.start();
  assert.equal(f.sockets.length, 0);
  await f.advance(1000);

  // 검증
  assert.equal(calls, 2);
  assert.equal(f.controller.getSnapshot().room?.id, "1");
  assert.equal(f.sockets.length, 1);
  assert.equal(f.sends, 0);
  f.controller.stop();
});

test("재연결 중 먼저 도착한 큰 WS ID도 모든 누락 페이지와 중복 없이 합쳐진다", async () => {
  // 준비: REST 기준은 10, WS는 220을 먼저 보낸다.
  const cursors: string[] = [];
  const f = fixture({ after: async (_room, cursor) => {
    cursors.push(cursor);
    const start = Number(cursor) + 1;
    const end = Math.min(start + 99, 219);
    const ids = Array.from({ length: Math.max(0, end - start + 1) }, (_, index) => start + index);
    return { ...page(ids), hasNext: end < 219, nextCursorId: end < 219 ? String(end) : null };
  } });
  await f.start();

  // 실행
  f.sockets[0].onEvent({ kind: "message", roomId: "1", message: message(220) });
  f.sockets[0].onConnect();
  await f.advance(500);
  f.sockets[0].onEvent({ kind: "message", roomId: "1", message: message(220) });

  // 검증: 10부터 220까지 빠짐없이 한 번만 존재한다.
  assert.deepEqual(cursors, ["10", "110", "210"]);
  assert.deepEqual(f.controller.getSnapshot().messages.map(row => row.id), Array.from({ length: 211 }, (_, index) => String(index + 10)));
  f.controller.stop();
});

test("지연·중복 memberRead 이벤트는 이미 반영된 REST 집계를 다시 감소시키지 않는다", async () => {
  // 준비
  let count = 1;
  const f = fixture({ messages: async () => page([10], count) });
  await f.start();
  const event = { kind: "memberRead" as const, roomId: "1", readerUserId: "3", readerOpenChatMemberId: null, previous: null, last: "10" };

  // 실행: 서버 스냅샷 이후 지연 이벤트가 두 번 도착한다.
  f.sockets[0].onEvent(event);
  await f.advance(250);
  f.sockets[0].onEvent(event);
  await f.advance(250);

  // 검증: 첫 이벤트의 500ms 시점에 조회하며 1을 0으로 추측하지 않는다.
  assert.equal(f.controller.getSnapshot().messages[0].unreadMemberCount, 1);
  count = 0;
  f.sockets[0].onEvent(event);
  await f.advance(500);
  assert.equal(f.controller.getSnapshot().messages[0].unreadMemberCount, 0);
  f.controller.stop();
});

test("스냅샷 조회 중 발생한 읽음 이벤트를 잃지 않고 한 번 더 조정한다", async () => {
  // 준비: 두 번째 스냅샷을 보류한다.
  const pending = deferred<MessagePage>();
  let calls = 0;
  const f = fixture({ messages: async () => { calls++; return calls === 2 ? pending.promise : page([10], calls >= 3 ? 0 : 1); } });
  await f.start();
  f.sockets[0].onConnect();
  await f.advance(0);

  // 실행
  f.sockets[0].onEvent({ kind: "memberRead", roomId: "1", readerUserId: "3", readerOpenChatMemberId: null, previous: null, last: "10" });
  pending.resolve(page([10], 1));
  await settle();
  await f.advance(500);

  // 검증
  assert.equal(calls, 3);
  assert.equal(f.controller.getSnapshot().messages[0].unreadMemberCount, 0);
  f.controller.stop();
});

test("읽고 있는 과거 영역만 다시 가져와 읽음 집계를 갱신한다", async () => {
  // 준비: 과거 1~10이 로드되었지만 최신 API는 8~10만 제공한다.
  let first = true;
  let count = 1;
  const cursors: (string | null)[] = [];
  const f = fixture({ messages: async (_room, cursor) => {
    cursors.push(cursor);
    if (first) { first = false; return page([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]); }
    if (cursor === "4") return page([1, 2, 3], count);
    return page([8, 9, 10], count);
  } });
  await f.start();
  f.controller.markVisible(["2", "3"]);

  // 실행
  count = 0;
  f.sockets[0].onEvent({ kind: "memberRead", roomId: "1", readerUserId: "3", readerOpenChatMemberId: null, previous: null, last: "10" });
  await f.advance(500);

  // 검증: 최신→가시 창만 조회하며 스크롤·읽음 위치를 옮기지 않는다.
  assert.deepEqual(cursors, [null, null, "4"]);
  assert.equal(f.controller.getSnapshot().messages.find(row => row.id === "2")?.unreadMemberCount, 0);
  assert.equal(f.controller.getSnapshot().messages.find(row => row.id === "6")?.unreadMemberCount, 1);
  assert.equal(f.reads.length, 0);
  f.controller.stop();
});

test("읽음 PATCH 실패는 새 스크롤 없이 재시도하되 복원 전에는 기록하지 않는다", async () => {
  // 준비
  const calls: string[] = [];
  const f = fixture({ read: async (_room, id) => {
    calls.push(id);
    if (calls.length === 1) throw new ApiError(503, "UNAVAILABLE");
    return { lastReadMessageId: id, unreadCount: 0 };
  } });
  await f.start();
  f.controller.markVisible(["10"]);
  await f.advance(500);
  assert.equal(calls.length, 0);

  // 실행
  f.controller.setReadingReady(true);
  await f.advance(200);
  assert.deepEqual(calls, ["10"]);
  await f.advance(1000);

  // 검증
  assert.deepEqual(calls, ["10", "10"]);
  await f.advance(30000);
  assert.equal(calls.length, 2);
  f.controller.stop();
});

test("접근 거부 뒤에는 기록을 지우고 자동 재시도와 읽음 요청을 멈춘다", async () => {
  // 준비
  let denied = false;
  let calls = 0;
  const f = fixture({ room: async () => { calls++; if (denied) throw new ApiError(403, "FORBIDDEN"); return room; } });
  await f.start();

  // 실행
  denied = true;
  f.sockets[0].onEvent({ kind: "refresh", roomId: "1" });
  await f.advance(500);
  f.controller.markVisible(["10"]);
  f.controller.setReadingReady(true);
  await f.advance(120000);

  // 검증
  assert.equal(calls, 2);
  assert.deepEqual(f.controller.getSnapshot().messages, []);
  assert.equal(f.controller.getSnapshot().room, null);
  assert.equal(f.reads.length, 0);
  assert.equal(f.socketStops, 1);
  f.controller.stop();
});

test("배경 전환 전의 느린 조회는 복귀한 화면의 데이터·커서를 바꾸지 않는다", async () => {
  // 준비
  const old = deferred<MessagePage>();
  const cursors: string[] = [];
  let afterCalls = 0;
  const f = fixture({ after: async (_room, cursor) => { cursors.push(cursor); return ++afterCalls === 1 ? old.promise : page([11]); } });
  await f.start();
  f.sockets[0].onConnect();
  await f.advance(0);

  // 실행: 이전 after 응답을 무시하는 새 활성 주기를 만든다.
  f.controller.stop();
  await f.start();
  old.resolve(page([999]));
  await settle();
  f.sockets.at(-1)!.onConnect();
  await f.advance(0);

  // 검증
  assert.deepEqual(cursors, ["10", "10", "11"]);
  assert.equal(f.controller.getSnapshot().messages.some(row => row.id === "999"), false);
  f.controller.stop();
});

test("계정 교체 직후 cleanup보다 먼저 도착한 응답도 적용하지 않는다", async () => {
  // 준비
  const pending = deferred<ChatRoom>();
  let messageCalls = 0;
  const f = fixture({ room: () => pending.promise, messages: async () => { messageCalls++; return page([10]); } });
  await f.start();

  // 실행
  f.setCurrent(false);
  pending.resolve(room);
  await settle();

  // 검증
  assert.equal(messageCalls, 0);
  assert.equal(f.controller.getSnapshot().room, null);
  assert.equal(f.sockets.length, 0);
  f.controller.stop();
});

test("POST 408은 전송 불확실 상태로 남기며 조회 복구로 자동 재전송하지 않는다", async () => {
  // 준비
  let sends = 0;
  const f = fixture({ send: async () => { sends++; throw new ApiError(408, "TIMEOUT"); } });
  await f.start();

  // 실행
  assert.equal(await f.controller.send("합성 메시지"), false);
  await f.advance(60000);
  await f.controller.refresh();
  assert.equal(await f.controller.send("합성 메시지"), false);

  // 검증
  assert.equal(sends, 1);
  assert.equal(f.controller.getSnapshot().uncertain, true);
  f.controller.stop();
});

test("POST 도중 화면을 떠나면 늦은 성공을 재진입 화면에 끼워넣지 않는다", async () => {
  // 준비
  const pending = deferred<ChatMessage>();
  const f = fixture({ send: () => pending.promise });
  await f.start();
  const sent = f.controller.send("합성 메시지");

  // 실행
  f.controller.stop();
  await f.start();
  pending.resolve(message(99));
  assert.equal(await sent, false);

  // 검증
  assert.equal(f.controller.getSnapshot().uncertain, true);
  assert.equal(f.controller.getSnapshot().messages.some(row => row.id === "99"), false);
  f.controller.stop();
});

test("빈방 이후 첫 WS와 다음 조회 사이의 100개 초과 기록도 복구한다", async () => {
  // 준비
  let initial = true;
  const ids = Array.from({ length: 150 }, (_, index) => index + 1);
  const f = fixture({ messages: async (_room, cursor) => {
    if (initial) { initial = false; return page([]); }
    if (cursor === "101") return page(ids.slice(0, 100));
    return { ...page(ids.slice(100)), hasNext: true, nextCursorId: "101" };
  } });
  await f.start();

  // 실행
  f.sockets[0].onEvent({ kind: "message", roomId: "1", message: message(150) });
  f.sockets[0].onConnect();
  await f.advance(0);

  // 검증
  assert.deepEqual(f.controller.getSnapshot().messages.map(row => row.id), ids.map(String));
  assert.equal(f.controller.getSnapshot().hasMore, false);
  f.controller.stop();
});

test("서버 heartbeat가 없는 연결도 활성 방의 주기 조회로 놓친 메시지를 복구한다", async () => {
  // 준비
  let latest = 10;
  let queries = 0;
  const f = fixture({ messages: async () => { queries++; return page([latest]); }, after: async (_room, cursor) => page(latest === 10 || cursor === "11" ? [] : [11]) });
  await f.start();
  latest = 11;

  // 실행: WS close나 새 메시지 이벤트가 오지 않는다.
  await f.advance(30000);

  // 검증: 배경에서는 추가 조회가 없고 복귀할 때 다시 확인한다.
  assert.deepEqual(f.controller.getSnapshot().messages.map(row => row.id), ["10", "11"]);
  f.setActive(false);
  f.controller.stop();
  const before = queries;
  await f.advance(120000);
  assert.equal(queries, before);
  f.setActive(true);
  await f.start();
  assert.equal(queries, before + 1);
  f.controller.stop();
});

test("첫 미읽음 조회 실패 후 복구 시 읽던 위치를 확정하고 그 전에는 읽지 않는다", async () => {
  // 준비
  let calls = 0;
  const f = fixture({ firstUnread: async () => { if (++calls === 1) throw new ApiError(503, "UNAVAILABLE"); return "10"; } });
  await f.start();

  // 실행·검증
  assert.equal(f.controller.getSnapshot().entryTarget, null);
  assert.equal(f.reads.length, 0);
  await f.advance(1000);
  assert.deepEqual(f.controller.getSnapshot().entryTarget, { messageId: "10", unread: true });
  assert.equal(f.reads.length, 0);
  f.controller.stop();
});

test("단절이 계속돼도 조회는 최대 30초 간격으로 지연되며 종료 시 취소된다", async () => {
  // 준비
  let calls = 0;
  const f = fixture({ room: async () => { calls++; throw new ApiError(0, "NETWORK_ERROR"); } });
  await f.start();

  // 실행
  await f.advance(1000 + 2000 + 4000 + 8000 + 16000 + 30000);

  // 검증
  assert.equal(calls, 7);
  f.controller.stop();
  await f.advance(120000);
  assert.equal(calls, 7);
  assert.equal(f.timers.size, 0);
});

// 공개 서비스 형태와 가짜 포트의 관계도 컴파일 시 확인한다.
type _ServiceContract = Service extends Partial<ChatService> ? true : never;
const compatible: _ServiceContract = true;
void compatible;


test("응답이 끝나지 않는 조회는 시간 제한 후 복구하며 늦은 결과를 버린다", async () => {
  // 준비
  const pending = deferred<ChatRoom>();
  let calls = 0;
  const f = fixture({ room: async () => ++calls === 1 ? pending.promise : room });
  await f.start();

  // 실행
  await f.advance(15000);
  await f.advance(1000);
  pending.resolve({ ...room, name: "폐기된 응답" });
  await settle();

  // 검증
  assert.equal(calls, 2);
  assert.equal(f.controller.getSnapshot().room?.name, "합성 대화");
  assert.equal(f.sockets.length, 1);
  f.controller.stop();
});

test("읽음의 명시적 422 거절은 일시적 네트워크 실패처럼 반복하지 않는다", async () => {
  // 준비
  let calls = 0;
  const f = fixture({ read: async () => { calls++; throw new ApiError(422, "REJECTED"); } });
  await f.start();
  f.controller.markVisible(["10"]);
  f.controller.setReadingReady(true);

  // 실행
  await f.advance(10000);

  // 검증: 다음 사용자 동작이나 정상 조회가 있기 전 자동 반복 없음.
  assert.equal(calls, 1);
  f.controller.stop();
});


test("삭제된 첫 가시 메시지가 없어도 나머지 대화와 연결을 유지한다", async () => {
  // 준비: 현재 가시 범위 2~3 중 서버가 2를 삭제한다.
  let initial = true;
  const f = fixture({ messages: async (_room, cursor) => {
    if (initial) { initial = false; return page([1, 2, 3, 4, 5, 8, 9, 10]); }
    return cursor === "4" ? page([1, 3], 0) : page([8, 9, 10], 0);
  } });
  await f.start();
  f.controller.markVisible(["2", "3"]);

  // 실행
  f.sockets[0].onEvent({ kind: "memberRead", roomId: "1", readerUserId: "3", readerOpenChatMemberId: null, previous: null, last: "10" });
  await f.advance(500);

  // 검증: 사라진 행만 버리고 권한 있는 방 전체를 오류로 처리하지 않는다.
  assert.deepEqual(f.controller.getSnapshot().messages.map(row => row.id), ["1", "3", "4", "5", "8", "9", "10"]);
  assert.equal(f.controller.getSnapshot().room?.id, "1");
  assert.equal(f.controller.getSnapshot().error, null);
  assert.equal(f.socketStops, 0);
  f.controller.stop();
});


test("늦은 미읽음 복원은 사용자가 선택한 최신 위치를 덮어쓰지 않는다", async () => {
  // 준비: 최초 실패 뒤 미읽음 재조회가 진행 중이다.
  const pending = deferred<string | null>();
  let calls = 0;
  const f = fixture({ firstUnread: async () => { if (++calls === 1) throw new ApiError(503, "UNAVAILABLE"); return pending.promise; } });
  await f.start();
  await f.advance(1000);

  // 실행
  f.controller.chooseLatest();
  pending.resolve("5");
  await settle();

  // 검증
  assert.deepEqual(f.controller.getSnapshot().entryTarget, { messageId: "10", unread: false });
  assert.equal(f.controller.getSnapshot().room?.id, "1");
  f.controller.stop();
});

test("최신 조회 중 도착한 WS 행을 오래된 가시 스냅샷으로 제거하지 않는다", async () => {
  // 준비
  const pending = deferred<MessagePage>();
  let calls = 0;
  const f = fixture({ messages: async () => ++calls === 2 ? pending.promise : page(calls > 2 ? [10, 11] : [10]) });
  await f.start();
  f.sockets[0].onConnect();
  await f.advance(0);

  // 실행: 새 행이 화면에 보인 뒤 오래된 최신 조회가 돌아온다.
  f.sockets[0].onEvent({ kind: "message", roomId: "1", message: message(11) });
  f.controller.markVisible(["10", "11"]);
  pending.resolve(page([10]));
  await settle();

  // 검증: 가시 범위를 정한 뒤 새 조회를 하므로 11을 유지한다.
  assert.deepEqual(f.controller.getSnapshot().messages.map(row => row.id), ["10", "11"]);
  assert.equal(calls, 3);
  f.controller.stop();
});
