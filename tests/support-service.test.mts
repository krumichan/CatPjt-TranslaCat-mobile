import assert from "node:assert/strict";
import test from "node:test";
import { ApiError, createApiClient } from "../src/api/client.ts";
import { createSupportService, SUPPORT_CATEGORIES, SUPPORT_PAGE_SIZE, validateSupportCreateInput, validateSupportReplyInput,
  type SupportCreateInput, type SupportReplyInput } from "../src/features/support/service.ts";

const createdAt = "2026-10-22T10:00:00.123456";
const input: SupportCreateInput = { title: "로그인 문의", content: "앱 로그인 상황을 확인해 주세요.", category: "ACCOUNT" };
const wire = () => ({ id: 11, ...input, status: "WAITING", user: { id: 7, name: "내 이름", email: "private@fixture.invalid", publicId: "private-id" },
  replyCount: 0, relatedMessageId: null, createdAt, updatedAt: createdAt, replies: [] as unknown[], unread: false });
const answer = (overrides = {}) => ({ id: 31, parentId: null, content: "추가 문의입니다.", authorRole: "USER", authorName: "문의 작성자", createdAt, ...overrides });
const page = (items: unknown[] = [wire()], overrides = {}) => ({ items, page: 0, size: 20, totalElements: items.length, totalPages: items.length ? 1 : 0, ...overrides });
const envelope = (body: unknown, status = 200) => new Response(JSON.stringify({ body }), { status });
const code = (expected: string) => (error: unknown) => error instanceof ApiError && error.code === expected;

function fixture(initial: unknown = wire()) {
  let body = initial;
  let status = 200;
  const calls: { url: URL; method: string; body: unknown; signal?: AbortSignal | null }[] = [];
  const service = createSupportService(createApiClient({ baseUrl: "https://fixture.invalid/api/v1", accessToken: async () => "synthetic-access",
    fetcher: async (url, options) => {
      calls.push({ url: new URL(String(url)), method: options?.method ?? "GET",
        body: options?.body === undefined ? undefined : JSON.parse(String(options.body)), signal: options?.signal });
      return envelope(body, status);
    } }), "7");
  return { service, calls, set: (next: unknown, nextStatus = 200) => { body = next; status = nextStatus; } };
}

test("본인 문의의 좁은 모델에는 이메일·이름·공개 ID·연결 메시지 ID가 포함되지 않는다", async () => {
  // 준비
  const dto = { ...wire(), relatedMessageId: 99 };
  const f = fixture(dto);
  // 실행
  const detail = await f.service.detail("11");
  // 검증
  assert.equal(detail.ownerId, "7");
  assert.equal(detail.id, "11");
  assert.equal(detail.createdAt, createdAt);
  assert.equal(detail.unread, false);
  assert.deepEqual(Object.keys(detail).sort(), ["id", "ownerId", "title", "content", "category", "status", "replyCount", "createdAt", "updatedAt", "replies", "unread"].sort());
  assert.doesNotMatch(JSON.stringify(detail), /private@|private-id|내 이름|relatedMessageId/);
});

test("목록은 답변 미포함 요약과 비어 있는 첫 페이지·범위 밖 페이지를 수용한다", async () => {
  // 준비
  const f = fixture(page([{ ...wire(), replyCount: 2 }]));
  // 실행·검증
  const result = await f.service.list();
  assert.equal(result.items[0]?.replyCount, 2);
  assert.deepEqual(result.items[0]?.replies, []);
  f.set(page([]));
  assert.equal((await f.service.list()).totalPages, 0);
  f.set(page([], { page: 3 }));
  assert.equal((await f.service.list(3)).items.length, 0);
});

test("목록 요청은 0 기반 페이지와 고정 크기 20만 보내며 상태 변경 API를 사용하지 않는다", async () => {
  // 준비
  const f = fixture(page([wire()], { page: 1, totalElements: 21, totalPages: 2 }));
  // 실행
  await f.service.list(1);
  // 검증
  assert.equal(SUPPORT_PAGE_SIZE, 20);
  assert.equal(f.calls[0]?.url.pathname, "/api/v1/support/inquiries");
  assert.equal(f.calls[0]?.url.search, "?page=1&size=20");
  assert.equal(f.calls[0]?.method, "GET");
  assert.equal(f.calls[0]?.body, undefined);
});

test("페이지 음수·분수·unsafe·서버 int 초과는 네트워크 요청 전에 거절한다", async () => {
  // 준비
  const f = fixture(page());
  // 실행·검증
  for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 2147483648]) {
    await assert.rejects(f.service.list(value), code("INVALID_SUPPORT_INPUT"));
  }
  assert.equal(f.calls.length, 0);
});

test("페이지 번호·크기·개수·중복 행이 모순인 응답은 부분 표시하지 않는다", async () => {
  // 준비
  const f = fixture();
  const invalid = [page([wire()], { page: 1 }), page([wire()], { size: 19 }), page([wire()], { totalPages: 2 }),
    page([wire()], { totalElements: 2 }), page([wire(), wire()]), page([wire()], { totalElements: -1 }),
    page([wire()], { totalElements: Number.MAX_SAFE_INTEGER + 1 }), page([{ ...wire(), replies: [answer()], replyCount: 1 }])];
  // 실행·검증
  for (const dto of invalid) {
    f.set(dto);
    await assert.rejects(f.service.list(), code("INVALID_API_RESPONSE"));
  }
});

test("관리자 전체 목록을 포함해 다른 소유자의 목록·상세·작성·답글 응답은 모두 차단한다", async () => {
  // 준비
  const other = { ...wire(), user: { ...wire().user, id: 8 } };
  const f = fixture(page([wire(), other]));
  // 실행·검증
  await assert.rejects(f.service.list(), code("SUPPORT_PERSONAL_INQUIRIES_ONLY"));
  f.set(other);
  await assert.rejects(f.service.detail("11"), code("SUPPORT_PERSONAL_INQUIRIES_ONLY"));
  await assert.rejects(f.service.create(input), code("SUPPORT_PERSONAL_INQUIRIES_ONLY"));
  f.set({ ...other, replies: [answer()], replyCount: 1 });
  await assert.rejects(f.service.reply("11", { content: "추가 문의입니다." }), code("SUPPORT_PERSONAL_INQUIRIES_ONLY"));
});

test("상세 응답은 실제 문의 ID와 안전한 중첩 ID·enum·불리언·시각을 검증한다", async () => {
  // 준비
  const f = fixture();
  const invalid = [{ ...wire(), id: 12 }, { ...wire(), id: "11" }, { ...wire(), id: Number.MAX_SAFE_INTEGER + 1 },
    { ...wire(), user: null }, { ...wire(), user: { id: "7" } }, { ...wire(), category: "REPORT" },
    { ...wire(), status: "OPEN" }, { ...wire(), unread: "false" }, { ...wire(), createdAt: "yesterday" },
    { ...wire(), title: " " }, { ...wire(), content: "x".repeat(10001) }, { ...wire(), relatedMessageId: "99" }];
  // 실행·검증
  for (const dto of invalid) {
    f.set(dto);
    await assert.rejects(f.service.detail("11"), code("INVALID_API_RESPONSE"));
  }
});

test("답변은 같은 문의의 선행 부모와 USER·ADMIN 역할만 포함하며 개수·순서가 맞아야 한다", async () => {
  // 준비
  const f = fixture({ ...wire(), replies: [answer(), answer({ id: 32, parentId: 31, authorRole: "ADMIN" })], replyCount: 2, status: "ANSWERED" });
  // 실행·검증
  const detail = await f.service.detail("11");
  assert.equal(detail.replies[1]?.parentId, "31");
  assert.equal(detail.replies[1]?.authorRole, "ADMIN");
  for (const replies of [[answer(), answer()], [answer({ parentId: 99 })], [answer({ parentId: 31 })],
    [answer({ authorRole: "OWNER" })], [answer({ id: Number.MAX_SAFE_INTEGER + 1 })], [answer({ parentId: "31" })]]) {
    f.set({ ...wire(), replies, replyCount: replies.length });
    await assert.rejects(f.service.detail("11"), code("INVALID_API_RESPONSE"));
  }
  f.set({ ...wire(), replies: [answer()], replyCount: 0 });
  await assert.rejects(f.service.detail("11"), code("INVALID_API_RESPONSE"));
});

test("상세·답글·self ID의 경로 탈출과 반올림 위험을 요청 전에 거절한다", async () => {
  // 준비
  const f = fixture();
  // 실행·검증
  for (const id of ["../11", "0", "-1", "01", "1.5", "9007199254740993", "11/replies", " 11"]) {
    await assert.rejects(f.service.detail(id), code("INVALID_SUPPORT_INPUT"));
    await assert.rejects(f.service.reply(id, { content: "내용" }), code("INVALID_SUPPORT_INPUT"));
    assert.throws(() => createSupportService(createApiClient({ baseUrl: null, accessToken: async () => null }), id), code("INVALID_SUPPORT_INPUT"));
  }
  assert.equal(f.calls.length, 0);
});

test("문의 작성은 제목·본문·유형만 보내고 연결 메시지·계정·역할·상태 입력을 제거한다", async () => {
  // 준비
  const f = fixture();
  const unsafe = { ...input, title: ` ${input.title} `, content: ` ${input.content} `,
    relatedMessageId: 999, ownerId: 8, userId: 8, authorRole: "ADMIN", status: "ANSWERED" };
  // 실행
  await f.service.create(unsafe);
  // 검증
  assert.equal(f.calls[0]?.url.pathname, "/api/v1/support/inquiries");
  assert.equal(f.calls[0]?.method, "POST");
  assert.deepEqual(f.calls[0]?.body, input);
});

test("문의 입력은 서버와 같은 UTF-16 제목 200·본문 10000 한계와 유형을 지킨다", async () => {
  // 준비
  const f = fixture();
  const invalid: SupportCreateInput[] = [{ ...input, title: " " }, { ...input, title: "x".repeat(201) },
    { ...input, title: "😀".repeat(101) }, { ...input, title: " ".repeat(200) + "x" },
    { ...input, content: "\n\t" }, { ...input, content: "x".repeat(10001) },
    { ...input, category: "REPORT" as SupportCreateInput["category"] }];
  // 실행·검증
  assert.equal(validateSupportCreateInput({ ...input, title: "😀".repeat(100), content: "x".repeat(10000) }).title.length, 200);
  assert.deepEqual(SUPPORT_CATEGORIES, ["GENERAL", "ACCOUNT", "TRANSLATION", "LEARNING", "CHAT", "ACCOUNT_BOOK", "OTHER"]);
  for (const value of invalid) await assert.rejects(f.service.create(value), code("INVALID_SUPPORT_INPUT"));
  assert.equal(f.calls.length, 0);
});

test("문의 작성 응답은 요청한 제목·본문·유형과 신규 대기 상태를 대조한다", async () => {
  // 준비
  const f = fixture();
  // 실행·검증
  for (const dto of [{ ...wire(), title: "다른 제목" }, { ...wire(), content: "다른 내용" }, { ...wire(), category: "CHAT" },
    { ...wire(), status: "CLOSED" }, { ...wire(), replies: [answer()], replyCount: 1 }]) {
    f.set(dto);
    await assert.rejects(f.service.create(input), code("INVALID_API_RESPONSE"));
  }
});

test("후속 답글은 지정 문의에 본문만 보내고 parentId·작성자·상태를 전송하지 않는다", async () => {
  // 준비
  const f = fixture({ ...wire(), replies: [answer()], replyCount: 1 });
  const unsafe = { content: " 추가 문의입니다. ", parentId: 999, authorRole: "ADMIN", userId: 8, status: "CLOSED" };
  // 실행
  const detail = await f.service.reply("11", unsafe);
  // 검증
  assert.equal(detail.replies[0]?.content, "추가 문의입니다.");
  assert.equal(f.calls[0]?.url.pathname, "/api/v1/support/inquiries/11/replies");
  assert.equal(f.calls[0]?.method, "POST");
  assert.deepEqual(f.calls[0]?.body, { content: "추가 문의입니다." });
});

test("후속 답글 빈 내용·초과 길이와 다른 문의·누락 내용·종료 성공 응답을 거절한다", async () => {
  // 준비
  const f = fixture({ ...wire(), replies: [answer()], replyCount: 1 });
  // 실행·검증
  for (const content of [" ", "x".repeat(10001)]) {
    await assert.rejects(f.service.reply("11", { content }), code("INVALID_SUPPORT_INPUT"));
  }
  assert.equal(validateSupportReplyInput({ content: "x".repeat(10000) }).content.length, 10000);
  assert.equal(f.calls.length, 0);
  for (const dto of [{ ...wire(), id: 12, replies: [answer()], replyCount: 1 },
    { ...wire(), replies: [answer({ content: "다른 내용" })], replyCount: 1 },
    { ...wire(), status: "CLOSED", replies: [answer()], replyCount: 1 }]) {
    f.set(dto);
    await assert.rejects(f.service.reply("11", { content: "추가 문의입니다." }), code("INVALID_API_RESPONSE"));
  }
});

test("예전 답글만 본문이 일치하거나 최신 답글에 부모가 연결된 응답은 성공으로 간주하지 않는다", async () => {
  // 준비
  const f = fixture({ ...wire(), replies: [answer(), answer({ id: 32, content: "다른 후속 답변" })], replyCount: 2 });
  // 실행·검증
  await assert.rejects(f.service.reply("11", { content: "추가 문의입니다." }), code("INVALID_API_RESPONSE"));
  f.set({ ...wire(), replies: [answer(), answer({ id: 32, parentId: 31 })], replyCount: 2 });
  await assert.rejects(f.service.reply("11", { content: "추가 문의입니다." }), code("INVALID_API_RESPONSE"));
  assert.equal(f.calls.length, 2);
});

test("서버 종료 문의의 409는 안전한 HTTP 오류로 반환하며 답글을 자동 재전송하지 않는다", async () => {
  // 준비
  const f = fixture();
  f.set({ errorCode: "SUPPORT_INQUIRY_CLOSED", message: "private raw server text" }, 409);
  // 실행·검증
  await assert.rejects(f.service.reply("11", { content: "추가 문의입니다." }), error =>
    error instanceof ApiError && error.status === 409 && error.code === "HTTP_409" && !String(error).includes("private raw"));
  assert.equal(f.calls.length, 1);
});

test("목록·읽음 처리 상세·작성·답글 모두 같은 AbortSignal을 전달한다", async () => {
  // 준비
  const f = fixture(page());
  const controller = new AbortController();
  // 실행
  await f.service.list(0, controller.signal);
  f.set(wire());
  await f.service.detail("11", controller.signal);
  await f.service.create(input, controller.signal);
  f.set({ ...wire(), replies: [answer()], replyCount: 1 });
  await f.service.reply("11", { content: "추가 문의입니다." }, controller.signal);
  // 검증
  assert.equal(f.calls.length, 4);
  assert.ok(f.calls.every(call => call.signal === controller.signal));
});

test("상세 GET과 쓰기 응답 유실은 재시도하지 않고 네트워크 오류만 전달한다", async () => {
  // 준비
  let calls = 0;
  const service = createSupportService(createApiClient({ baseUrl: "https://fixture.invalid/api/v1", accessToken: async () => "synthetic-access",
    fetcher: async () => { calls += 1; throw new Error("private network detail"); } }), "7");
  // 실행·검증
  await assert.rejects(service.detail("11"), code("NETWORK_UNAVAILABLE"));
  await assert.rejects(service.create(input), code("NETWORK_UNAVAILABLE"));
  await assert.rejects(service.reply("11", { content: "추가 문의입니다." }), code("NETWORK_UNAVAILABLE"));
  assert.equal(calls, 3);
});

test("실행 시 잘못된 타입의 문의·답글 입력도 원문 TypeError 없이 검증 오류로 거절한다", async () => {
  // 준비
  const f = fixture();
  // 실행·검증
  await assert.rejects(f.service.create({ ...input, title: 7 } as unknown as SupportCreateInput), code("INVALID_SUPPORT_INPUT"));
  await assert.rejects(f.service.reply("11", { content: null } as unknown as SupportReplyInput), code("INVALID_SUPPORT_INPUT"));
  assert.equal(f.calls.length, 0);
});
