import { ChatContractError, count, flag, optionalId, record, safeId, text, wireId } from "../../domain/chat/contracts.ts";

export interface OpenInvitation {
  id: string;
  roomId: string;
  roomName: string | null;
  inviterNickname: string;
  inviterMemberCode: string;
  isRead: boolean;
  readAt: string | null;
  createdAt: string;
}

function timestamp(value: unknown): string {
  const result = text(value);
  if (!/^\d{4}-\d\d-\d\dT/.test(result) || !Number.isFinite(Date.parse(result))) throw new ChatContractError();
  return result;
}

export function invitationInput(targetPublicId: string, requestId: string) {
  const target = targetPublicId.trim();
  if (!target || target.length > 255
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) {
    throw new ChatContractError("INVALID_INVITATION_INPUT");
  }
  return { targetPublicId: target, requestId };
}

export function parseOpenInvitation(value: unknown): OpenInvitation {
  const dto = record(value);
  const payload = record(dto.payload);
  if (dto.notificationType !== "CHAT_INVITATION" || payload.schemaVersion !== 1
    || payload.invitationKind !== "OPEN_LINK" || payload.roomType !== "OPEN") throw new ChatContractError();
  const isRead = flag(dto.isRead);
  const readAt = dto.readAt == null ? null : timestamp(dto.readAt);
  if (isRead !== (readAt !== null)) throw new ChatContractError();
  // 외부 URL·이메일·계정 ID를 복사하지 않고 방별 초대 신원과 검증한 방 ID만 사용한다.
  return { id: safeId(dto.id), roomId: safeId(dto.roomId),
    roomName: payload.roomName == null ? null : text(payload.roomName),
    inviterNickname: text(payload.inviterOpenNickname), inviterMemberCode: text(payload.inviterMemberCode),
    isRead, readAt, createdAt: timestamp(dto.createdAt) };
}

export function parseInvitationPage(value: unknown, cursor: string | null) {
  const dto = record(value);
  if (!Array.isArray(dto.items) || dto.items.length > 20) throw new ChatContractError();
  let previous = cursor;
  const items = dto.items.map(value => {
    const item = parseOpenInvitation(value);
    if (previous && wireId(item.id) >= wireId(previous)) throw new ChatContractError("INVALID_INVITATION_CURSOR");
    previous = item.id;
    return item;
  });
  const hasNext = flag(dto.hasNext);
  const nextCursorId = optionalId(dto.nextCursorId);
  if (hasNext ? !items.length || !nextCursorId || nextCursorId !== previous : nextCursorId !== null) throw new ChatContractError();
  return { items, nextCursorId, hasNext };
}

export function parseInvitationSummary(value: unknown) {
  const dto = record(value);
  const latestInvitation = dto.latestInvitation == null ? null : parseOpenInvitation(dto.latestInvitation);
  const unreadCount = count(dto.unreadCount);
  if (unreadCount > 0 && !latestInvitation) throw new ChatContractError();
  return { unreadCount, latestInvitation };
}

export function parseInvitationSent(value: unknown, roomId: string) {
  const dto = record(value);
  if (safeId(dto.roomId) !== roomId) throw new ChatContractError();
  return { invitationId: safeId(dto.invitationId), roomId, createdAt: timestamp(dto.createdAt), duplicate: flag(dto.duplicate) };
}
