import type { createApiClient } from "../../api/client.ts";
import { ChatContractError, count, record, wireId } from "../../domain/chat/contracts.ts";
import { createChatService } from "../chat/service.ts";
import { parseAiMember, parseAiSafeProfile, parseAiSettings, validateAiProfile, validateAiSettings,
  type AiProfileInput, type AiSettingsPatch } from "./contracts.ts";

export function createAiService(api: ReturnType<typeof createApiClient>) {
  const chat = createChatService(api);
  const path = (roomId: string) => `/chat/rooms/${wireId(roomId)}`;
  const memberPath = (roomId: string, memberId: string) => `${path(roomId)}/ai-members/${wireId(memberId)}`;
  const member = (value: unknown, roomId: string, memberId?: string) => {
    const result = parseAiMember(value, roomId);
    if (memberId && result.aiMemberId !== memberId) throw new ChatContractError();
    return result;
  };
  return {
    room: chat.room,
    async settings(roomId: string, signal?: AbortSignal) {
      return parseAiSettings(await api.request(`${path(roomId)}/ai-settings`, { signal }), roomId);
    },
    async members(roomId: string, signal?: AbortSignal) {
      const dto = record(await api.request(`${path(roomId)}/ai-members`, { signal }));
      if (!Array.isArray(dto.members)) throw new ChatContractError();
      // 목록의 방 ID와 각 구성원의 방을 모두 확인한다.
      if (wireId(roomId) !== dto.chatRoomId) throw new ChatContractError();
      const members = dto.members.map(value => member(value, roomId));
      if (new Set(members.map(value => value.aiMemberId)).size !== members.length) throw new ChatContractError();
      return { members, currentCount: count(dto.currentCount), maxCount: count(dto.maxCount) };
    },
    async profile(roomId: string, memberId: string, signal?: AbortSignal) {
      const result = parseAiSafeProfile(await api.request(`${memberPath(roomId, memberId)}/profile`, { signal }));
      if (result.aiMemberId !== memberId) throw new ChatContractError();
      return result;
    },
    async create(roomId: string, input: AiProfileInput, signal?: AbortSignal) {
      // 서버에 생성 멱등 키가 없으므로 이 POST는 자동 재전송하지 않는다.
      const body = validateAiProfile(input);
      return member(await api.request(`${path(roomId)}/ai-members`, { method: "POST", body, signal }), roomId);
    },
    async update(roomId: string, memberId: string, input: AiProfileInput, signal?: AbortSignal) {
      const body = validateAiProfile(input);
      return member(await api.request(memberPath(roomId, memberId), { method: "PATCH", body, signal }), roomId, memberId);
    },
    async remove(roomId: string, memberId: string, signal?: AbortSignal) {
      return member(await api.request(memberPath(roomId, memberId), { method: "DELETE", signal }), roomId, memberId);
    },
    async updateSettings(roomId: string, patch: AiSettingsPatch, signal?: AbortSignal) {
      const body = validateAiSettings(patch);
      return parseAiSettings(await api.request(`${path(roomId)}/ai-settings`, { method: "PATCH", body, signal }), roomId);
    },
  };
}

export type AiService = ReturnType<typeof createAiService>;
