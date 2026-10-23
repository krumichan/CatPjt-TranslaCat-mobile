import { ChatContractError, wireId } from "./contracts.ts";
import { compareIds, mergeMessages } from "./timeline.ts";
import type { ChatMessage, MessagePage } from "./types.ts";

export async function restoreUnreadHistory(
  firstPage: MessagePage,
  firstUnread: string,
  fetchPrevious: (cursor: string) => Promise<MessagePage>,
): Promise<MessagePage> {
  wireId(firstUnread);
  let page = firstPage;
  let messages: ChatMessage[] = [];
  let roomId: string | null = null;
  let boundary: string | null = null;

  // 화면에 중간 페이지를 노출하지 않고 첫 미읽음 행이 있는 연속된 기록을 준비한다.
  for (;;) {
    let previous: string | null = null;
    for (const message of page.messages) {
      wireId(message.id);
      wireId(message.chatRoomId);
      roomId ??= message.chatRoomId;
      if (message.chatRoomId !== roomId || (boundary && compareIds(message.id, boundary) >= 0)
        || (previous && compareIds(message.id, previous) <= 0)) {
        throw new ChatContractError("INVALID_CHAT_CURSOR");
      }
      previous = message.id;
    }
    const oldest = page.messages[0]?.id ?? null;
    if (page.nextCursorId) wireId(page.nextCursorId);
    if (typeof page.hasNext !== "boolean" || (page.hasNext
      ? !oldest || page.nextCursorId !== oldest
      : page.nextCursorId !== null)) throw new ChatContractError("INVALID_CHAT_CURSOR");

    messages = mergeMessages(messages, page.messages);
    if (messages.some((message) => message.id === firstUnread)) {
      return { messages, nextCursorId: page.nextCursorId, hasNext: page.hasNext };
    }
    // 삭제·접근 범위 변경으로 기준 행이 없으면 임의의 위치를 읽음으로 처리하지 않는다.
    if (!page.hasNext || !oldest || compareIds(firstUnread, oldest) >= 0) {
      throw new ChatContractError("CHAT_ENTRY_ANCHOR_MISSING");
    }
    boundary = page.nextCursorId;
    if (!boundary) throw new ChatContractError("INVALID_CHAT_CURSOR");
    page = await fetchPrevious(boundary);
  }
}


export async function refreshMessageWindow(
  firstPage: MessagePage, firstVisible: string, beforeId: string | null,
  fetchPrevious: (cursor: string) => Promise<MessagePage>,
): Promise<ChatMessage[]> {
  wireId(firstVisible);
  if (beforeId) wireId(beforeId);
  let page = firstPage;
  let boundary = beforeId;
  let roomId: string | null = null;
  let messages: ChatMessage[] = [];

  // 재조회는 정확한 앵커 존재를 요구하지 않는다. 삭제된 가시 행도 범위 비교로 확인할 수 있게 한다.
  for (;;) {
    let previous: string | null = null;
    for (const message of page.messages) {
      wireId(message.id);
      wireId(message.chatRoomId);
      roomId ??= message.chatRoomId;
      if (message.chatRoomId !== roomId || (boundary && compareIds(message.id, boundary) >= 0)
        || (previous && compareIds(message.id, previous) <= 0)) throw new ChatContractError("INVALID_CHAT_CURSOR");
      previous = message.id;
    }
    const oldest = page.messages[0]?.id ?? null;
    if (page.nextCursorId) wireId(page.nextCursorId);
    if (typeof page.hasNext !== "boolean" || (page.hasNext
      ? !oldest || page.nextCursorId !== oldest : page.nextCursorId !== null)) throw new ChatContractError("INVALID_CHAT_CURSOR");
    messages = mergeMessages(messages, page.messages);
    if (!page.hasNext || (oldest && compareIds(oldest, firstVisible) <= 0)) return messages;
    boundary = page.nextCursorId;
    if (!boundary) throw new ChatContractError("INVALID_CHAT_CURSOR");
    page = await fetchPrevious(boundary);
  }
}
