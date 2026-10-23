import type { createApiClient } from "../../api/client.ts";
import { ChatContractError, flag, record, safeId, wireId } from "../../domain/chat/contracts.ts";
import { createChatService } from "../chat/service.ts";
import { createFriendService } from "../friends/service.ts";
import { createOpenInvitationService } from "../open-invitations/service.ts";
import { banBody, inviteBody, parseBanPage, parseMembers, parseOpenMember, type InviteTargets, type ManagedRoom } from "./contracts.ts";

export function createRoomManagementService(api: ReturnType<typeof createApiClient>) {
  const chat = createChatService(api);
  const friends = createFriendService(api);
  const openInvitations = createOpenInvitationService(api);
  const openPath = (roomId: string) => `/chat/open-rooms/${wireId(roomId)}`;
  const requireRoom = (value: unknown, roomId: string, key: "roomId" | "id" = "roomId") => {
    const dto = record(value);
    if (safeId(dto[key]) !== roomId) throw new ChatContractError();
    return dto;
  };
  return {
    // 채팅·AI·방 관리가 같은 OPEN 종료 상태 판정을 사용한다.
    room: (roomId: string, signal?: AbortSignal): Promise<ManagedRoom> => chat.room(roomId, signal),
    friends: friends.friends,
    sendOpenInvitation: openInvitations.send,
    async members(roomId: string, open: boolean, signal?: AbortSignal) {
      const path = open ? openPath(roomId) : `/chat/rooms/${wireId(roomId)}`;
      return parseMembers(await api.request(`${path}/members`, { signal }), roomId, open);
    },
    async me(roomId: string, signal?: AbortSignal) {
      const member = parseOpenMember(await api.request(`${openPath(roomId)}/me/profile`, { signal }));
      if (!member.active) throw new ChatContractError();
      return member;
    },
    async invite(roomId: string, input: InviteTargets, signal?: AbortSignal) {
      const body = inviteBody(input);
      const dto = requireRoom(await api.request(`/chat/rooms/${wireId(roomId)}/members/invitations`,
        { method: "POST", body, signal }), roomId);
      if (flag(dto.createdNewGroupRoom) || !Array.isArray(dto.invitedMembers) || !dto.invitedMembers.length) throw new ChatContractError();
      for (const member of dto.invitedMembers) safeId(record(member).userId);
    },
    async leave(roomId: string, signal?: AbortSignal) {
      // 실제 CHAT 응답은 joined/myRole/myOpenProfile이다. 오래된 웹 DTO의 active 필드를 가정하지 않는다.
      const dto = requireRoom(await api.request(`${openPath(roomId)}/leave`, { method: "DELETE", signal }), roomId);
      if (flag(dto.joined)) throw new ChatContractError();
    },
    async close(roomId: string, signal?: AbortSignal) {
      const dto = requireRoom(await api.request(`${openPath(roomId)}/close`, { method: "POST", signal }), roomId, "id");
      if (dto.status !== "CLOSED") throw new ChatContractError();
    },
    async transfer(roomId: string, memberId: string, signal?: AbortSignal) {
      const dto = requireRoom(await api.request(`${openPath(roomId)}/owner-transfer`,
        { method: "POST", body: { targetOpenChatMemberId: wireId(memberId) }, signal }), roomId, "id");
      const owner = parseOpenMember(dto.ownerProfile);
      if (owner.id !== memberId || owner.role !== "OWNER" || !owner.active || dto.myRole !== "MEMBER") throw new ChatContractError();
    },
    async changeAdmin(roomId: string, memberId: string, assign: boolean, signal?: AbortSignal) {
      const member = parseOpenMember(await api.request(`${openPath(roomId)}/admins/${wireId(memberId)}`,
        { method: assign ? "POST" : "DELETE", signal }));
      if (member.id !== memberId || !member.active || member.role !== (assign ? "ADMIN" : "MEMBER")) throw new ChatContractError();
    },
    async ban(roomId: string, memberId: string, reason: string, signal?: AbortSignal) {
      const dto = requireRoom(await api.request(`${openPath(roomId)}/bans`,
        { method: "POST", body: banBody(memberId, reason), signal }), roomId);
      safeId(dto.banId);
      if (safeId(dto.targetOpenChatMemberId) !== memberId || !flag(dto.active)) throw new ChatContractError();
    },
    async bans(roomId: string, cursor: string | null, signal?: AbortSignal) {
      const query = new URLSearchParams({ size: "20" });
      if (cursor) query.set("cursor", String(wireId(cursor)));
      return parseBanPage(await api.request(`${openPath(roomId)}/bans?${query}`, { signal }), cursor);
    },
    async releaseBan(roomId: string, banId: string, signal?: AbortSignal) {
      const dto = requireRoom(await api.request(`${openPath(roomId)}/bans/${wireId(banId)}/release`,
        { method: "PATCH", signal }), roomId);
      if (safeId(dto.banId) !== banId || flag(dto.active)) throw new ChatContractError();
    },
  };
}
export type RoomManagementService = ReturnType<typeof createRoomManagementService>;
