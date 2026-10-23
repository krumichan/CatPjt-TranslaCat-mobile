import type { createApiClient } from "../../api/client.ts";
import { ChatContractError, parseRoom, record, safeId, text, wireId } from "../../domain/chat/contracts.ts";

export interface FriendPerson { userId: string; publicId: string; nickname: string }
export interface FriendEntry extends FriendPerson { relationId: string }
export type FriendStatus = "NONE" | "FRIEND" | "REQUEST_SENT" | "REQUEST_RECEIVED" | "BLOCKED" | "SELF";
export interface FriendSearch extends FriendPerson { friendStatus: FriendStatus }
export interface FriendRequestEntry { id: string; status: "PENDING" | "ACCEPTED" | "REJECTED" | "CANCELED"; requester: FriendPerson; receiver: FriendPerson }

function person(value: unknown): FriendPerson {
  const dto = record(value);
  return { userId: safeId(dto.userId), publicId: text(dto.publicId), nickname: text(dto.nickname) };
}

function list<T>(value: unknown, parse: (entry: unknown) => T): T[] {
  if (!Array.isArray(value)) throw new ChatContractError();
  return value.map(parse);
}

export function parseFriend(value: unknown): FriendEntry {
  const dto = record(value);
  return { ...person(dto.friend), relationId: safeId(dto.id) };
}

export function parseFriendRequest(value: unknown): FriendRequestEntry {
  const dto = record(value);
  if (!["PENDING", "ACCEPTED", "REJECTED", "CANCELED"].includes(text(dto.status))) throw new ChatContractError();
  return { id: safeId(dto.id), status: dto.status as FriendRequestEntry["status"], requester: person(dto.requester), receiver: person(dto.receiver) };
}

export function parseFriendSearch(value: unknown): FriendSearch {
  const dto = record(value);
  if (!["NONE", "FRIEND", "REQUEST_SENT", "REQUEST_RECEIVED", "BLOCKED", "SELF"].includes(text(dto.friendStatus))) throw new ChatContractError();
  return { ...person(dto), friendStatus: dto.friendStatus as FriendStatus };
}

export function groupRequest(name: string, description: string, selected: string[], friends: FriendEntry[], selfId: string) {
  // 현재 친구 목록과 안전한 숫자 ID만 전송하고, 오래된 선택이나 자기 자신은 서버 호출 전에 거절한다.
  const memberUserIds = [...new Set(selected)].map(wireId);
  const friendIds = new Set(friends.map(friend => friend.userId));
  if (!name.trim() || name.trim().length > 100 || description.trim().length > 500 || !memberUserIds.length
    || selected.some(id => id === selfId || !friendIds.has(id))) throw new ChatContractError("INVALID_GROUP_INPUT");
  return { name: name.trim(), description: description.trim(), memberUserIds };
}

export function createFriendService(api: ReturnType<typeof createApiClient>) {
  return {
    async friends(signal?: AbortSignal) { return list(await api.request("/friends", { signal }), parseFriend); },
    async received(signal?: AbortSignal) { return list(await api.request("/friend-requests/received", { signal }), parseFriendRequest); },
    async sent(signal?: AbortSignal) { return list(await api.request("/friend-requests/sent", { signal }), parseFriendRequest); },
    async search(publicId: string, signal?: AbortSignal) {
      if (!publicId.trim()) throw new ChatContractError("PUBLIC_ID_REQUIRED");
      return parseFriendSearch(await api.request(`/users/search?${new URLSearchParams({ publicId: publicId.trim() })}`, { signal }));
    },
    async request(publicId: string, signal?: AbortSignal) {
      if (!publicId.trim()) throw new ChatContractError("PUBLIC_ID_REQUIRED");
      // 생성 응답은 목록 DTO와 달리 평탄한 ID를 포함하므로 임의로 사람 프로필을 복원하지 않는다.
      const dto = record(await api.request("/friend-requests", { method: "POST", body: { receiverPublicId: publicId.trim() }, signal }));
      safeId(dto.id);
      if (dto.status !== "PENDING") throw new ChatContractError();
    },
    async respond(requestId: string, action: "accept" | "reject" | "cancel", signal?: AbortSignal) {
      if (!["accept", "reject", "cancel"].includes(action)) throw new ChatContractError();
      return parseFriendRequest(await api.request(`/friend-requests/${wireId(requestId)}/${action}`, { method: "PATCH", signal }));
    },
    async direct(friendUserId: string, signal?: AbortSignal) {
      const room = parseRoom(await api.request(`/chat/friends/${wireId(friendUserId)}/direct-room`, { method: "POST", signal }));
      if (room.roomType !== "DIRECT" || !room.active || (room.partner !== null && room.partner.userId !== friendUserId)) throw new ChatContractError();
      return room;
    },
    async group(request: ReturnType<typeof groupRequest>, signal?: AbortSignal) {
      const room = parseRoom(await api.request("/chat/friends/group-rooms", { method: "POST", body: request, signal }));
      if (room.roomType !== "GROUP" || !room.active) throw new ChatContractError();
      return room;
    },
  };
}
