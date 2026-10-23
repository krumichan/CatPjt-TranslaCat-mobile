import assert from "node:assert/strict";
import test from "node:test";

import { createApiClient } from "../src/api/client.ts";
import { ChatContractError, parseMessage, parseOpenRoom, parseRoom, safeId, wireId } from "../src/domain/chat/contracts.ts";
import { applyMemberRead, catchUpMessages, mergeMessages, mergeTranslations, recoverEmptyRoomHistory } from "../src/domain/chat/timeline.ts";
import { createChatService } from "../src/features/chat/service.ts";
import { parseRoomEvent } from "../src/realtime/events.ts";

function messageDto(id = 10) {
  return {
    id, chatRoomId: 3, senderUserId: 1, senderAiMemberId: null, senderType: "USER", senderName: "테스트 참여자",
    messageType: "TEXT", content: "합성 테스트 메시지", status: "SENT", unreadMemberCount: 2,
    translations: [{ id: 20, languageCode: "ja", status: "PENDING", translatedContent: null, completedAt: null }],
    createdAt: "2026-10-19T01:00:00Z", updatedAt: "2026-10-19T01:00:00Z", sender: null,
  };
}

test("차단 응답은 이전 원문·번역·프로필을 제거하고 새 조회에서 해제할 수 있다", () => {
  // 준비: 기존 메모리에 원문과 완성 번역이 있어도 숨김 응답이 오면 모두 버린다.
  const visible = parseMessage({ ...messageDto(), contentVisibility: "VISIBLE", translations: [{
    id: 20, languageCode: "ja", status: "COMPLETED", translatedContent: "synthetic translation", completedAt: "2026-10-23T00:00:00Z",
  }] });
  const hidden = parseMessage({ ...messageDto(), contentVisibility: "BLOCKED", sender: { openChatMemberId: 8, nickname: "synthetic profile", memberCode: "OC-TEST" } });

  // 실행
  const masked = mergeMessages([visible], [hidden])[0]!;

  // 검증: 실제 본문·번역·작성자 ID가 숨김 상태에 남지 않고 해제 뒤 원문 조회를 정상 반영한다.
  assert.equal(masked.content, "차단한 사용자의 메시지입니다.");
  assert.deepEqual(masked.translations, []);
  assert.equal(masked.senderUserId, null);
  assert.equal(masked.sender, null);
  assert.equal(mergeMessages([masked], [visible])[0]!.content, visible.content);
  assert.throws(() => parseMessage({ ...messageDto(), contentVisibility: "UNKNOWN" }), ChatContractError);
});

test("탈퇴한 작성자는 공유 본문을 유지하면서 전역 ID와 공개 이름을 익명화한다", () => {
  // 준비·실행
  const message = parseMessage({ ...messageDto(), authorDeleted: true, sender: { openChatMemberId: 8, nickname: "synthetic name", memberCode: "OC-TEST" } });

  // 검증
  assert.equal(message.content, messageDto().content);
  assert.equal(message.senderName, "탈퇴한 사용자");
  assert.equal(message.senderUserId, null);
  assert.equal(message.sender?.nickname, "탈퇴한 사용자");
  assert.equal(message.sender?.memberCode, "");
  assert.throws(() => parseMessage({ ...messageDto(), authorDeleted: "yes" }), ChatContractError);
});

test("서버 숫자 ID는 문자열 변환 전에 안전 범위를 검사한다", () => {
  // 준비
  const unsafe = JSON.parse('{"id":9007199254740993}').id;
  // 실행·검증
  assert.equal(safeId(Number.MAX_SAFE_INTEGER), "9007199254740991");
  assert.throws(() => safeId(unsafe), { code: "UNSAFE_CHAT_ID" });
  assert.throws(() => parseMessage({ ...messageDto(), senderUserId: unsafe }), ChatContractError);
  for (const id of ["9007199254740992", "01", "../3", "0", "3.1"]) assert.throws(() => wireId(id), ChatContractError);
});

test("기존 DIRECT GROUP OPEN 방을 같은 목록 계약으로 파싱한다", () => {
  // 준비
  const dto = { id: 3, sourceType: "FRIEND", name: "테스트 방", memberCount: 2, unreadCount: 1, updatedAt: "2026-10-19T01:00:00Z" };
  // 실행·검증
  for (const roomType of ["DIRECT", "GROUP", "OPEN"]) assert.equal(parseRoom({ ...dto, roomType }).roomType, roomType);
  assert.throws(() => parseRoom({ ...dto, roomType: "OTHER" }), ChatContractError);
});

test("OPEN 상세는 실제 계정 프로필 없이 방별 프로필만 보존한다", () => {
  // 준비
  const dto = { id: 3, name: "합성 방", description: "합성 설명", memberCount: 1, maxMemberCount: 10,
    joined: false, joinable: true, joinBlockedReason: "NONE", myOpenProfile: {
      openChatMemberId: 7, nickname: "방별 닉네임", memberCode: "fixture-member", joinedAt: "2026-10-19T01:00:00Z",
    } };
  // 실행
  const room = parseOpenRoom(dto);
  // 검증
  assert.equal(room.myOpenProfile?.openChatMemberId, "7");
  assert.equal(room.myOpenProfile?.nickname, "방별 닉네임");
  assert.equal("publicId" in room.myOpenProfile!, false);
});

test("REST 저장 응답과 WebSocket 중복을 합치고 완료 번역을 PENDING으로 되돌리지 않는다", () => {
  // 준비
  const initial = parseMessage(messageDto());
  const completed = { ...initial.translations[0]!, status: "COMPLETED" as const, translatedContent: "合成テスト", completedAt: "2026-10-19T01:00:01Z" };
  // 실행
  const merged = mergeMessages([{ ...initial, translations: [completed], unreadMemberCount: 0 }], [initial, initial]);
  // 검증
  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.translations[0]?.status, "COMPLETED");
  assert.equal(merged[0]?.unreadMemberCount, 0);
});

test("번역 완료 시각은 소수 초 자리수가 달라도 실제 시각으로 비교한다", () => {
  // 준비
  const base = parseMessage(messageDto()).translations[0]!;
  const recent = { ...base, status: "COMPLETED" as const, translatedContent: "최근 결과", completedAt: "2026-10-19T01:00:01.100Z" };
  const older = { ...recent, translatedContent: "늦게 도착한 예전 결과", completedAt: "2026-10-19T01:00:01Z" };
  // 실행·검증
  assert.equal(mergeTranslations([recent], [older])[0]?.translatedContent, "최근 결과");
});

test("삭제된 메시지는 오래된 REST SENT 응답으로 복구하지 않는다", () => {
  // 준비
  const initial = parseMessage(messageDto());
  // 실행·검증
  assert.equal(mergeMessages([{ ...initial, status: "DELETED" }], [initial])[0]?.status, "DELETED");
});

test("읽음 이벤트 중복은 집계를 다시 줄이지 않고 발신자 자신의 읽음도 제외한다", () => {
  // 준비
  const messages = [parseMessage(messageDto(10)), parseMessage(messageDto(11))];
  const seen = new Map<string, string>();
  const event = { readerUserId: "2", readerOpenChatMemberId: null, previous: null, last: "10" };
  // 실행
  const once = applyMemberRead(messages, event, seen);
  const twice = applyMemberRead(once, event, seen);
  const senderRead = applyMemberRead(twice, { ...event, readerUserId: "1", last: "11" }, seen);
  // 검증
  assert.equal(once[0]?.unreadMemberCount, 1);
  assert.equal(twice[0]?.unreadMemberCount, 1);
  assert.equal(senderRead[1]?.unreadMemberCount, 2);
});

test("복귀 동기화는 최신 한 페이지로 건너뛰지 않고 after를 끝까지 따라간다", async () => {
  // 준비
  const requested: string[] = [];
  const collected: string[] = [];
  const pages = [
    { messages: [parseMessage(messageDto(11)), parseMessage(messageDto(12))], nextCursorId: "12", hasNext: true },
    { messages: [parseMessage(messageDto(13))], nextCursorId: "13", hasNext: true },
    { messages: [parseMessage(messageDto(14))], nextCursorId: null, hasNext: false },
  ];
  // 실행
  const latest = await catchUpMessages("10", async (cursor) => { requested.push(cursor); return pages.shift()!; },
    (messages) => collected.push(...messages.map((message) => message.id)));
  // 검증
  assert.deepEqual(requested, ["10", "12", "13"]);
  assert.deepEqual(collected, ["11", "12", "13", "14"]);
  assert.equal(latest, "14");
});

test("전진하지 않는 pagination cursor는 무한 요청 전에 거부한다", async () => {
  // 준비
  let requests = 0;
  // 실행·검증
  await assert.rejects(catchUpMessages("10", async () => {
    requests += 1;
    return { messages: [parseMessage(messageDto(11))], nextCursorId: "10", hasNext: true };
  }, () => {}), ChatContractError);
  assert.equal(requests, 1);
});

test("최초 빈방에서 첫 WS 수신 뒤 100개 넘게 누락돼도 이전 페이지를 끝까지 복구한다", async () => {
  // 준비: 가장 큰 WS ID가 먼저 도착했고 REST 최신 페이지에는 205개 중 마지막 100개만 있다.
  const messages = Array.from({ length: 205 }, (_, index) => parseMessage(messageDto(index + 1)));
  let collected = [messages[204]!];
  const requested: string[] = [];
  const pages = [
    { messages: messages.slice(5, 105), nextCursorId: "6", hasNext: true },
    { messages: messages.slice(0, 5), nextCursorId: null, hasNext: false },
  ];
  // 실행
  const latest = await recoverEmptyRoomHistory({ messages: messages.slice(105), nextCursorId: "106", hasNext: true },
    async (cursor) => { requested.push(cursor); return pages.shift()!; },
    (page) => { collected = mergeMessages(collected, page); });
  // 검증: WS 최댓값으로 after 시작점을 만들지 않아 앞쪽·중간 메시지를 모두 보존한다.
  assert.deepEqual(requested, ["106", "6"]);
  assert.equal(collected.length, 205);
  assert.equal(collected[0]?.id, "1");
  assert.equal(collected[204]?.id, "205");
  assert.equal(latest, "205");
});

test("빈방 복구 도중 이전 방향으로 이동하지 않는 응답은 거부한다", async () => {
  // 준비
  const first = { messages: [parseMessage(messageDto(10))], nextCursorId: "10", hasNext: true };
  // 실행·검증
  await assert.rejects(recoverEmptyRoomHistory(first,
    async () => ({ messages: [parseMessage(messageDto(11))], nextCursorId: null, hasNext: false }),
    () => {}), ChatContractError);
});

test("REST 전송의 응답이 유실돼도 POST를 자동 재전송하지 않는다", async () => {
  // 준비
  let posts = 0;
  const api = createApiClient({ baseUrl: "https://unit.test/api/v1", accessToken: async () => "fixture-token",
    fetcher: async (_url, options) => { if (options?.method === "POST") posts += 1; throw new TypeError("synthetic network loss"); } });
  // 실행·검증
  await assert.rejects(createChatService(api).send("3", "합성 메시지"));
  assert.equal(posts, 1);
});

test("다른 방 메시지를 반환한 REST 응답은 화면 데이터로 사용하지 않는다", async () => {
  // 준비
  const api = createApiClient({ baseUrl: "https://unit.test/api/v1", accessToken: async () => "fixture-token",
    fetcher: async () => new Response(JSON.stringify({ body: { messages: [{ ...messageDto(), chatRoomId: 4 }], nextCursorId: null, hasNext: false } }), { status: 200 }) });
  // 실행·검증
  await assert.rejects(createChatService(api).messages("3", null), ChatContractError);
});

test("실시간 메시지와 번역의 서버 숫자 ID도 같은 안전 검사에 통과해야 한다", () => {
  // 준비
  const message = JSON.stringify({ eventType: "chat.message.created", chatRoomId: 3, message: messageDto() });
  const translation = JSON.stringify({ eventType: "chat.translation.completed", chatRoomId: 3, messageId: 10,
    translationId: 20, languageCode: "ja", translatedContent: "合成テスト", status: "COMPLETED", occurredAt: "2026-10-19T01:00:01Z" });
  // 실행·검증
  assert.equal(parseRoomEvent(message)?.kind, "message");
  assert.equal(parseRoomEvent(translation)?.kind, "translation");
  assert.throws(() => parseRoomEvent(message.replace('"id":10', '"id":9007199254740993')), ChatContractError);
});


test("같은 번역 ID의 완료 결과는 시각 없는 과거 REST 실패로 되돌리지 않는다", () => {
  // 준비: 실패 후 재시도로 완료된 결과보다 이전 FAILED 조회 응답이 늦게 도착한다.
  const base = parseMessage(messageDto()).translations[0]!;
  const completed = { ...base, status: "COMPLETED" as const, translatedContent: "완료 번역", completedAt: "2026-10-21T01:00:02Z" };
  const delayedFailure = { ...base, status: "FAILED" as const, translatedContent: null, completedAt: null };

  // 실행·검증: 동일 ID의 실패 및 PENDING은 완료 본문을 숨기지 않는다.
  const merged = mergeTranslations([completed], [delayedFailure, base]);
  assert.deepEqual(merged, [completed]);
});

test("실패한 동일 번역 행의 재시도가 완료되면 새 결과를 반영한다", () => {
  // 준비: 동일 translation ID를 유지하는 서버 재시도 계약이다.
  const base = parseMessage(messageDto()).translations[0]!;
  const failed = { ...base, status: "FAILED" as const, completedAt: null };
  const completed = { ...base, status: "COMPLETED" as const, translatedContent: "재시도 성공", completedAt: "2026-10-21T01:00:02Z" };

  // 실행·검증: 완료 상태 보존이 실패에서 성공으로의 정상 전이를 막지 않는다.
  assert.deepEqual(mergeTranslations([failed], [completed]), [completed]);
});

test("다른 번역 ID에는 완료 상태 영구 우선 규칙을 적용하지 않는다", () => {
  // 준비: 새 번역 행을 나타내는 다른 ID는 동일 행의 과거 실패와 구분한다.
  const base = parseMessage(messageDto()).translations[0]!;
  const completed = { ...base, status: "COMPLETED" as const, translatedContent: "이전 행", completedAt: "2026-10-21T01:00:02Z" };
  const newFailedRow = { ...base, id: "21", status: "FAILED" as const, translatedContent: null, completedAt: null };
  const newCompletedRow = { ...completed, id: "22", translatedContent: "새 행", completedAt: "2026-10-21T01:00:03Z" };

  // 실행·검증: 기존 ID 교체·시각 비교 규칙을 유지한다.
  assert.deepEqual(mergeTranslations([completed], [newFailedRow]), [newFailedRow]);
  assert.deepEqual(mergeTranslations([completed], [newCompletedRow]), [newCompletedRow]);
  assert.deepEqual(mergeTranslations([newCompletedRow], [completed]), [newCompletedRow]);
});

test("읽음 이벤트 뒤 재조회한 권위 있는 집계는 과소 계산된 값을 복구한다", () => {
  // 준비: 과거 REST와 지연 읽음 이벤트의 이중 차감으로 로컬 값이 0이 된 상황이다.
  const message = parseMessage(messageDto());
  const undercounted = { ...message, unreadMemberCount: 0 };
  const snapshot = { ...message, unreadMemberCount: 1 };

  // 실행: 이벤트를 직접 차감하지 않고 다시 조회한 서버 집계를 명시적으로 적용한다.
  const ordinary = mergeMessages([undercounted], [snapshot]);
  const reconciled = mergeMessages([undercounted], [snapshot], { authoritativeUnreadCounts: true });

  // 검증: 일반 병합은 기존 정책을 유지하고, 검증된 재조회만 정확한 1로 복구한다.
  assert.equal(ordinary[0]?.unreadMemberCount, 0);
  assert.equal(reconciled[0]?.unreadMemberCount, 1);
});

test("같은 지연 읽음 알림 때문에 재조회가 반복돼도 서버 집계를 추가 차감하지 않는다", () => {
  // 준비: 서버 응답에는 B의 읽음이 반영되어 C 한 명만 미확인이다.
  const snapshot = { ...parseMessage(messageDto()), unreadMemberCount: 1 };
  let messages: ReturnType<typeof parseMessage>[] = [snapshot];

  // 실행: 중복 알림이 유발한 같은 authoritative 조회 결과를 반복 병합한다.
  for (let duplicate = 0; duplicate < 3; duplicate += 1) {
    messages = mergeMessages(messages, [snapshot], { authoritativeUnreadCounts: true });
  }

  // 검증: 실제 이벤트 연결은 controller 통합 테스트에서 확인하며 여기서는 병합 경계를 검증한다.
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.unreadMemberCount, 1);
});

test("권위 있는 읽음 재조회도 nullable 집계를 임의의 숫자로 바꾸지 않는다", () => {
  // 준비: 서버가 제공하지 않은 집계는 측정값 0과 구분한다.
  const message = parseMessage(messageDto());
  const known = { ...message, unreadMemberCount: 1 };
  const unavailable = { ...message, unreadMemberCount: null };

  // 실행·검증: null은 기존 값을 유지하고 실제 0 응답은 정답으로 적용한다.
  assert.equal(mergeMessages([known], [unavailable], { authoritativeUnreadCounts: true })[0]?.unreadMemberCount, 1);
  assert.equal(mergeMessages([unavailable], [unavailable], { authoritativeUnreadCounts: true })[0]?.unreadMemberCount, null);
  assert.equal(mergeMessages([known], [{ ...message, unreadMemberCount: 0 }], { authoritativeUnreadCounts: true })[0]?.unreadMemberCount, 0);
});

test("읽음 집계 교체는 삭제 상태와 완료 번역의 역행 방어를 유지한다", () => {
  // 준비: 삭제·완료 번역을 이미 표시한 메시지에 과거 본문이 포함된 최신 집계가 도착한다.
  const message = parseMessage(messageDto());
  const completed = { ...message.translations[0]!, status: "COMPLETED" as const, translatedContent: "완료 본문", completedAt: "2026-10-21T01:00:02Z" };
  const current = { ...message, status: "DELETED" as const, unreadMemberCount: 0, translations: [completed] };

  // 실행·검증: 새 옵션은 읽음 숫자에만 적용되며 기존 본문 보호 정책은 그대로다.
  const merged = mergeMessages([current], [{ ...message, unreadMemberCount: 1 }], { authoritativeUnreadCounts: true });
  assert.equal(merged[0]?.unreadMemberCount, 1);
  assert.equal(merged[0]?.status, "DELETED");
  assert.deepEqual(merged[0]?.translations, [completed]);
});
