import type { createApiClient } from "../../api/client.ts";
import { flag, optionalId, parseLanguage, parseMessage, parseMessagePage, parseOpenProfile, parseOpenRoom, parseRoom, record, safeId, count, wireId, ChatContractError } from "../../domain/chat/contracts.ts";
import type { ChatMessage, MessagePage, OpenRoom } from "../../domain/chat/types.ts";
import { compareIds } from "../../domain/chat/timeline.ts";

function roomPage(page: MessagePage, roomId: string): MessagePage {
  if (page.messages.some((message) => message.chatRoomId !== roomId)) throw new ChatContractError();
  return page;
}

export function createChatService(api: ReturnType<typeof createApiClient>) {
  return {
    async rooms(signal?: AbortSignal) {
      const dto = record(await api.request("/chat/rooms", { signal }));
      if (!Array.isArray(dto.chatRooms)) throw new ChatContractError();
      return dto.chatRooms.map(parseRoom);
    },
    async room(roomId: string, signal?: AbortSignal) {
      const room = parseRoom(await api.request(`/chat/rooms/${wireId(roomId)}`, { signal }));
      if (room.id !== roomId) throw new ChatContractError();
      if (room.roomType !== "OPEN") return room;
      // 일반 방의 active와 OPEN의 CLOSED는 별개이므로 종료 상태를 상세에서 확인한다.
      const detail = record(await api.request(`/chat/open-rooms/${wireId(roomId)}`, { signal }));
      if (safeId(detail.id) !== roomId || !["ACTIVE", "CLOSED"].includes(String(detail.status))) throw new ChatContractError();
      return { ...room, closed: detail.status === "CLOSED" };
    },
    async firstUnread(roomId: string, signal?: AbortSignal): Promise<string | null> {
      wireId(roomId);
      let cursor: string | null = null;
      const seenRooms = new Set<string>();

      // 미읽음 수로 위치를 추측하지 않고 서버가 계산한 첫 미읽음 ID를 찾는다.
      for (;;) {
        const query = new URLSearchParams({ size: "50" });
        if (cursor) query.set("cursorMessageId", String(wireId(cursor)));
        const dto = record(await api.request(`/chat/notifications/chats?${query.toString()}`, { signal }));
        if (!Array.isArray(dto.items) || dto.items.length > 50) throw new ChatContractError();
        const hasNext = flag(dto.hasNext);
        const next = optionalId(dto.nextCursorMessageId);
        let previous = cursor;
        let found: string | null = null;

        // 응답 전체를 검증한 뒤 사용한다. 다른 방이나 불안전한 숫자가 목표 방 뒤에 있어도 거절한다.
        for (const value of dto.items) {
          const item = record(value);
          const itemRoomId = safeId(item.roomId);
          const latestId = safeId(record(item.latestMessage).id);
          const firstId = safeId(item.firstUnreadMessageId);
          if (seenRooms.has(itemRoomId) || count(item.unreadCount) === 0
            || compareIds(firstId, latestId) > 0 || (previous && compareIds(latestId, previous) >= 0)) {
            throw new ChatContractError("INVALID_CHAT_CURSOR");
          }
          seenRooms.add(itemRoomId);
          previous = latestId;
          if (itemRoomId === roomId) found = firstId;
        }
        if (hasNext ? !next || previous === cursor || next !== previous : next !== null) {
          throw new ChatContractError("INVALID_CHAT_CURSOR");
        }
        if (found) return found;
        if (!hasNext) return null;
        cursor = next;
      }
    },
    async messages(roomId: string, cursor: string | null, signal?: AbortSignal) {
      const query = cursor ? `?cursorId=${wireId(cursor)}` : "";
      return roomPage(parseMessagePage(await api.request(`/chat/rooms/${wireId(roomId)}/messages${query}`, { signal })), roomId);
    },
    async after(roomId: string, cursor: string, signal?: AbortSignal) {
      return roomPage(parseMessagePage(await api.request(`/chat/rooms/${wireId(roomId)}/messages/after?cursorId=${wireId(cursor)}&size=100`, { signal })), roomId);
    },
    async language(roomId: string, signal?: AbortSignal) {
      const dto = record(await api.request(`/chat/rooms/${wireId(roomId)}/language-settings`, { signal }));
      if (safeId(dto.chatRoomId) !== roomId) throw new ChatContractError();
      return parseLanguage(dto);
    },
    async send(roomId: string, content: string, signal?: AbortSignal): Promise<ChatMessage> {
      // 현재 서버에는 멱등 전송 키가 없다. 이 요청을 자동으로 재시도하지 않는다.
      const message = parseMessage(await api.request(`/chat/rooms/${wireId(roomId)}/messages`, {
        method: "POST", body: { content }, signal,
      }));
      if (message.chatRoomId !== roomId) throw new ChatContractError();
      return message;
    },
    async read(roomId: string, messageId: string, signal?: AbortSignal) {
      const dto = record(await api.request(`/chat/rooms/${wireId(roomId)}/read`, {
        method: "PATCH", body: { lastReadMessageId: wireId(messageId) }, signal,
      }));
      if (safeId(dto.chatRoomId) !== roomId) throw new ChatContractError();
      return { lastReadMessageId: optionalId(dto.lastReadMessageId), unreadCount: count(dto.unreadCount) };
    },
    async myOpenProfile(roomId: string, signal?: AbortSignal) {
      return parseOpenProfile(await api.request(`/chat/open-rooms/${wireId(roomId)}/me/profile`, { signal }));
    },
    async openRooms(keyword: string, cursor: string | null, signal?: AbortSignal) {
      const query = new URLSearchParams({ size: "20" });
      if (keyword.trim()) query.set("keyword", keyword.trim());
      if (cursor) query.set("cursorId", String(wireId(cursor)));
      const dto = record(await api.request(`/chat/open-rooms?${query.toString()}`, { signal }));
      if (!Array.isArray(dto.openChatRooms)) throw new ChatContractError();
      return { rooms: dto.openChatRooms.map(parseOpenRoom), nextCursorId: optionalId(dto.nextCursorId), hasNext: flag(dto.hasNext) };
    },
    async openRoom(roomId: string, signal?: AbortSignal): Promise<OpenRoom> {
      const room = parseOpenRoom(await api.request(`/chat/open-rooms/${wireId(roomId)}`, { signal }));
      if (room.id !== roomId) throw new ChatContractError();
      return room;
    },
    async join(roomId: string, nickname: string | null, signal?: AbortSignal) {
      const room = parseOpenRoom(await api.request(`/chat/open-rooms/${wireId(roomId)}/join`, {
        method: "POST", signal,
        ...(nickname === null ? {} : { body: { profile: { nickname, profileImageObjectKey: null } } }),
      }));
      if (room.id !== roomId) throw new ChatContractError();
      return room;
    },
  };
}

export type ChatService = ReturnType<typeof createChatService>;

export function chatErrorMessage(error: unknown): string {
  if (error instanceof ChatContractError && error.code === "UNSAFE_CHAT_ID") {
    return "서버 식별자가 앱에서 안전하게 처리할 수 있는 범위를 벗어났어요. 지원팀에 문의해 주세요.";
  }
  if (error instanceof ChatContractError) return "대화 응답 형식을 확인하지 못했어요. 다시 불러와 주세요.";
  const status = error && typeof error === "object" && "status" in error ? error.status : null;
  if (status === 401) return "로그인 상태를 확인해 주세요.";
  if (status === 403 || status === 404) return "이 대화방에 접근할 수 없어요. 참여 상태를 확인해 주세요.";
  if (status === 400) return "참여 상태 또는 요청을 확인해 주세요. 방 상태가 변경됐을 수 있어요.";
  return "불러오지 못했어요. 연결 상태를 확인한 뒤 다시 시도해 주세요.";
}
