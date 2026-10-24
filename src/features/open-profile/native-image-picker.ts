import { File } from "expo-file-system";
import * as ImagePicker from "expo-image-picker";

import { ProfileImageInputError, selectedProfileImage } from "./image-selection";

export async function pickProfileImage() {
  // OS 사진 선택기를 사용한다. 카메라·마이크나 사진 라이브러리 전체 접근을 먼저 요청하지 않는다.
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"], allowsMultipleSelection: false, allowsEditing: true,
    aspect: [1, 1], quality: 0.8, exif: false, base64: false,
  });
  if (result.canceled) return null;
  const asset = result.assets[0];
  if (!asset) throw new ProfileImageInputError("사진을 선택하지 못했어요. 다시 시도해 주세요.");

  // picker의 선택적 fileSize 대신 실제 로컬 파일 크기를 확인한다.
  const file = new File(asset.uri);
  if (!file.exists) throw new ProfileImageInputError("사진을 열 수 없어요. 다시 선택해 주세요.");
  return selectedProfileImage({ uri: asset.uri, mimeType: asset.mimeType ?? file.type,
    size: file.size, width: asset.width, height: asset.height });
}
