import type { ChatLanguageSettings, ChatMessage, ChatRoom, ChatTranslation, MessagePage, OpenProfile, OpenRoom } from "./types.ts";
import { profileImageUrl } from "./profile-image-url.ts";

export class ChatContractError extends Error {
  readonly code: string;

  constructor(code = "INVALID_CHAT_RESPONSE") {
    super(code);
    this.name = "ChatContractError";
    this.code = code;
  }
}

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ChatContractError();
  return value as Record<string, unknown>;
}

export function text(value: unknown): string {
  if (typeof value !== "string") throw new ChatContractError();
  return value;
}

export function flag(value: unknown): boolean {
  if (typeof value !== "boolean") throw new ChatContractError();
  return value;
}

export function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new ChatContractError();
  return value;
}

export function safeId(value: unknown): string {
  // JSON 숫자가 이미 반올림된 뒤에는 복구할 수 없으므로 문자열 변환 전에 안전 범위를 검사한다.
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new ChatContractError("UNSAFE_CHAT_ID");
  }
  return String(value);
}

export function wireId(value: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) throw new ChatContractError("UNSAFE_CHAT_ID");
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || String(numeric) !== value) throw new ChatContractError("UNSAFE_CHAT_ID");
  return numeric;
}

export function optionalId(value: unknown): string | null {
  return value == null ? null : safeId(value);
}

function optionalText(value: unknown): string | null {
  return value == null ? null : text(value);
}

export function parseRoom(value: unknown): ChatRoom {
  const dto = record(value);
  if (!["DIRECT", "GROUP", "OPEN"].includes(text(dto.roomType))) throw new ChatContractError();
  const partner = dto.directPartner == null ? null : record(dto.directPartner);
  optionalId(dto.ownerId);
  if (dto.myRole != null && !["OWNER", "ADMIN", "MEMBER"].includes(text(dto.myRole))) throw new ChatContractError();
  return {
    id: safeId(dto.id),
    roomType: dto.roomType as ChatRoom["roomType"],
    sourceType: text(dto.sourceType),
    myRole: dto.myRole == null ? null : dto.myRole as ChatRoom["myRole"],
    name: optionalText(dto.name),
    memberCount: count(dto.memberCount),
    unreadCount: dto.unreadCount == null ? 0 : count(dto.unreadCount),
    updatedAt: text(dto.updatedAt),
    active: dto.active == null ? true : flag(dto.active),
    partner: partner ? { userId: safeId(partner.userId), displayName: text(partner.displayName) } : null,
  };
}

export function parseTranslation(value: unknown): ChatTranslation {
  const dto = record(value);
  if (!["PENDING", "COMPLETED", "FAILED"].includes(text(dto.status))) throw new ChatContractError();
  return {
    id: safeId(dto.id), languageCode: text(dto.languageCode).toLowerCase(),
    status: dto.status as ChatTranslation["status"],
    translatedContent: optionalText(dto.translatedContent), completedAt: optionalText(dto.completedAt),
  };
}

export function parseMessage(value: unknown): ChatMessage {
  const dto = record(value);
  const visibility = dto.contentVisibility === undefined ? "VISIBLE" : text(dto.contentVisibility);
  if (!["VISIBLE", "BLOCKED", "MODERATED"].includes(visibility)) throw new ChatContractError();
  const authorDeleted = dto.authorDeleted === undefined ? false : flag(dto.authorDeleted);
  if (!["USER", "AI", "SYSTEM"].includes(text(dto.senderType))
    || !["TEXT", "SYSTEM"].includes(text(dto.messageType))
    || !["SENT", "DELETED"].includes(text(dto.status)) || !Array.isArray(dto.translations)) throw new ChatContractError();
  const sender = dto.sender == null ? null : record(dto.sender);
  const message: ChatMessage = {
    contentVisibility: visibility as ChatMessage["contentVisibility"], authorDeleted,
    id: safeId(dto.id), chatRoomId: safeId(dto.chatRoomId), senderUserId: optionalId(dto.senderUserId),
    senderAiMemberId: optionalId(dto.senderAiMemberId),
    senderType: dto.senderType as ChatMessage["senderType"], senderName: optionalText(dto.senderName),
    messageType: dto.messageType as ChatMessage["messageType"], content: text(dto.content),
    status: dto.status as ChatMessage["status"],
    unreadMemberCount: dto.unreadMemberCount == null ? null : count(dto.unreadMemberCount),
    translations: dto.translations.map(parseTranslation), createdAt: text(dto.createdAt), updatedAt: text(dto.updatedAt),
    sender: sender ? {
      openChatMemberId: safeId(sender.openChatMemberId), nickname: text(sender.nickname), memberCode: text(sender.memberCode),
      ...(sender.profileImageUrl !== undefined ? { profileImageUrl: profileImageUrl(sender.profileImageUrl) } : {}),
    } : null,
  };
  // 차단/운영 숨김은 원문·번역·프로필을 앱 메모리에도 합치지 않는다. 탈퇴 표시는 서버의 실명과 분리한다.
  if (visibility !== "VISIBLE") return { ...message, content: visibility === "BLOCKED" ? "차단한 사용자의 메시지입니다." : "운영 정책에 따라 숨겨진 메시지입니다.",
    translations: [], senderUserId: null, senderAiMemberId: null, senderName: null, sender: null };
  if (authorDeleted) return { ...message, senderUserId: null, senderName: "탈퇴한 사용자",
    sender: message.sender ? { ...message.sender, nickname: "탈퇴한 사용자", memberCode: "",
      ...(message.sender.profileImageUrl !== undefined ? { profileImageUrl: null } : {}) } : null };
  return message;
}

export function parseMessagePage(value: unknown): MessagePage {
  const dto = record(value);
  if (!Array.isArray(dto.messages)) throw new ChatContractError();
  return { messages: dto.messages.map(parseMessage), nextCursorId: optionalId(dto.nextCursorId), hasNext: flag(dto.hasNext) };
}

export function parseLanguage(value: unknown): ChatLanguageSettings {
  const dto = record(value);
  return {
    translationLanguageCode: text(dto.translationLanguageCode).toLowerCase(),
    showOriginal: flag(dto.showOriginal), showTranslation: flag(dto.showTranslation),
  };
}

export function parseOpenProfile(value: unknown): OpenProfile {
  const dto = record(value);
  return {
    openChatMemberId: safeId(dto.openChatMemberId), nickname: text(dto.nickname),
    memberCode: text(dto.memberCode), joinedAt: text(dto.joinedAt),
    ...(dto.profileImageUrl !== undefined ? { profileImageUrl: profileImageUrl(dto.profileImageUrl) } : {}),
  };
}

export function parseOpenRoom(value: unknown): OpenRoom {
  const dto = record(value);
  return {
    id: safeId(dto.id), name: text(dto.name), description: text(dto.description),
    memberCount: count(dto.memberCount), maxMemberCount: count(dto.maxMemberCount),
    joined: flag(dto.joined), joinable: flag(dto.joinable), joinBlockedReason: text(dto.joinBlockedReason),
    myOpenProfile: dto.myOpenProfile == null ? null : parseOpenProfile(dto.myOpenProfile),
  };
}
