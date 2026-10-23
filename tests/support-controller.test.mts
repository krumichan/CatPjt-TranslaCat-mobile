import assert from "node:assert/strict";
import test from "node:test";

import { ApiError } from "../src/api/client.ts";
import { createSupportController, emptySupportState, withSupportRevisionOffset, type SupportState, type SupportUncertain } from "../src/features/support/controller.ts";
import type { SupportCreateInput, SupportInquiry, SupportInquiryPage, SupportService } from "../src/features/support/service.ts";

const input: SupportCreateInput = { title: "앱 문의", content: "도움이 필요해요.", category: "GENERAL" };
const inquiry = (extra: Partial<SupportInquiry> = {}): SupportInquiry => ({ id: "10", ownerId: "1", ...input,
  status: "WAITING", replyCount: 0, createdAt: "2026-10-22T10:00:00Z", updatedAt: "2026-10-22T10:00:00Z", replies: [], unread: false, ...extra });
const page = (pageNumber = 0): SupportInquiryPage => ({ items: [inquiry({ id: String(10 + pageNumber) })], page: pageNumber,
  size: 20, totalElements: 41, totalPages: 3 });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function fixture(overrides: Partial<SupportService> = {}, options: {
  current?: () => boolean; timeout?: number; uncertain?: SupportUncertain | null;
} = {}) {
  const reads: string[] = [];
  const writes: string[] = [];
  const states: SupportState[] = [];
  let marker = options.uncertain ?? null;
  const service: SupportService = {
    list: async (number = 0) => { reads.push("list:" + number); return page(number); },
    detail: async id => { reads.push("detail:" + id); return inquiry({ id }); },
    create: async body => { writes.push("create"); return inquiry(body); },
    reply: async (id, body) => { writes.push("reply:" + id); return inquiry({ id, replyCount: 1,
      replies: [{ id: "31", parentId: null, content: body.content, authorRole: "USER", authorName: "테스트", createdAt: "2026-10-22T10:01:00Z" }] }); },
    ...overrides,
  };
  const controller = createSupportController({ service, isCurrent: options.current ?? (() => true),
    onChange: state => { states.push(state); }, initialUncertain: options.uncertain,
    onUncertainChange: next => { marker = next; }, requestTimeoutMs: options.timeout ?? 500 });
  return { controller, reads, writes, states, marker: () => marker };
}

test("문의 목록은 페이지를 명시해서 이동하고 실패한 다음 페이지를 현재 페이지로 표시하지 않는다", async () => {
  // 준비
  const f = fixture({ list: async number => {
    if (number === 2) throw new ApiError(0, "NETWORK_UNAVAILABLE");
    return page(number);
  } });
  // 실행
  await f.controller.list(1);
  await f.controller.list(2);
  // 검증
  assert.equal(f.controller.getSnapshot().pageNumber, 1);
  assert.equal(f.controller.getSnapshot().page?.page, 1);
  assert.equal(f.controller.getSnapshot().pending, null);
  assert.match(f.controller.getSnapshot().error!, /확인하지 못했어요/);
  f.controller.dispose();
});

test("잘못된 페이지와 문의 ID는 통신 전에 차단한다", async () => {
  // 준비
  const f = fixture();
  // 실행
  for (const number of [-1, 0.5, Infinity, 2147483648]) await f.controller.list(number);
  for (const id of ["0", "../1", "01", "9007199254740992"]) await f.controller.open(id);
  // 검증
  assert.deepEqual(f.reads, []);
  assert.equal(f.controller.getSnapshot().detail, null);
  f.controller.dispose();
});

test("다른 문의 조회 실패 때 이전 문의에 답글을 보내지 않는다", async () => {
  // 준비
  const f = fixture({ detail: async id => {
    if (id === "11") throw new ApiError(404, "HTTP_404");
    return inquiry({ id });
  } });
  await f.controller.open("10");
  // 실행
  await f.controller.open("11");
  await f.controller.reply("다른 문의로 보내면 안 돼요.");
  // 검증
  assert.equal(f.controller.getSnapshot().detail, null);
  assert.deepEqual(f.writes, []);
  f.controller.dispose();
});

test("제목·본문의 서버 길이 제한과 빈 입력을 쓰기 전에 검사한다", async () => {
  // 준비
  const f = fixture();
  // 실행
  for (const body of [{ ...input, title: " " }, { ...input, title: " ".repeat(200) + "가" },
    { ...input, content: "가".repeat(10001) }, { ...input, category: "UNSUPPORTED" as SupportCreateInput["category"] }]) await f.controller.create(body);
  await f.controller.open("10");
  await f.controller.reply(" ");
  await f.controller.reply("나".repeat(10001));
  // 검증
  assert.deepEqual(f.writes, []);
  assert.equal(f.marker(), null);
  assert.equal(f.controller.getSnapshot().createRevision, 0);
  assert.equal(f.controller.getSnapshot().replyRevision, 0);
  f.controller.dispose();
});

test("정상 작성은 정리한 입력을 한 번 보내고 서버가 확인한 상세와 폼 revision을 제공한다", async () => {
  // 준비
  let sent: SupportCreateInput | null = null;
  const f = fixture({ create: async body => { sent = body; return inquiry(body); } });
  // 실행
  await f.controller.create({ ...input, title: " 앱 문의 ", content: " 도움 " });
  // 검증
  assert.deepEqual(sent, { ...input, title: "앱 문의", content: "도움" });
  assert.equal(f.controller.getSnapshot().detail?.id, "10");
  assert.equal(f.controller.getSnapshot().createRevision, 1);
  assert.equal(f.controller.getSnapshot().uncertain, null);
  assert.equal(f.marker(), null);
  f.controller.dispose();
});

test("작성 버튼 연타와 작성 중 답글 동작은 POST를 한 번만 보낸다", async () => {
  // 준비
  const held = deferred<SupportInquiry>();
  let writes = 0;
  const f = fixture({ create: async () => { writes += 1; return held.promise; } });
  await f.controller.open("10");
  // 실행
  const first = f.controller.create(input);
  await f.controller.create(input);
  await f.controller.reply("중복 동작");
  held.resolve(inquiry());
  await first;
  // 검증
  assert.equal(writes, 1);
  assert.equal(f.controller.getSnapshot().createRevision, 1);
  f.controller.dispose();
});

test("작성 응답 유실 후 같은 내용이 목록에 있어도 성공으로 추정하거나 다시 보내지 않는다", async () => {
  // 준비
  let writes = 0;
  const f = fixture({ create: async () => { writes += 1; throw new ApiError(0, "NETWORK_UNAVAILABLE"); } });
  // 실행
  await f.controller.create(input);
  await f.controller.create(input);
  // 검증
  assert.equal(writes, 1);
  assert.deepEqual(f.reads, ["list:0"]);
  assert.equal(f.controller.getSnapshot().uncertain?.reviewed, true);
  assert.equal(f.controller.getSnapshot().createRevision, 0);
  assert.equal(f.controller.getSnapshot().notice, null);
  assert.match(f.controller.getSnapshot().error!, /자동으로 다시 보내지/);
  f.controller.dispose();
});

test("문의 POST의 5xx와 잘못된 성공 응답도 결과 확인 전에는 다시 보내지 않는다", async () => {
  // 준비·실행·검증
  for (const failure of [new ApiError(500, "HTTP_500"), new ApiError(0, "INVALID_API_RESPONSE")]) {
    let writes = 0;
    const f = fixture({ create: async () => { writes += 1; throw failure; } });
    await f.controller.create(input);
    await f.controller.create(input);
    assert.equal(writes, 1);
    assert.equal(f.controller.getSnapshot().uncertain?.kind, "create");
    assert.equal(f.controller.getSnapshot().createRevision, 0);
    f.controller.dispose();
  }
});

test("불명 결과의 확인 조회까지 실패하면 사용자 확인 버튼으로도 쓰기 잠금을 풀지 못한다", async () => {
  // 준비
  let failing = true;
  let writes = 0;
  const f = fixture({ create: async () => { writes += 1; throw new ApiError(0, "NETWORK_UNAVAILABLE"); },
    list: async number => { if (failing) throw new ApiError(0, "NETWORK_UNAVAILABLE"); return page(number); } });
  // 실행
  await f.controller.create(input);
  f.controller.acknowledgeUncertain();
  await f.controller.create(input);
  // 검증
  assert.equal(writes, 1);
  assert.equal(f.controller.getSnapshot().uncertain?.reviewed, false);
  failing = false;
  await f.controller.list(0);
  assert.equal(f.controller.getSnapshot().uncertain?.reviewed, true);
  f.controller.acknowledgeUncertain();
  assert.equal(f.controller.getSnapshot().uncertain, null);
  assert.match(f.controller.getSnapshot().notice!, /이미 반영된 내용/);
  f.controller.dispose();
});

test("명백한 4xx 거절은 결과 불명 성공으로 바꾸지 않고 새 명시적 작성만 허용한다", async () => {
  // 준비
  let attempts = 0;
  const f = fixture({ create: async () => { attempts += 1; throw new ApiError(403, "HTTP_403"); } });
  // 실행
  await f.controller.create(input);
  // 검증
  assert.equal(attempts, 1);
  assert.equal(f.controller.getSnapshot().uncertain, null);
  assert.deepEqual(f.reads, []);
  assert.match(f.controller.getSnapshot().error!, /변경할 수 없어요/);
  assert.equal(f.controller.getSnapshot().createRevision, 0);
  f.controller.dispose();
});

test("종료된 문의에는 추가 내용을 전송하지 않는다", async () => {
  // 준비
  const f = fixture({ detail: async () => inquiry({ status: "CLOSED" }) });
  await f.controller.open("10");
  // 실행
  await f.controller.reply("종료된 문의에 추가");
  // 검증
  assert.deepEqual(f.writes, []);
  assert.equal(f.marker(), null);
  assert.match(f.controller.getSnapshot().error!, /종료된 문의/);
  f.controller.dispose();
});

test("정상 답글은 선택한 문의에 한 번 보내고 답글 폼 revision만 증가시킨다", async () => {
  // 준비
  const f = fixture();
  await f.controller.open("10");
  // 실행
  await f.controller.reply(" 추가 내용 ");
  // 검증
  assert.deepEqual(f.writes, ["reply:10"]);
  assert.equal(f.controller.getSnapshot().detail?.replies[0]?.content, "추가 내용");
  assert.equal(f.controller.getSnapshot().replyRevision, 1);
  assert.equal(f.controller.getSnapshot().createRevision, 0);
  assert.equal(f.marker(), null);
  f.controller.dispose();
});

test("답글 응답 유실 후 같은 본문이 상세에 있어도 자동 재전송과 성공 표시를 막는다", async () => {
  // 준비
  let writes = 0;
  const existing = inquiry({ replyCount: 1, replies: [{ id: "31", parentId: null, content: "같은 내용",
    authorRole: "USER", authorName: "테스트", createdAt: "2026-10-22T10:01:00Z" }] });
  const f = fixture({ reply: async () => { writes += 1; throw new ApiError(0, "NETWORK_UNAVAILABLE"); }, detail: async () => existing });
  await f.controller.open("10");
  // 실행
  await f.controller.reply("같은 내용");
  await f.controller.reply("같은 내용");
  // 검증
  assert.equal(writes, 1);
  assert.equal(f.controller.getSnapshot().detail?.replies.length, 1);
  assert.equal(f.controller.getSnapshot().replyRevision, 0);
  assert.equal(f.controller.getSnapshot().uncertain?.reviewed, true);
  assert.equal(f.controller.getSnapshot().notice, null);
  f.controller.dispose();
});

test("예전 같은 본문 답글만 재반환되면 추가 성공으로 표시하지 않는다", async () => {
  // 준비
  const previous = inquiry({ replyCount: 1, replies: [{ id: "31", parentId: null, content: "같은 내용",
    authorRole: "USER", authorName: "테스트", createdAt: "2026-10-22T10:01:00Z" }] });
  let writes = 0;
  const f = fixture({ detail: async () => previous, reply: async () => { writes += 1; return previous; } });
  await f.controller.open("10");
  // 실행
  await f.controller.reply("같은 내용");
  await f.controller.reply("같은 내용");
  // 검증
  assert.equal(writes, 1);
  assert.equal(f.controller.getSnapshot().replyRevision, 0);
  assert.equal(f.controller.getSnapshot().notice, null);
  assert.equal(f.controller.getSnapshot().uncertain?.kind, "reply");
  f.controller.dispose();
});

test("답글 수 증가만으로는 부족하며 보낸 최상위 답글 대신 중첩 답글만 반환되면 성공을 추정하지 않는다", async () => {
  // 준비
  const original = inquiry({ replyCount: 1, replies: [{ id: "31", parentId: null, content: "기존 내용",
    authorRole: "USER", authorName: "테스트", createdAt: "2026-10-22T10:01:00Z" }] });
  const suspicious = inquiry({ replyCount: 2, replies: [...original.replies, { id: "32", content: "같은 내용", parentId: "31",
    authorRole: "USER", authorName: "테스트", createdAt: "2026-10-22T10:02:00Z" }] });
  const f = fixture({ detail: async () => original, reply: async () => suspicious });
  await f.controller.open("10");
  // 실행
  await f.controller.reply("같은 내용");
  // 검증
  assert.equal(f.controller.getSnapshot().replyRevision, 0);
  assert.equal(f.controller.getSnapshot().uncertain?.kind, "reply");
  f.controller.dispose();
});

test("운영자가 자기 문의에 추가한 새 최상위 답글도 정상 처리한다", async () => {
  // 준비
  const f = fixture({ reply: async id => inquiry({ id, status: "ANSWERED", replyCount: 1,
    replies: [{ id: "31", parentId: null, content: "내 문의 추가 내용", authorRole: "ADMIN", authorName: "운영자", createdAt: "2026-10-22T10:01:00Z" }] }) });
  await f.controller.open("10");
  // 실행
  await f.controller.reply("내 문의 추가 내용");
  // 검증
  assert.equal(f.controller.getSnapshot().replyRevision, 1);
  assert.equal(f.controller.getSnapshot().uncertain, null);
  assert.equal(f.controller.getSnapshot().detail?.status, "ANSWERED");
  f.controller.dispose();
});

test("개인 문의 범위를 벗어난 운영자 응답은 웹 문의함 안내로 멈춘다", async () => {
  // 준비
  const f = fixture({ list: async () => { throw new ApiError(0, "SUPPORT_PERSONAL_INQUIRIES_ONLY"); } });
  // 실행
  await f.controller.list(0);
  // 검증
  assert.equal(f.controller.getSnapshot().page, null);
  assert.match(f.controller.getSnapshot().error!, /운영자 계정은 웹/);
  f.controller.dispose();
});

test("불명 답글은 다른 문의나 목록을 확인해도 풀리지 않고 정확한 문의를 다시 열어야 한다", async () => {
  // 준비
  const f = fixture({}, { uncertain: { kind: "reply", inquiryId: "10", reviewed: true } });
  // 실행
  await f.controller.list(0);
  await f.controller.open("11");
  f.controller.acknowledgeUncertain();
  // 검증
  assert.equal(f.controller.getSnapshot().uncertain?.reviewed, false);
  await f.controller.open("10");
  assert.equal(f.controller.getSnapshot().uncertain?.reviewed, true);
  f.controller.acknowledgeUncertain();
  assert.equal(f.controller.getSnapshot().uncertain, null);
  f.controller.dispose();
});

test("계정·화면 소유권이 바뀐 뒤 늦게 끝난 POST는 성공 UI나 후속 조회를 만들지 않는다", async () => {
  // 준비
  const held = deferred<SupportInquiry>();
  let current = true;
  let writes = 0;
  const f = fixture({ create: async () => { writes += 1; return held.promise; } }, { current: () => current });
  const posting = f.controller.create(input);
  await Promise.resolve();
  // 실행
  current = false;
  held.resolve(inquiry());
  await posting;
  // 검증
  assert.equal(writes, 1);
  assert.equal(f.controller.getSnapshot().createRevision, 0);
  assert.equal(f.controller.getSnapshot().detail, null);
  assert.equal(f.marker()?.kind, "create");
  assert.deepEqual(f.reads, []);
  f.controller.dispose();
});

test("화면을 떠난 POST의 불명 표시를 새 컨트롤러로 넘기면 읽기 전 재전송을 막는다", async () => {
  // 준비
  const held = deferred<SupportInquiry>();
  const first = fixture({ create: async () => held.promise });
  const posting = first.controller.create(input);
  await Promise.resolve();
  // 실행
  first.controller.dispose();
  await posting;
  const next = fixture({}, { uncertain: first.marker() });
  await next.controller.create(input);
  next.controller.acknowledgeUncertain();
  // 검증
  assert.equal(next.writes.length, 0);
  assert.equal(next.controller.getSnapshot().uncertain?.reviewed, false);
  await next.controller.list(0);
  assert.equal(next.controller.getSnapshot().uncertain?.reviewed, true);
  held.resolve(inquiry());
  await Promise.resolve();
  assert.equal(first.controller.getSnapshot().createRevision, 0);
  next.controller.dispose();
});

test("쓰기 제한 시간은 abort를 전달하고 늦은 성공 응답이 잠금을 풀지 못한다", async () => {
  // 준비
  const held = deferred<SupportInquiry>();
  let sentSignal: AbortSignal | undefined;
  let writes = 0;
  const f = fixture({ create: async (_body, signal) => { writes += 1; sentSignal = signal; return held.promise; } }, { timeout: 10 });
  // 실행
  await f.controller.create(input);
  held.resolve(inquiry());
  await Promise.resolve();
  await f.controller.create(input);
  // 검증
  assert.equal(sentSignal?.aborted, true);
  assert.equal(writes, 1);
  assert.equal(f.controller.getSnapshot().pending, null);
  assert.equal(f.controller.getSnapshot().createRevision, 0);
  assert.equal(f.controller.getSnapshot().uncertain?.kind, "create");
  f.controller.dispose();
});

test("읽기 제한 시간과 화면 정리는 취소 무시 응답이 이전 UI를 덮지 못하게 한다", async () => {
  // 준비
  for (const dispose of [false, true]) {
    const held = deferred<SupportInquiryPage>();
    const f = fixture({ list: async () => held.promise }, { timeout: 10 });
    // 실행
    const loading = f.controller.list(0);
    if (dispose) f.controller.dispose();
    await loading;
    const changes = f.states.length;
    held.resolve(page());
    await Promise.resolve();
    // 검증
    assert.equal(f.controller.getSnapshot().page, null);
    assert.equal(f.states.length, changes);
    f.controller.dispose();
  }
});

test("작성 성공 뒤 비활성화·새 컨트롤러 복귀는 초안을 지우지 않고 다음 작성 성공만 한 번 더 비운다", async () => {
  // 준비: 화면의 revision 변경 감지를 사용자가 작성한 초안의 초기화 조건으로 재현한다.
  let visible = emptySupportState();
  let lastCreateRevision = 0;
  let clears = 0;
  const render = (state: SupportState) => {
    visible = state;
    if (lastCreateRevision !== state.createRevision) { lastCreateRevision = state.createRevision; clears += 1; }
  };
  const first = fixture();
  await first.controller.create(input);
  render(withSupportRevisionOffset(first.controller.getSnapshot(), { createRevision: 0, replyRevision: 0 }));
  assert.equal(clears, 1);
  first.controller.dispose();

  // 실행: 백그라운드의 빈 화면과 새 통신 컨트롤러의 첫 목록 응답도 이전 성공 번호를 유지한다.
  const previous = { createRevision: visible.createRevision, replyRevision: visible.replyRevision };
  render(withSupportRevisionOffset(emptySupportState(), previous));
  const second = fixture();
  await second.controller.list(0);
  render(withSupportRevisionOffset(second.controller.getSnapshot(), previous));

  // 검증: 복귀만으로 새 초안을 비우지 않고 두 번째 실제 성공은 2번으로 연결한다.
  assert.equal(visible.createRevision, 1);
  assert.equal(clears, 1);
  assert.equal(visible.detail, null);
  await second.controller.create(input);
  render(withSupportRevisionOffset(second.controller.getSnapshot(), previous));
  assert.equal(visible.createRevision, 2);
  assert.equal(clears, 2);
  second.controller.dispose();
});

test("답글 성공 번호도 여러 번 복귀하는 동안 유지되고 새 답글 성공만 누적한다", async () => {
  // 준비
  const first = fixture();
  await first.controller.open("10");
  await first.controller.reply("첫 번째 답글");
  let visible = withSupportRevisionOffset(first.controller.getSnapshot(), { createRevision: 2, replyRevision: 0 });
  assert.equal(visible.replyRevision, 1);
  first.controller.dispose();

  // 실행: 여러 번의 화면 복귀와 빈 로딩 상태를 거친다.
  for (let pass = 0; pass < 3; pass += 1) {
    const offset = { createRevision: visible.createRevision, replyRevision: visible.replyRevision };
    visible = withSupportRevisionOffset(emptySupportState(), offset);
    const owned = fixture();
    await owned.controller.open("10");
    visible = withSupportRevisionOffset(owned.controller.getSnapshot(), offset);
    assert.equal(visible.replyRevision, 1);
    if (pass === 2) {
      await owned.controller.reply("두 번째 답글");
      visible = withSupportRevisionOffset(owned.controller.getSnapshot(), offset);
    }
    owned.controller.dispose();
  }

  // 검증: 작성 성공 번호도 보존되며 답글 성공은 누락 없이 다음 번호로 연결된다.
  assert.equal(visible.createRevision, 2);
  assert.equal(visible.replyRevision, 2);
});

test("이전 성공 번호를 적용해도 결과 불명이나 실패는 새 성공 번호를 만들지 않는다", async () => {
  // 준비
  const f = fixture({ create: async () => { throw new ApiError(0, "NETWORK_UNAVAILABLE"); } });
  // 실행
  await f.controller.create(input);
  const visible = withSupportRevisionOffset(f.controller.getSnapshot(), { createRevision: 3, replyRevision: 2 });
  // 검증
  assert.equal(visible.createRevision, 3);
  assert.equal(visible.replyRevision, 2);
  assert.equal(visible.uncertain?.kind, "create");
  assert.equal(visible.notice, null);
  f.controller.dispose();
});
