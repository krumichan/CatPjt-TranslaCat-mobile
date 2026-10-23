import assert from "node:assert/strict";
import test from "node:test";

import { ApiError, createApiClient } from "../src/api/client.ts";
import { createReportController } from "../src/features/reports/controller.ts";
import { createReportService, reportBody, reportTarget, type ReportInput, type ReportReceipt } from "../src/features/reports/service.ts";

const id = "55375f70-8255-4710-bf76-f5038a3fceda";
const input: ReportInput = { targetType: "MESSAGE", messageId: "10", reason: "HARASSMENT", detail: "synthetic report", clientRequestId: id };
const receipt: ReportReceipt = { id: "15", roomId: "3", targetType: "MESSAGE", reason: "HARASSMENT", status: "PENDING",
  createdAt: "2026-10-23T00:00:00Z", evidenceExpiresAt: "2027-01-21T00:00:00Z", duplicate: false };

test("report target separates room-only OPEN identity from ordinary account ID", () => {
  // 실행·검증
  assert.deepEqual(reportBody({ ...input, detail: "  evidence  " }), { targetType: "MESSAGE", messageId: 10, reason: "HARASSMENT", detail: "evidence", clientRequestId: id });
  assert.deepEqual(reportTarget({ targetOpenChatMemberId: "8" }), { targetType: "MEMBER", targetOpenChatMemberId: "8" });
  assert.throws(() => reportTarget({ messageId: "10", targetUserId: "8" }));
  assert.throws(() => reportTarget({ messageId: ["10", "11"] }));
  assert.throws(() => reportTarget({ targetUserId: "9007199254740993" }));
  assert.throws(() => reportBody({ ...input, detail: "a".repeat(2001) }));
  assert.throws(() => reportBody({ ...input, clientRequestId: "not-a-uuid" }));
});

test("service sends only current-session report fields and validates receipt ownership", async () => {
  // 준비: 실제 사용자 데이터 없이 wire body와 route를 검사한다.
  const requests: { url: string; body: unknown }[] = [];
  let response = { ...receipt, id: 15, roomId: 3, version: 0, evidenceExpired: false };
  const api = createApiClient({ baseUrl: "https://api.example.test/api/v1", accessToken: async () => "synthetic-token", fetcher: async (url, options) => {
    requests.push({ url: String(url), body: JSON.parse(String(options?.body)) });
    return new Response(JSON.stringify({ body: response }), { status: 200 });
  } });

  // 실행
  const service = createReportService(api);
  assert.equal((await service.create("3", input)).id, "15");

  // 검증
  assert.equal(requests[0].url, "https://api.example.test/api/v1/chat/rooms/3/reports");
  assert.deepEqual(requests[0].body, reportBody(input));
  response = { ...response, roomId: 4 };
  await assert.rejects(service.create("3", input));
});

test("confirmation sends once and explicit unknown-result check reuses exact UUID and body", async () => {
  // 준비
  const submitted: ReportInput[] = [];
  const controller = createReportController({ roomId: "3", requestId: () => id, isCurrent: () => true, onChange: () => {},
    create: async (_room, value) => { submitted.push(value); if (submitted.length === 1) throw new ApiError(0, "NETWORK_UNAVAILABLE"); return receipt; } });

  // 실행: 준비와 취소만으로 신고가 생성되지 않는다.
  controller.prepare({ targetType: "MESSAGE", messageId: "10" }, "HARASSMENT", input.detail);
  assert.equal(submitted.length, 0);
  await controller.confirm();
  assert.equal(controller.snapshot().uncertain, true);
  controller.prepare({ targetType: "MESSAGE", messageId: "20" }, "OTHER", "changed");
  await controller.confirm();

  // 검증: 미확정 동안 입력은 고정되고 사용자의 명시적 확인만 같은 멱등 요청을 보낸다.
  assert.deepEqual(submitted, [input, input]);
  assert.equal(controller.snapshot().receipt?.id, receipt.id);
  await controller.confirm();
  assert.equal(submitted.length, 2);
});

test("cancel, duplicate taps and background late replies cannot create extra report or stale success", async () => {
  // 준비
  let active = true;
  let calls = 0;
  let finish: (value: ReportReceipt) => void = () => {};
  const response = new Promise<ReportReceipt>(resolve => { finish = resolve; });
  const controller = createReportController({ roomId: "3", requestId: () => id, isCurrent: () => active, onChange: () => {},
    create: async () => { calls++; return response; } });
  controller.prepare({ targetType: "MESSAGE", messageId: "10" }, "HARASSMENT", input.detail);
  controller.cancel();
  await controller.confirm();
  assert.equal(calls, 0);
  controller.prepare({ targetType: "MESSAGE", messageId: "10" }, "HARASSMENT", input.detail);

  // 실행
  const request = controller.confirm();
  await controller.confirm();
  active = false;
  controller.pause();
  finish(receipt);
  await request;
  active = true;
  controller.resume();

  // 검증
  assert.equal(calls, 1);
  assert.equal(controller.snapshot().receipt, null);
  assert.equal(controller.snapshot().pending, false);
  assert.equal(controller.snapshot().uncertain, true);
});

test("report timeout is bounded and confirmed HTTP rejection can be corrected without automatic retry", async () => {
  // 준비
  let calls = 0;
  const controller = createReportController({ roomId: "3", requestId: () => id, isCurrent: () => true, onChange: () => {}, timeoutMs: 10,
    create: async () => { calls++; return new Promise(() => {}); } });
  controller.prepare({ targetType: "MESSAGE", messageId: "10" }, "HARASSMENT", input.detail);

  // 실행
  await controller.confirm();

  // 검증
  assert.equal(calls, 1);
  assert.equal(controller.snapshot().pending, false);
  assert.equal(controller.snapshot().uncertain, true);
  const rejected = createReportController({ roomId: "3", requestId: () => id, isCurrent: () => true, onChange: () => {},
    create: async () => { throw new ApiError(403, "HTTP_403"); } });
  rejected.prepare({ targetType: "MESSAGE", messageId: "10" }, "HARASSMENT", input.detail);
  await rejected.confirm();
  assert.equal(rejected.snapshot().uncertain, false);
  assert.equal(rejected.snapshot().confirmation, null);
});
