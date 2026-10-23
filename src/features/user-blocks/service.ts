import type { createApiClient } from "../../api/client.ts";
import { ChatContractError, record, safeId, text, wireId } from "../../domain/chat/contracts.ts";
import { createFriendService, type FriendPerson } from "../friends/service.ts";

export interface UserBlock { id: string; user: FriendPerson; createdAt: string }

export function parseUserBlock(value: unknown): UserBlock {
  const dto = record(value);
  const user = record(dto.blockedUser);
  return { id: safeId(dto.id), user: { userId: safeId(user.userId), publicId: text(user.publicId), nickname: text(user.nickname) },
    createdAt: text(dto.createdAt) };
}

export function createUserBlockService(api: ReturnType<typeof createApiClient>) {
  return {
    search: createFriendService(api).search,
    async list(signal?: AbortSignal) {
      const value = await api.request("/blocks", { signal });
      if (!Array.isArray(value)) throw new ChatContractError();
      const blocks = value.map(parseUserBlock);
      if (new Set(blocks.map(block => block.id)).size !== blocks.length
        || new Set(blocks.map(block => block.user.userId)).size !== blocks.length) throw new ChatContractError();
      return blocks;
    },
    async block(target: FriendPerson, signal?: AbortSignal) {
      // 확인한 공개 ID만 전송하고 응답의 계정 ID와 공개 ID가 같은 대상인지 대조한다.
      wireId(target.userId);
      if (!target.publicId.trim()) throw new ChatContractError();
      const block = parseUserBlock(await api.request("/blocks", {
        method: "POST", body: { blockedPublicId: target.publicId }, signal,
      }));
      if (block.user.userId !== target.userId || block.user.publicId !== target.publicId) throw new ChatContractError();
      return block;
    },
    async unblock(userId: string, signal?: AbortSignal) {
      // DELETE 경로는 차단 행 ID가 아니라 대상 사용자 ID다.
      const result = await api.request(`/blocks/${wireId(userId)}`, { method: "DELETE", signal });
      if (result !== true) throw new ChatContractError();
    },
  };
}
export type UserBlockService = ReturnType<typeof createUserBlockService>;

