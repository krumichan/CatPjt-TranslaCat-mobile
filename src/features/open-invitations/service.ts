import type { createApiClient } from "../../api/client.ts";
import { ChatContractError, wireId } from "../../domain/chat/contracts.ts";
import { invitationInput, parseInvitationPage, parseInvitationSent, parseInvitationSummary, parseOpenInvitation } from "./contracts.ts";

export function createOpenInvitationService(api: ReturnType<typeof createApiClient>) {
  const detail = async (id: string, signal?: AbortSignal) => {
    const invitation = parseOpenInvitation(await api.request(`/chat/open-invitations/${wireId(id)}`, { signal }));
    if (invitation.id !== id) throw new ChatContractError();
    return invitation;
  };
  return {
    detail,
    async list(cursor: string | null, signal?: AbortSignal) {
      const query = new URLSearchParams({ size: "20" });
      if (cursor) query.set("cursorId", String(wireId(cursor)));
      return parseInvitationPage(await api.request(`/chat/open-invitations?${query}`, { signal }), cursor);
    },
    async summary(signal?: AbortSignal) {
      return parseInvitationSummary(await api.request("/chat/open-invitations/summary", { signal }));
    },
    async read(id: string, roomId: string, signal?: AbortSignal) {
      const result = parseOpenInvitation(await api.request(`/chat/open-invitations/${wireId(id)}/read`, { method: "PATCH", signal }));
      if (result.id !== id || result.roomId !== roomId || !result.isRead) throw new ChatContractError();
      return result;
    },
    async send(roomId: string, targetPublicId: string, requestId: string, signal?: AbortSignal) {
      const body = invitationInput(targetPublicId, requestId);
      return parseInvitationSent(await api.request(`/chat/open-rooms/${wireId(roomId)}/invitations`, { method: "POST", body, signal }), roomId);
    },
  };
}
export type OpenInvitationService = ReturnType<typeof createOpenInvitationService>;
