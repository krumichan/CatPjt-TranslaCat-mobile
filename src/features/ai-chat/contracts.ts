import { ChatContractError, count, flag, record, safeId, text } from "../../domain/chat/contracts.ts";

export interface AiProfileInput {
  nickname: string;
  bio: string | null;
  originalLanguageCode: string;
  personaPrompt: string;
}

export interface AiSafeProfile {
  aiMemberId: string;
  nickname: string;
  bio: string | null;
  originalLanguageCode: string;
  active: boolean;
  joinedAt: string;
}

export interface AiMember extends AiSafeProfile {
  aiAgentId: string;
  chatRoomId: string;
  personaPrompt: string;
}

export interface AiSettings {
  chatRoomId: string;
  aiEnabled: boolean;
  currentAiMemberCount: number;
  maxAiMembersPerRoom: number;
  disclosureType: "PUBLIC" | "PRIVATE";
  mentionPermission: "ALL_MEMBERS" | "OWNER_ADMIN_ONLY";
  conversationEnabled: boolean;
  revivalEnabled: boolean;
}

export type AiSettingsPatch = Partial<Pick<AiSettings,
  "disclosureType" | "mentionPermission" | "conversationEnabled" | "revivalEnabled">>;

export class AiInputError extends Error {
  constructor() { super("AI_INPUT_INVALID"); }
}

export function validateAiProfile(input: AiProfileInput): AiProfileInput {
  // HTTP DTO도 trim 이전 길이를 검사하므로 공백으로 제한을 우회하지 않는다.
  if (typeof input.nickname !== "string" || !input.nickname.trim() || input.nickname.length > 50
    || (input.bio !== null && (typeof input.bio !== "string" || input.bio.length > 200))
    || typeof input.originalLanguageCode !== "string" || !input.originalLanguageCode.trim() || input.originalLanguageCode.length > 10
    || typeof input.personaPrompt !== "string" || !input.personaPrompt.trim() || input.personaPrompt.length > 4000) {
    throw new AiInputError();
  }
  return {
    nickname: input.nickname.trim(), bio: input.bio?.trim() || null,
    originalLanguageCode: input.originalLanguageCode.trim().toLowerCase(), personaPrompt: input.personaPrompt.trim(),
  };
}

export function parseAiSafeProfile(value: unknown): AiSafeProfile {
  const dto = record(value);
  // 안전 프로필에 추가 필드가 오더라도 persona/agent ID를 복사하지 않는다.
  return {
    aiMemberId: safeId(dto.aiMemberId), nickname: text(dto.nickname),
    bio: dto.bio == null ? null : text(dto.bio), originalLanguageCode: text(dto.originalLanguageCode),
    active: flag(dto.active), joinedAt: text(dto.joinedAt),
  };
}

export function parseAiMember(value: unknown, roomId: string): AiMember {
  const dto = record(value);
  const member = { ...parseAiSafeProfile(dto), aiAgentId: safeId(dto.aiAgentId),
    chatRoomId: safeId(dto.chatRoomId), personaPrompt: text(dto.personaPrompt) };
  if (member.chatRoomId !== roomId) throw new ChatContractError();
  return member;
}

export function parseAiSettings(value: unknown, roomId: string): AiSettings {
  const dto = record(value);
  if (safeId(dto.chatRoomId) !== roomId || !["PUBLIC", "PRIVATE"].includes(text(dto.disclosureType))
    || !["ALL_MEMBERS", "OWNER_ADMIN_ONLY"].includes(text(dto.mentionPermission))) throw new ChatContractError();
  return {
    chatRoomId: roomId, aiEnabled: flag(dto.aiEnabled), currentAiMemberCount: count(dto.currentAiMemberCount),
    maxAiMembersPerRoom: count(dto.maxAiMembersPerRoom), disclosureType: dto.disclosureType as AiSettings["disclosureType"],
    mentionPermission: dto.mentionPermission as AiSettings["mentionPermission"],
    conversationEnabled: flag(dto.conversationEnabled), revivalEnabled: flag(dto.revivalEnabled),
  };
}

export function validateAiSettings(patch: AiSettingsPatch): AiSettingsPatch {
  const keys = Object.keys(patch);
  if (keys.length === 0 || keys.some(key => !["disclosureType", "mentionPermission", "conversationEnabled", "revivalEnabled"].includes(key))
    || (patch.disclosureType !== undefined && !["PUBLIC", "PRIVATE"].includes(patch.disclosureType))
    || (patch.mentionPermission !== undefined && !["ALL_MEMBERS", "OWNER_ADMIN_ONLY"].includes(patch.mentionPermission))
    || (patch.conversationEnabled !== undefined && typeof patch.conversationEnabled !== "boolean")
    || (patch.revivalEnabled !== undefined && typeof patch.revivalEnabled !== "boolean")) throw new AiInputError();
  return { ...patch };
}
