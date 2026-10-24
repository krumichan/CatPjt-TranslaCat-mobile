import type { createApiClient } from "../../api/client.ts";
import { ChatContractError, flag, parseOpenProfile, record, wireId } from "../../domain/chat/contracts.ts";
import type { OpenProfile } from "../../domain/chat/types.ts";
import { createChatService } from "../chat/service.ts";
import { selectedProfileImage, type SelectedProfileImage } from "./image-selection.ts";

function uploadForm(image: SelectedProfileImage) {
  const form = new FormData();
  // React Native의 FormData는 로컬 파일 descriptor를 multipart 파일 본문으로 읽는다.
  form.append("file", { uri: image.uri, name: image.fileName, type: image.mimeType } as unknown as Blob);
  return form;
}

export function createOpenProfileService(api: ReturnType<typeof createApiClient>, makeForm = uploadForm) {
  const chat = createChatService(api);
  const path = (roomId: string) => `/chat/open-rooms/${wireId(roomId)}/me`;
  const parseMine = (value: unknown, expectedMemberId?: string) => {
    const dto = record(value);
    const profile = parseOpenProfile(dto);
    if (!flag(dto.active) || (expectedMemberId && profile.openChatMemberId !== expectedMemberId)) {
      throw new ChatContractError();
    }
    return profile;
  };
  return {
    async read(roomId: string, signal: AbortSignal): Promise<OpenProfile> {
      const room = await chat.room(roomId, signal);
      if (room.roomType !== "OPEN" || !room.active || room.closed) throw new ChatContractError("OPEN_PROFILE_UNAVAILABLE");
      return parseMine(await api.request(`${path(roomId)}/profile`, { signal }));
    },
    async upload(roomId: string, memberId: string, image: SelectedProfileImage, signal: AbortSignal) {
      const validated = selectedProfileImage(image);
      return parseMine(await api.request(`${path(roomId)}/profile-image`, {
        method: "POST", formData: makeForm(validated), signal,
      }), memberId);
    },
    async remove(roomId: string, memberId: string, signal: AbortSignal) {
      return parseMine(await api.request(`${path(roomId)}/profile-image`, { method: "DELETE", signal }), memberId);
    },
  };
}
export type OpenProfileService = ReturnType<typeof createOpenProfileService>;
