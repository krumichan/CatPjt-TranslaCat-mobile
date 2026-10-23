import assert from "node:assert/strict";
import test from "node:test";

import { createApiClient } from "../src/api/client.ts";
import { ChatContractError } from "../src/domain/chat/contracts.ts";
import { restoreUnreadHistory } from "../src/domain/chat/entry.ts";
import type { ChatMessage, MessagePage } from "../src/domain/chat/types.ts";
import { createChatService } from "../src/features/chat/service.ts";

function message(id: number, roomId = "3"): ChatMessage {
  return { id: String(id), chatRoomId: roomId, senderUserId: "2", senderType: "USER", senderName: "합성 참여자",
    messageType: "TEXT", content: "합성 메시지", status: "SENT", unreadMemberCount: 1, translations: [],
    createdAt: "2026-10-20T00:00:00Z", updatedAt: "2026-10-20T00:00:00Z", sender: null };
}

function unread(roomId: number, latestId: number, firstId: number) {
  return { roomId, unreadCount: 1, firstUnreadMessageId: firstId, latestMessage: { id: latestId } };
}

function fixture(pages: unknown[]) {
  const requests: string[] = [];
  const api = createApiClient({ baseUrl: "https://unit.test/api/v1", accessToken: async () => "fixture-token",
    fetcher: async (url) => {
      requests.push(String(url));
      return new Response(JSON.stringify({ body: pages.shift() }), { status: 200 });
    } });
  return { service: createChatService(api), requests };
}

test("미읽음 목록의 다음 페이지까지 찾아 정확한 첫 미읽음 ID를 사용한다", async () => {
  // 준비: 본인·삭제·시스템 메시지로 ID 간격이 달라도 unreadCount를 역산하지 않는다.
  const { service, requests } = fixture([
    { items: [unread(8, 100, 91)], nextCursorMessageId: 100, hasNext: true },
    { items: [unread(3, 80, 51)], nextCursorMessageId: null, hasNext: false },
  ]);
  // 실행
  const result = await service.firstUnread("3");
  // 검증
  assert.equal(result, "51");
  assert.equal(requests.length, 2);
  assert.match(requests[1]!, /cursorMessageId=100/);
});

test("미읽음 목록을 모두 소진한 방은 null로 반환한다", async () => {
  // 준비
  const { service } = fixture([{ items: [], nextCursorMessageId: null, hasNext: false }]);
  // 실행·검증
  assert.equal(await service.firstUnread("3"), null);
});

test("목표 방을 발견해도 같은 페이지의 불안전 ID를 통과시키지 않는다", async () => {
  // 준비
  const { service } = fixture([{ items: [unread(3, 100, 90), unread(4, 80, Number.MAX_SAFE_INTEGER + 1)],
    nextCursorMessageId: null, hasNext: false }]);
  // 실행·검증
  await assert.rejects(service.firstUnread("3"), { code: "UNSAFE_CHAT_ID" });
});

test("미읽음 페이지의 반복 cursor와 중복 방은 무한 요청 전에 거절한다", async () => {
  // 준비
  for (const second of [
    { items: [unread(4, 100, 90)], nextCursorMessageId: 100, hasNext: true },
    { items: [unread(8, 80, 70)], nextCursorMessageId: null, hasNext: false },
  ]) {
    const { service, requests } = fixture([
      { items: [unread(8, 100, 90)], nextCursorMessageId: 100, hasNext: true }, second,
    ]);
    // 실행·검증
    await assert.rejects(service.firstUnread("3"), ChatContractError);
    assert.equal(requests.length, 2);
  }
});

test("알 수 없는 미읽음 응답은 읽음 완료로 치환하지 않는다", async () => {
  // 준비
  for (const body of [
    {}, { items: [], hasNext: true, nextCursorMessageId: 10 },
    { items: [unread(3, 80, 81)], hasNext: false, nextCursorMessageId: null },
    { items: [{ ...unread(3, 80, 70), unreadCount: 0 }], hasNext: false, nextCursorMessageId: null },
  ]) {
    const { service } = fixture([body]);
    // 실행·검증
    await assert.rejects(service.firstUnread("3"), ChatContractError);
  }
});

test("첫 페이지에 기준 행이 있으면 추가 요청 없이 같은 연속 기록을 사용한다", async () => {
  // 준비
  let requests = 0;
  const first = { messages: [message(20), message(30)], nextCursorId: "20", hasNext: true };
  // 실행
  const result = await restoreUnreadHistory(first, "20", async () => { requests += 1; throw new Error("unexpected"); });
  // 검증
  assert.deepEqual(result, first);
  assert.equal(requests, 0);
});

test("첫 미읽음이 100개 이전이어도 역방향 페이지를 합쳐 빠짐없이 복구한다", async () => {
  // 준비
  const rows = Array.from({ length: 205 }, (_, index) => message(index + 1));
  const pages: MessagePage[] = [
    { messages: rows.slice(5, 105), nextCursorId: "6", hasNext: true },
    { messages: rows.slice(0, 5), nextCursorId: null, hasNext: false },
  ];
  const requests: string[] = [];
  // 실행
  const result = await restoreUnreadHistory({ messages: rows.slice(105), nextCursorId: "106", hasNext: true }, "3",
    async (cursor) => { requests.push(cursor); return pages.shift()!; });
  // 검증
  assert.deepEqual(requests, ["106", "6"]);
  assert.equal(result.messages.length, 205);
  assert.equal(result.messages[0]?.id, "1");
  assert.equal(result.messages[204]?.id, "205");
  assert.equal(result.hasNext, false);
});

test("삭제되거나 접근 범위에서 사라진 기준 행은 임의의 다음 행으로 대체하지 않는다", async () => {
  // 준비
  const first = { messages: [message(5), message(7)], nextCursorId: null, hasNext: false };
  // 실행·검증
  await assert.rejects(restoreUnreadHistory(first, "6", async () => first), { code: "CHAT_ENTRY_ANCHOR_MISSING" });
  await assert.rejects(restoreUnreadHistory({ messages: [], nextCursorId: null, hasNext: false }, "6", async () => first),
    { code: "CHAT_ENTRY_ANCHOR_MISSING" });
});

test("기록 페이지가 다른 방이거나 역방향 경계를 넘으면 거절한다", async () => {
  // 준비
  for (const messages of [[message(5, "4")], [message(11)], [message(5), message(5)]]) {
    const first = { messages: [message(10)], nextCursorId: "10", hasNext: true };
    // 실행·검증
    await assert.rejects(restoreUnreadHistory(first, "1",
      async () => ({ messages, nextCursorId: null, hasNext: false })), ChatContractError);
  }
});

test("기록 페이지의 비진행 cursor와 불안전 ID는 거절한다", async () => {
  // 준비
  for (const first of [
    { messages: [message(10)], nextCursorId: "11", hasNext: true },
    { messages: [message(10)], nextCursorId: "9007199254740992", hasNext: true },
  ]) {
    // 실행·검증
    await assert.rejects(restoreUnreadHistory(first, "1", async () => first), ChatContractError);
  }
});
