import assert from "node:assert/strict";
import test from "node:test";

import { ApiError, createApiClient } from "../src/api/client.ts";
import { ChatContractError, parseMessage, parseRoom } from "../src/domain/chat/contracts.ts";
import { visibleAiProfile } from "../src/features/ai-chat/access.ts";
import { AiInputError, parseAiMember, parseAiSafeProfile, parseAiSettings, validateAiProfile, validateAiSettings } from "../src/features/ai-chat/contracts.ts";
import { createAiRoomController } from "../src/features/ai-chat/controller.ts";
import { createAiService, type AiService } from "../src/features/ai-chat/service.ts";

const roomDto = { id: 3, roomType: "GROUP", sourceType: "FRIEND", myRole: "OWNER", name: "합성 방", active: true,
  memberCount: 2, unreadCount: 0, updatedAt: "2026-10-20T00:00:00Z" };
const profileInput = { nickname: "합성 AI", bio: "합성 소개", originalLanguageCode: "ja", personaPrompt: "합성 성격" };
const memberDto = { aiMemberId: 7, aiAgentId: 9, chatRoomId: 3, ...profileInput, active: true, joinedAt: "2026-10-20T00:00:00Z" };
const settingsDto = { chatRoomId: 3, aiEnabled: true, currentAiMemberCount: 1, maxAiMembersPerRoom: 3,
  disclosureType: "PUBLIC", mentionPermission: "ALL_MEMBERS", conversationEnabled: true, revivalEnabled: false };

function fakeService(overrides: Partial<AiService> = {}): AiService {
  return {
    room: async () => parseRoom(roomDto), settings: async () => parseAiSettings(settingsDto, "3"),
    members: async () => ({ members: [parseAiMember(memberDto, "3")], currentCount: 1, maxCount: 3 }),
    profile: async () => parseAiSafeProfile(memberDto), create: async () => parseAiMember(memberDto, "3"),
    update: async () => parseAiMember(memberDto, "3"), remove: async () => parseAiMember({ ...memberDto, active: false }, "3"),
    updateSettings: async () => parseAiSettings(settingsDto, "3"), ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test("AI 입력은 원본 HTTP 길이와 필수값을 검사하고 허용된 네 필드만 보낸다", () => {
  // 준비
  const raw = { ...profileInput, nickname: "  이름  ", bio: " ", originalLanguageCode: " JA ", extra: "내보내지 않음" };

  // 실행
  const result = validateAiProfile(raw);

  // 검증
  assert.deepEqual(result, { nickname: "이름", bio: null, originalLanguageCode: "ja", personaPrompt: "합성 성격" });
  for (const patch of [{ nickname: " " }, { nickname: "a".repeat(51) }, { bio: "a".repeat(201) },
    { originalLanguageCode: "a".repeat(11) }, { originalLanguageCode: "" }, { personaPrompt: " " }, { personaPrompt: "a".repeat(4001) }]) {
    assert.throws(() => validateAiProfile({ ...profileInput, ...patch }), AiInputError);
  }
  assert.doesNotThrow(() => validateAiProfile({ nickname: "a".repeat(50), bio: "a".repeat(200), originalLanguageCode: "a".repeat(10), personaPrompt: "a".repeat(4000) }));
});

test("AI 공개 프로필 parser는 서버가 추가한 persona와 agent ID도 복사하지 않는다", () => {
  // 준비·실행
  const profile = parseAiSafeProfile(memberDto);

  // 검증
  assert.equal(profile.aiMemberId, "7");
  assert.equal("personaPrompt" in profile, false);
  assert.equal("aiAgentId" in profile, false);
  assert.equal("chatRoomId" in profile, false);
});

test("AI ID와 방 일치, 공개 enum 및 설정 boolean을 엄격하게 확인한다", () => {
  // 준비
  const unsafe = Number.MAX_SAFE_INTEGER + 1;

  // 실행·검증
  assert.throws(() => parseAiSafeProfile({ ...memberDto, aiMemberId: unsafe }), ChatContractError);
  assert.throws(() => parseAiMember({ ...memberDto, chatRoomId: 4 }, "3"), ChatContractError);
  assert.throws(() => parseAiSettings({ ...settingsDto, disclosureType: "HIDDEN" }, "3"), ChatContractError);
  assert.throws(() => parseAiSettings({ ...settingsDto, conversationEnabled: "true" }, "3"), ChatContractError);
  assert.throws(() => validateAiSettings({ disclosureType: "HIDDEN" } as never), AiInputError);
  assert.throws(() => validateAiSettings({ maxAiMembersPerRoom: 99 } as never), AiInputError);
  assert.throws(() => validateAiSettings({}), AiInputError);
});

test("공유 message 계약은 안전한 AI ID를 보존하고 알 수 없는 역할을 거절한다", () => {
  // 준비
  const message = { id: 5, chatRoomId: 3, senderUserId: null, senderAiMemberId: 7, senderType: "AI", senderName: "합성 AI",
    messageType: "TEXT", content: "합성 메시지", status: "SENT", translations: [], createdAt: "2026-10-20", updatedAt: "2026-10-20" };

  // 실행·검증
  assert.equal(parseMessage(message).senderAiMemberId, "7");
  assert.equal(parseRoom(roomDto).myRole, "OWNER");
  assert.throws(() => parseRoom({ ...roomDto, myRole: "ROOT" }), ChatContractError);
});

test("AI REST는 공개 경로와 숫자 JSON 계약을 유지하고 POST 결과를 재전송하지 않는다", async () => {
  // 준비
  const calls: { url: string; method: string; body: unknown }[] = [];
  const api = createApiClient({ baseUrl: "https://fixture.invalid/api/v1", accessToken: async () => "synthetic-token",
    fetcher: async (url, options) => {
      calls.push({ url: String(url), method: options?.method ?? "GET", body: options?.body ? JSON.parse(String(options.body)) : null });
      return new Response(JSON.stringify({ body: memberDto }), { status: 200 });
    } });
  const service = createAiService(api);

  // 실행
  const result = await service.create("3", profileInput);
  await service.update("3", "7", profileInput);
  await service.remove("3", "7");
  await service.profile("3", "7");

  // 검증
  assert.equal(result.chatRoomId, "3");
  assert.deepEqual(calls.map(call => [call.url, call.method]), [
    ["https://fixture.invalid/api/v1/chat/rooms/3/ai-members", "POST"],
    ["https://fixture.invalid/api/v1/chat/rooms/3/ai-members/7", "PATCH"],
    ["https://fixture.invalid/api/v1/chat/rooms/3/ai-members/7", "DELETE"],
    ["https://fixture.invalid/api/v1/chat/rooms/3/ai-members/7/profile", "GET"],
  ]);
  assert.deepEqual(calls[0]?.body, profileInput);
  const before = calls.length;
  await assert.rejects(service.profile("3", "9007199254740992"), ChatContractError);
  await assert.rejects(service.create("../3", profileInput), ChatContractError);
  await assert.rejects(service.create("3", { ...profileInput, nickname: " " }), AiInputError);
  assert.equal(calls.length, before);
});

test("AI REST 목록과 단건은 응답의 다른 방·다른 AI·중복 ID를 거절한다", async () => {
  // 준비
  let body: unknown = { chatRoomId: 3, currentCount: 2, maxCount: 3, members: [memberDto, memberDto] };
  const api = createApiClient({ baseUrl: "https://fixture.invalid/api/v1", accessToken: async () => "synthetic",
    fetcher: async () => new Response(JSON.stringify({ body }), { status: 200 }) });
  const service = createAiService(api);

  // 실행·검증
  await assert.rejects(service.members("3"), ChatContractError);
  body = { ...memberDto, aiMemberId: 8 };
  await assert.rejects(service.update("3", "7", profileInput), ChatContractError);
  await assert.rejects(service.profile("3", "7"), ChatContractError);
  body = { ...memberDto, chatRoomId: 4 };
  await assert.rejects(service.create("3", profileInput), ChatContractError);
});

test("AI 설정 GET·PATCH와 관리 목록은 기존 공개 DTO·메서드·camelCase를 유지한다", async () => {
  // 준비
  const calls: { path: string; method: string; body: unknown }[] = [];
  const api = createApiClient({ baseUrl: "https://fixture.invalid/api/v1", accessToken: async () => "synthetic",
    fetcher: async (url, options) => {
      const path = new URL(String(url)).pathname;
      calls.push({ path, method: options?.method ?? "GET", body: options?.body ? JSON.parse(String(options.body)) : null });
      const body = path.endsWith("ai-members") ? { chatRoomId: 3, currentCount: 1, maxCount: 3, members: [memberDto] }
        : path.endsWith("ai-settings") ? settingsDto : roomDto;
      return new Response(JSON.stringify({ body }), { status: 200 });
    } });
  const service = createAiService(api);

  // 실행
  await service.room("3");
  await service.settings("3");
  await service.updateSettings("3", { disclosureType: "PRIVATE", mentionPermission: "OWNER_ADMIN_ONLY", conversationEnabled: false, revivalEnabled: true });
  const list = await service.members("3");

  // 검증
  assert.equal(list.members[0]?.aiMemberId, "7");
  assert.equal(calls[2]?.path, "/api/v1/chat/rooms/3/ai-settings");
  assert.equal(calls[2]?.method, "PATCH");
  assert.deepEqual(calls[2]?.body, { disclosureType: "PRIVATE", mentionPermission: "OWNER_ADMIN_ONLY", conversationEnabled: false, revivalEnabled: true });
  assert.deepEqual(calls.map(call => call.method), ["GET", "GET", "PATCH", "GET"]);
});

test("일반 참여자는 전체 AI 목록·persona endpoint를 요청하지 않고 설정만 읽는다", async () => {
  // 준비
  let lists = 0;
  const controller = createAiRoomController(fakeService({ room: async () => parseRoom({ ...roomDto, myRole: "MEMBER" }),
    members: async () => { lists++; throw new ApiError(403, "FORBIDDEN"); } }), "3", "ordinary", () => true, () => {});

  // 실행
  await controller.load();
  const created = await controller.create(profileInput);

  // 검증
  assert.equal(lists, 0);
  assert.equal(controller.getState().settings?.chatRoomId, "3");
  assert.deepEqual(controller.getState().members, []);
  assert.equal(created, false);
  controller.dispose();
});

test("관리 목록 권한 거절은 안전 프로필 endpoint로 우회하지 않는다", async () => {
  // 준비
  let safeProfiles = 0;
  const controller = createAiRoomController(fakeService({ members: async () => { throw new ApiError(400, "HTTP_400"); },
    profile: async () => { safeProfiles++; return parseAiSafeProfile(memberDto); } }), "3", "denied", () => true, () => {});

  // 실행
  await controller.load();

  // 검증
  assert.equal(controller.getState().managementAvailable, false);
  assert.deepEqual(controller.getState().members, []);
  assert.equal(safeProfiles, 0);
  assert.equal(await controller.create(profileInput), false);
  controller.dispose();
});

test("PRIVATE 일반 참여자 프로필은 안전 DTO도 요청하지 않는다", async () => {
  // 준비
  let profiles = 0;
  const service = fakeService({ room: async () => parseRoom({ ...roomDto, myRole: "MEMBER" }),
    settings: async () => parseAiSettings({ ...settingsDto, disclosureType: "PRIVATE" }, "3"),
    profile: async () => { profiles++; return parseAiSafeProfile(memberDto); } });

  // 실행·검증
  await assert.rejects(visibleAiProfile(service, "3", "7", new AbortController().signal), { code: "AI_PROFILE_PRIVATE" });
  assert.equal(profiles, 0);
});

test("공개 안전 프로필은 AI 멘션 권한을 현재 방 설정으로 판정한다", async () => {
  // 준비
  const service = fakeService({ room: async () => parseRoom({ ...roomDto, myRole: "MEMBER" }),
    settings: async () => parseAiSettings({ ...settingsDto, mentionPermission: "OWNER_ADMIN_ONLY" }, "3") });

  // 실행
  const value = await visibleAiProfile(service, "3", "7", new AbortController().signal);

  // 검증
  assert.equal(value.canMention, false);
  assert.equal("personaPrompt" in value.profile, false);
});

test("DIRECT·종료 방과 취소된 프로필 흐름은 후속 AI 조회를 시작하지 않는다", async () => {
  // 준비
  let settings = 0;
  const abort = new AbortController();
  const service = fakeService({ room: async () => { abort.abort(); return parseRoom(roomDto); },
    settings: async () => { settings++; return parseAiSettings(settingsDto, "3"); } });

  // 실행·검증
  await assert.rejects(visibleAiProfile(service, "3", "7", abort.signal), { code: "REQUEST_ABORTED" });
  assert.equal(settings, 0);
  for (const patch of [{ roomType: "DIRECT" }, { active: false }]) {
    const controller = createAiRoomController(fakeService({ room: async () => parseRoom({ ...roomDto, ...patch }),
      settings: service.settings }), "3", JSON.stringify(patch), () => true, () => {});
    await controller.load();
    assert.equal(controller.getState().managementAvailable, false);
    assert.equal(settings, 0);
    controller.dispose();
  }
});

test("중복 AI 저장은 한 요청만 실행하고 성공 뒤 목록을 새로 읽는다", async () => {
  // 준비
  let creates = 0;
  let lists = 0;
  const pending = deferred<ReturnType<typeof parseAiMember>>();
  const controller = createAiRoomController(fakeService({ create: async () => { creates++; return pending.promise; },
    members: async () => { lists++; return { members: [parseAiMember(memberDto, "3")], currentCount: 1, maxCount: 3 }; } }),
  "3", "double-submit", () => true, () => {});
  await controller.load();

  // 실행
  const first = controller.create(profileInput);
  const second = await controller.create(profileInput);
  pending.resolve(parseAiMember(memberDto, "3"));
  const saved = await first;

  // 검증
  assert.equal(second, false);
  assert.equal(saved, true);
  assert.equal(creates, 1);
  assert.equal(lists, 2);
  controller.dispose();
});

test("CREATE 네트워크 불확실성은 재진입·새로고침에도 재전송을 차단한다", async () => {
  // 준비
  let creates = 0;
  const service = fakeService({ create: async () => { creates++; throw new ApiError(0, "NETWORK_UNAVAILABLE"); } });
  const first = createAiRoomController(service, "3", "uncertain-create", () => true, () => {});
  await first.load();

  // 실행
  assert.equal(await first.create(profileInput), false);
  await first.load();
  assert.equal(await first.create(profileInput), false);
  first.dispose();
  const reopened = createAiRoomController(service, "3", "uncertain-create", () => true, () => {});
  await reopened.load();

  // 검증: 사용자의 목록 확인 전까지 새 form으로도 POST를 보내지 않는다.
  assert.equal(reopened.getState().uncertain, true);
  assert.equal(await reopened.create(profileInput), false);
  assert.equal(creates, 1);
  assert.equal(reopened.acknowledge(), true);
  assert.equal(reopened.getState().uncertain, false);
  reopened.dispose();
});

test("계정 변경·화면 이탈 중 생성은 취소되고 늦은 persona 결과가 publish되지 않는다", async () => {
  // 준비
  let current = true;
  let requestSignal: AbortSignal | undefined;
  let publishes = 0;
  const pending = deferred<ReturnType<typeof parseAiMember>>();
  const started = deferred<void>();
  const service = fakeService({ create: async (_room, _input, signal) => {
    requestSignal = signal; started.resolve(); return pending.promise;
  } });
  const controller = createAiRoomController(service, "3", "account-old", () => current, () => { publishes++; });
  await controller.load();
  const request = controller.create(profileInput);
  await started.promise;

  // 실행
  current = false;
  controller.dispose();
  const before = publishes;
  pending.resolve(parseAiMember(memberDto, "3"));
  assert.equal(await request, false);

  // 검증
  assert.equal(requestSignal?.aborted, true);
  assert.equal(publishes, before);
  const reopened = createAiRoomController(fakeService(), "3", "account-old", () => true, () => {});
  assert.equal(reopened.getState().uncertain, true);
  reopened.dispose();
  const otherAccount = createAiRoomController(fakeService(), "3", "account-new", () => true, () => {});
  assert.equal(otherAccount.getState().uncertain, false);
  otherAccount.dispose();
});

test("명시적 4xx 거절은 성공 처리하거나 자동 반복하지 않는다", async () => {
  // 준비
  let attempts = 0;
  const controller = createAiRoomController(fakeService({ create: async () => { attempts++; throw new ApiError(403, "HTTP_403"); } }),
    "3", "explicit-reject", () => true, () => {});
  await controller.load();

  // 실행
  const saved = await controller.create(profileInput);

  // 검증
  assert.equal(saved, false);
  assert.equal(attempts, 1);
  assert.equal(controller.getState().uncertain, false);
  assert.match(controller.getState().error ?? "", /권한/);
  controller.dispose();
});

test("2xx 응답 파싱 실패·408·5xx는 CREATE 성공 여부가 불확실해 재요청을 막는다", async () => {
  // 준비
  const failures = [new ApiError(200, "INVALID_API_RESPONSE"), new ChatContractError(),
    new ApiError(408, "HTTP_408"), new ApiError(503, "HTTP_503")];

  for (const [index, failure] of failures.entries()) {
    let attempts = 0;
    const controller = createAiRoomController(fakeService({ create: async () => { attempts++; throw failure; } }),
      "3", `uncertain-response-${index}`, () => true, () => {});
    await controller.load();

    // 실행
    await controller.create(profileInput);
    await controller.load();
    await controller.create(profileInput);

    // 검증
    assert.equal(attempts, 1);
    assert.equal(controller.getState().uncertain, true);
    controller.dispose();
  }
});

test("동기 활동·세션 getter가 거짓이면 후속 AI 요청과 변경을 시작하지 않는다", async () => {
  // 준비
  let active = true;
  let attempts = 0;
  const controller = createAiRoomController(fakeService({ create: async () => { attempts++; return parseAiMember(memberDto, "3"); } }),
    "3", "inactive-window", () => active, () => {});
  await controller.load();

  // 실행
  active = false;
  const saved = await controller.create(profileInput);
  const reloaded = await controller.load();

  // 검증
  assert.equal(saved, false);
  assert.equal(reloaded, false);
  assert.equal(attempts, 0);
  controller.dispose();
});
