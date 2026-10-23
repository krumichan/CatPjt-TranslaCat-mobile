import { ApiError, type createApiClient } from "../../api/client.ts";
import { ChatContractError, parseOpenRoom, record } from "../../domain/chat/contracts.ts";

export type OpenRoomVisibility = "PUBLIC" | "UNLISTED";
export type OpenRoomCreateField = "name" | "description" | "visibility" | "maxMemberCount" | "nickname";
export type OpenRoomCreateErrors = Partial<Record<OpenRoomCreateField, string>>;

export interface OpenRoomCreateInput {
  name: string;
  description: string;
  visibility: OpenRoomVisibility;
  maxMemberCount: string;
  nickname: string;
}

export class OpenRoomInputError extends Error {
  readonly fields: OpenRoomCreateErrors;

  constructor(fields: OpenRoomCreateErrors) {
    super("INVALID_OPEN_ROOM_INPUT");
    this.name = "OpenRoomInputError";
    this.fields = fields;
  }
}

export function prepareOpenRoomCreate(input: OpenRoomCreateInput) {
  // 웹과 같은 trim·UTF-16 길이 기준으로 검사하고 일반 계정 프로필은 자동으로 가져오지 않는다.
  const name = input.name.trim();
  const description = input.description.trim();
  const nickname = input.nickname.trim();
  const memberText = input.maxMemberCount.trim();
  const maxMemberCount = Number(memberText);
  const fields: OpenRoomCreateErrors = {};

  if (!name || name.length > 100) fields.name = "방 이름을 1~100자로 입력해 주세요.";
  if (!description || description.length > 500) fields.description = "방 설명을 1~500자로 입력해 주세요.";
  if (!nickname || nickname.length > 50) fields.nickname = "이 방에서 사용할 닉네임을 1~50자로 입력해 주세요.";
  if (input.visibility !== "PUBLIC" && input.visibility !== "UNLISTED") fields.visibility = "공개 범위를 선택해 주세요.";
  if (!/^[0-9]+$/.test(memberText) || !Number.isInteger(maxMemberCount) || maxMemberCount < 2 || maxMemberCount > 100) {
    fields.maxMemberCount = "최대 인원을 방장을 포함해 2~100명으로 입력해 주세요.";
  }
  if (Object.keys(fields).length > 0) throw new OpenRoomInputError(fields);

  return {
    name, description, visibility: input.visibility, maxMemberCount,
    ownerProfile: { nickname, profileImageObjectKey: null },
  };
}

export function createOpenRoomService(api: ReturnType<typeof createApiClient>) {
  return {
    async create(input: OpenRoomCreateInput, signal?: AbortSignal) {
      const request = prepareOpenRoomCreate(input);
      // 서버에는 생성 멱등 키가 없다. POST는 한 번만 보내고 원문 오류를 화면이나 로그에 반사하지 않는다.
      const dto = record(await api.request("/chat/open-rooms", { method: "POST", body: request, signal }));
      const room = parseOpenRoom(dto);
      if (dto.roomType !== "OPEN" || dto.status !== "ACTIVE" || dto.visibility !== request.visibility
        || dto.myRole !== "OWNER" || !room.joined || !room.myOpenProfile
        || room.name !== request.name || room.description !== request.description
        || room.maxMemberCount !== request.maxMemberCount || room.myOpenProfile.nickname !== request.ownerProfile.nickname) {
        throw new ChatContractError();
      }
      // 생성자는 이미 참여 중이므로 joinable=false/ALREADY_JOINED 응답도 정상이다.
      return room;
    },
  };
}

export type OpenRoomCreateService = ReturnType<typeof createOpenRoomService>;

export function openRoomCreateFailure(error: unknown) {
  if (error instanceof OpenRoomInputError) {
    return { uncertain: false, message: "입력 내용을 확인해 주세요.", fields: error.fields };
  }
  // 408·연결 중단·5xx·응답 형식 오류는 저장 여부를 알 수 없어 새 방을 자동으로 다시 만들지 않는다.
  if (!(error instanceof ApiError) || error.status < 400 || error.status >= 500 || error.status === 408) {
    return { uncertain: true, message: "방이 만들어졌는지 확인하지 못했어요. 중복 생성을 막기 위해 다시 요청하지 않아요. 내 채팅에서 생성 결과를 확인해 주세요.", fields: {} };
  }
  const message = error.status === 401 ? "로그인 상태를 확인한 뒤 다시 시도해 주세요."
    : error.status === 403 ? "이 계정으로 방을 만들 수 없어요. 로그인 상태와 이용 권한을 확인해 주세요."
      : error.status === 429 ? "요청이 많아요. 잠시 후 다시 시도해 주세요."
        : "방을 만들지 못했어요. 입력 내용과 이용 권한을 확인해 주세요.";
  return { uncertain: false, message, fields: {} };
}
