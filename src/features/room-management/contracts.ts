import { ChatContractError, flag, optionalId, record, safeId, text, wireId } from "../../domain/chat/contracts.ts";
import type { ChatRoom } from "../../domain/chat/types.ts";

export type ManagedRoom = ChatRoom & { closed?: boolean };

export type MemberRole = "OWNER" | "ADMIN" | "MEMBER";
export interface RoomMember {
  id: string;
  displayName: string;
  publicId: string | null;
  memberCode: string | null;
  role: MemberRole;
  active: boolean;
}
export interface RoomBan {
  id: string;
  memberId: string;
  displayName: string;
  memberCode: string;
  reason: string;
  releasable: boolean;
}
export interface InviteTargets { userIds: string[]; publicIds: string[] }
export class ManagementInputError extends Error {}

function role(value: unknown): MemberRole {
  if (value !== "OWNER" && value !== "ADMIN" && value !== "MEMBER") throw new ChatContractError();
  return value;
}

export function parseOpenMember(value: unknown): RoomMember {
  const dto = record(value);
  // 방 전용 신원만 사용한다. 서버가 실수로 추가한 계정 ID/이메일은 복사하지 않는다.
  return { id: safeId(dto.openChatMemberId), displayName: text(dto.nickname), publicId: null,
    memberCode: text(dto.memberCode), role: role(dto.role), active: flag(dto.active) };
}

export function parseMembers(value: unknown, roomId: string, open: boolean): RoomMember[] {
  const dto = record(value);
  if (!Array.isArray(dto.members)) throw new ChatContractError();
  const seen = new Set<string>();
  return dto.members.map(value => {
    const item = record(value);
    if (!open && safeId(item.chatRoomId) !== roomId) throw new ChatContractError();
    const member: RoomMember = open ? parseOpenMember(item) : {
      id: safeId(item.userId), displayName: text(item.displayName),
      publicId: item.publicId == null ? null : text(item.publicId), memberCode: null,
      role: role(item.role), active: flag(item.active),
    };
    if (!member.active || seen.has(member.id)) throw new ChatContractError();
    seen.add(member.id);
    return member;
  });
}

export function inviteBody(input: InviteTargets) {
  const targetUserIds = [...new Set(input.userIds)].map(wireId);
  const targetPublicIds = [...new Set(input.publicIds.map(id => id.trim()).filter(Boolean))];
  if (!targetUserIds.length && !targetPublicIds.length) throw new ManagementInputError("INVITE_TARGET_REQUIRED");
  return { targetUserIds, targetPublicIds };
}

export function banBody(id: string, reason: string) {
  if (!reason.trim() || reason.length > 500) throw new ManagementInputError("BAN_REASON_REQUIRED");
  return { targetOpenChatMemberId: wireId(id), reason: reason.trim() };
}

export function parseBanPage(value: unknown, cursor: string | null) {
  const dto = record(value);
  if (!Array.isArray(dto.items) || dto.items.length > 20) throw new ChatContractError();
  let previous = cursor;
  const items: RoomBan[] = dto.items.map(value => {
    const item = record(value);
    const id = safeId(item.banId);
    if (previous && wireId(id) >= wireId(previous)) throw new ChatContractError();
    previous = id;
    return { id, memberId: safeId(item.targetOpenChatMemberId), displayName: text(item.nickname),
      memberCode: text(item.memberCode), reason: text(item.reason), releasable: flag(item.releasable) };
  });
  const hasNext = flag(dto.hasNext);
  const nextCursor = optionalId(dto.nextCursorId);
  if (hasNext ? !items.length || !nextCursor || nextCursor !== previous : nextCursor !== null) throw new ChatContractError();
  return { items, nextCursor, hasNext };
}
