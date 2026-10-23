import { ApiError } from "../../api/client.ts";
import { manager } from "./controller.ts";
import type { AiService } from "./service.ts";

export async function visibleAiProfile(service: AiService, roomId: string, memberId: string, signal: AbortSignal) {
  const check = () => { if (signal.aborted) throw new ApiError(0, "REQUEST_ABORTED"); };
  check();
  const room = await service.room(roomId, signal);
  check();
  if (!room.active || room.roomType === "DIRECT") throw new ApiError(403, "AI_PROFILE_NOT_AVAILABLE");

  // PRIVATE는 일반 참여자의 목록/프로필 표시를 숨긴다. 관리 endpoint로 우회하지 않는다.
  const settings = await service.settings(roomId, signal);
  check();
  if (settings.disclosureType === "PRIVATE" && !manager(room)) throw new ApiError(403, "AI_PROFILE_PRIVATE");
  const profile = await service.profile(roomId, memberId, signal);
  check();
  if (!profile.active) throw new ApiError(404, "AI_PROFILE_NOT_AVAILABLE");
  return { room, settings, profile, canMention: manager(room) || settings.mentionPermission === "ALL_MEMBERS" };
}
