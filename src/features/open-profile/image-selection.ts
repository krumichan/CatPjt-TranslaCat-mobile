export const PROFILE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

export interface SelectedProfileImage {
  uri: string;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  fileName: string;
  size: number;
  width: number;
  height: number;
}

export class ProfileImageInputError extends Error {}

export function selectedProfileImage(input: {
  uri: string; mimeType: string | null | undefined; size: number; width: number; height: number;
}): SelectedProfileImage {
  // 사진 선택기가 반환한 로컬 사본만 전송한다. 원래 파일명·앨범 정보·EXIF는 요청 DTO에 넣지 않는다.
  if (!/^(file|content):\/\//.test(input.uri) || /[\u0000-\u001f]/.test(input.uri)) {
    throw new ProfileImageInputError("선택한 사진을 열 수 없어요. 사진을 다시 선택해 주세요.");
  }
  const extension = input.mimeType === "image/jpeg" ? "jpg"
    : input.mimeType === "image/png" ? "png" : input.mimeType === "image/webp" ? "webp" : null;
  if (!extension) throw new ProfileImageInputError("JPG, PNG, WEBP 사진을 선택해 주세요.");
  if (!Number.isSafeInteger(input.size) || input.size <= 0 || input.size > PROFILE_IMAGE_MAX_BYTES) {
    throw new ProfileImageInputError("5MB 이하의 사진을 선택해 주세요.");
  }
  if (![input.width, input.height].every(value => Number.isFinite(value) && value > 0)) {
    throw new ProfileImageInputError("사진의 크기를 확인할 수 없어요. 다른 사진을 선택해 주세요.");
  }
  return { uri: input.uri, mimeType: input.mimeType as SelectedProfileImage["mimeType"], fileName: `profile.${extension}`,
    size: input.size, width: input.width, height: input.height };
}
