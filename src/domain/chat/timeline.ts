import { ChatContractError } from "./contracts.ts";
import type { ChatMessage, ChatTranslation, MessagePage } from "./types.ts";

export function compareIds(a: string, b: string): number {
  return a.length - b.length || a.localeCompare(b);
}

export function latestMessageId(messages: ChatMessage[]): string | null {
  return messages.reduce<string | null>((latest, message) => !latest || compareIds(message.id, latest) > 0 ? message.id : latest, null);
}

export function mergeTranslations(current: ChatTranslation[], incoming: ChatTranslation[]): ChatTranslation[] {
  const byLanguage = new Map(current.map((translation) => [translation.languageCode, translation]));
  for (const translation of incoming) {
    const previous = byLanguage.get(translation.languageCode);
    // 같은 번역 행의 완료 상태는 서버에서 재시도하지 않는다. 시각 없는 과거 실패도 거부한다.
    if (previous?.id === translation.id && previous.status === "COMPLETED" && translation.status !== "COMPLETED") continue;
    // 이전 REST 응답의 PENDING이 이미 받은 번역 결과를 되돌리지 않도록 한다.
    if (previous && previous.status !== "PENDING" && translation.status === "PENDING") continue;
    if (previous?.completedAt && translation.completedAt
      && Date.parse(previous.completedAt) > Date.parse(translation.completedAt)) continue;
    byLanguage.set(translation.languageCode, translation);
  }
  return [...byLanguage.values()];
}

export function mergeMessages(
  current: ChatMessage[], incoming: ChatMessage[], options: { authoritativeUnreadCounts?: boolean } = {},
): ChatMessage[] {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) {
    const previous = byId.get(message.id);
    byId.set(message.id, previous ? {
      ...previous, ...message,
      status: previous.status === "DELETED" ? "DELETED" : message.status,
      // 재조회한 집계만 정답으로 교체한다. 일반 메시지·지연 응답은 기존 감소 방향을 유지한다.
      unreadMemberCount: options.authoritativeUnreadCounts && message.unreadMemberCount !== null ? message.unreadMemberCount
        : previous.unreadMemberCount === null ? message.unreadMemberCount
          : message.unreadMemberCount === null ? previous.unreadMemberCount : Math.min(previous.unreadMemberCount, message.unreadMemberCount),
      translations: message.contentVisibility !== undefined && message.contentVisibility !== "VISIBLE"
        ? [] : mergeTranslations(previous.translations, message.translations),
    } : message);
  }
  return [...byId.values()].sort((a, b) => compareIds(a.id, b.id));
}

export async function catchUpMessages(
  cursor: string,
  fetchAfter: (cursor: string) => Promise<MessagePage>,
  applyPage: (messages: ChatMessage[]) => void,
): Promise<string> {
  let next = cursor;
  // 복귀 중 누락된 모든 페이지를 따라간다. 실시간으로 먼저 도착한 큰 ID를 시작점으로 사용하지 않는다.
  for (;;) {
    const page = await fetchAfter(next);
    const latest = latestMessageId(page.messages);
    if (page.messages.some((message) => compareIds(message.id, next) <= 0)
      || (page.hasNext && (!latest || page.nextCursorId !== latest))) throw new ChatContractError("INVALID_CHAT_CURSOR");
    applyPage(page.messages);
    if (!page.hasNext) return latest && compareIds(latest, next) > 0 ? latest : next;
    if (!page.nextCursorId || compareIds(page.nextCursorId, next) <= 0) throw new ChatContractError("INVALID_CHAT_CURSOR");
    next = page.nextCursorId;
  }
}

export async function recoverEmptyRoomHistory(
  firstPage: MessagePage,
  fetchPrevious: (cursor: string) => Promise<MessagePage>,
  applyPage: (messages: ChatMessage[]) => void,
): Promise<string | null> {
  const latest = latestMessageId(firstPage.messages);
  let page = firstPage;
  let previousBoundary: string | null = null;
  // 최초 빈 응답 뒤에는 안전한 after 기준 행이 없으므로 가장 오래된 접근 가능 행까지 복원한다.
  for (;;) {
    const oldest = [...page.messages].sort((a, b) => compareIds(a.id, b.id))[0]?.id ?? null;
    const boundary = previousBoundary;
    if (boundary && page.messages.some((message) => compareIds(message.id, boundary) >= 0)) {
      throw new ChatContractError("INVALID_CHAT_CURSOR");
    }
    if (page.hasNext && (!oldest || page.nextCursorId !== oldest)) throw new ChatContractError("INVALID_CHAT_CURSOR");
    applyPage(page.messages);
    if (!page.hasNext) return latest;
    previousBoundary = page.nextCursorId;
    if (!previousBoundary) throw new ChatContractError("INVALID_CHAT_CURSOR");
    page = await fetchPrevious(previousBoundary);
  }
}

export function applyMemberRead(
  messages: ChatMessage[],
  event: { readerUserId: string | null; readerOpenChatMemberId: string | null; previous: string | null; last: string },
  seen: Map<string, string>,
): ChatMessage[] {
  const reader = event.readerOpenChatMemberId ? `open:${event.readerOpenChatMemberId}`
    : event.readerUserId ? `user:${event.readerUserId}` : null;
  if (!reader) return messages;
  const previous = seen.get(reader);
  if (previous && compareIds(event.last, previous) <= 0) return messages;
  const lower = previous && (!event.previous || compareIds(previous, event.previous) > 0) ? previous : event.previous;
  seen.set(reader, event.last);
  return messages.map((message) => {
    const fromReader = (event.readerUserId !== null && message.senderUserId === event.readerUserId)
      || (event.readerOpenChatMemberId !== null && message.sender?.openChatMemberId === event.readerOpenChatMemberId);
    if (fromReader || message.senderType === "SYSTEM" || message.messageType === "SYSTEM"
      || message.unreadMemberCount == null || message.unreadMemberCount <= 0
      || (lower !== null && compareIds(message.id, lower) <= 0) || compareIds(message.id, event.last) > 0) return message;
    return { ...message, unreadMemberCount: Math.max(0, message.unreadMemberCount - 1) };
  });
}
