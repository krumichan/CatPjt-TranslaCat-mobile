import { optionalId, parseMessage, parseTranslation, record, safeId, text } from "../domain/chat/contracts.ts";
import type { ChatMessage, ChatTranslation } from "../domain/chat/types.ts";

export type RoomEvent =
  | { kind: "message"; roomId: string; message: ChatMessage }
  | { kind: "translation"; roomId: string; messageId: string; translation: ChatTranslation }
  | { kind: "read"; roomId: string; last: string | null }
  | { kind: "memberRead"; roomId: string; readerUserId: string | null; readerOpenChatMemberId: string | null; previous: string | null; last: string }
  | { kind: "refresh"; roomId: string };

export function parseRoomEvent(raw: string): RoomEvent | null {
  const envelope = record(JSON.parse(raw));
  const type = envelope.eventType ?? envelope.type;
  const dto = record(envelope.payload ?? envelope.data ?? envelope);
  if (type === "chat.message.created") {
    const message = parseMessage(envelope.message ?? dto.message ?? dto);
    return { kind: "message", roomId: message.chatRoomId, message };
  }
  if (type === "chat.translation.completed" || type === "chat.translation.failed") {
    const translation = parseTranslation(dto.translation ?? {
      id: dto.translationId, languageCode: dto.languageCode, status: dto.status,
      translatedContent: dto.translatedContent ?? dto.translatedText ?? null,
      completedAt: dto.completedAt ?? dto.occurredAt ?? null,
    });
    return { kind: "translation", roomId: safeId(dto.chatRoomId ?? dto.roomId), messageId: safeId(dto.messageId), translation };
  }
  if (type === "chat.read.updated") {
    return { kind: "read", roomId: safeId(dto.chatRoomId), last: optionalId(dto.lastReadMessageId) };
  }
  if (type === "chat.member.read.updated" && dto.lastReadMessageId != null) {
    return {
      kind: "memberRead", roomId: safeId(dto.chatRoomId), last: safeId(dto.lastReadMessageId),
      previous: optionalId(dto.previousLastReadMessageId), readerUserId: optionalId(dto.readerUserId),
      readerOpenChatMemberId: optionalId(dto.readerOpenChatMemberId),
    };
  }
  if (["chat.members.changed", "chat.open-profile.updated", "chat.member.role.updated", "chat.member.banned", "chat.room.closed"].includes(String(type))) {
    return { kind: "refresh", roomId: safeId(dto.roomId ?? dto.chatRoomId) };
  }
  if (typeof type === "string") text(type);
  return null;
}
