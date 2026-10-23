import type { createApiClient } from "../../api/client.ts";
import { ChatContractError, flag, record, safeId, wireId } from "../../domain/chat/contracts.ts";

export interface GlobalNotificationPreference { pushEnabled: boolean }
export interface RoomNotificationPreference { roomId: string; muted: boolean }

export function createNotificationPreferenceService(api: ReturnType<typeof createApiClient>) {
  const globalPath = "/chat/notifications/preferences";
  const roomPath = (roomId: string) => `/chat/rooms/${wireId(roomId)}/notification-preferences`;
  const parseGlobal = (value: unknown): GlobalNotificationPreference => ({ pushEnabled: flag(record(value).pushEnabled) });
  const parseRoom = (value: unknown, roomId: string): RoomNotificationPreference => {
    const dto = record(value);
    if (safeId(dto.roomId) !== roomId) throw new ChatContractError();
    return { roomId, muted: flag(dto.muted) };
  };
  return {
    async global(signal?: AbortSignal) {
      return parseGlobal(await api.request(globalPath, { signal }));
    },
    async setGlobal(pushEnabled: boolean, signal?: AbortSignal) {
      const expected = flag(pushEnabled);
      const result = parseGlobal(await api.request(globalPath, { method: "PUT", body: { pushEnabled: expected }, signal }));
      if (result.pushEnabled !== expected) throw new ChatContractError();
      return result;
    },
    async room(roomId: string, signal?: AbortSignal) {
      return parseRoom(await api.request(roomPath(roomId), { signal }), roomId);
    },
    async setRoom(roomId: string, muted: boolean, signal?: AbortSignal) {
      const expected = flag(muted);
      const result = parseRoom(await api.request(roomPath(roomId), { method: "PUT", body: { muted: expected }, signal }), roomId);
      if (result.muted !== expected) throw new ChatContractError();
      return result;
    },
  };
}
