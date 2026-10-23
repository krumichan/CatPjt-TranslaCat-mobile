import test from "node:test";
import assert from "node:assert/strict";

import { ApiError } from "../src/api/client.ts";
import { deletionBrowserUrl, parseDeletionReceipt, parseDeletionStatus, receiptSecret, validDeletionCallback, type DeletionReceipt } from "../src/features/account-deletion/contracts.ts";
import { createDeletionController } from "../src/features/account-deletion/controller.ts";

const receipt: DeletionReceipt = { operationId: "714d5b48-0215-4f51-b74d-21777c2f401e", receiptSecret: "a".repeat(43), expectedPublicId: "TC-SYNTHETIC", returnScheme: "translacat-dev" };
const pending = { operationId: receipt.operationId, status: "PENDING", requestedAtUtc: "2026-10-23T00:00:00Z", completedAtUtc: null, receiptExpiresAtUtc: null };

function fixture(options: { failStorage?: boolean; saved?: DeletionReceipt; result?: unknown; readStatus?: () => Promise<unknown> } = {}) {
  // 준비: 보안 저장소·브라우저·상태 조회를 각각 관측 가능한 로컬 대역으로 둔다.
  const events: string[] = [];
  let saved: string | null = options.saved ? JSON.stringify(options.saved) : null;
  let active = true;
  let accepted = 0;
  const controller = createDeletionController({
    storage: {
      read: async () => { events.push("read"); return saved; },
      write: async value => { events.push("write"); if (options.failStorage) throw new Error("synthetic storage failure"); saved = value; },
      remove: async () => { events.push("remove"); if (options.failStorage) throw new Error("synthetic storage failure"); saved = null; },
    },
    current: () => active,
    createReceipt: async () => { events.push("random"); return receipt; },
    openBrowser: async value => { events.push("browser"); assert.deepEqual(JSON.parse(saved!), value); },
    readStatus: async () => { events.push("status"); return options.readStatus ? options.readStatus() : options.result ?? pending; },
    onChange: () => {}, onAccepted: async value => { assert.equal(value, receipt.expectedPublicId); accepted++; },
    requestTimeoutMs: 20,
  });
  return { controller, events, accepted: () => accepted, deactivate: () => { active = false; } };
}

test("deletion handoff uses only HTTPS fragment and callback contains only operation ID", () => {
  // 실행
  const url = new URL(deletionBrowserUrl("https://translacat.vercel.app", receipt));

  // 검증: secret가 서버 query/path/callback으로 넘어가지 않고 외부 callback 주입을 거절한다.
  assert.equal(url.pathname, "/ko/account-deletion");
  assert.equal(url.search, "");
  assert.equal(new URLSearchParams(url.hash.slice(1)).get("receiptSecret"), receipt.receiptSecret);
  assert.equal(validDeletionCallback(`translacat-dev://account-deletion?operationId=${receipt.operationId}`, receipt), true);
  for (const candidate of [`https://evil.example/?operationId=${receipt.operationId}`, `translacat-dev://account-deletion?operationId=${receipt.operationId}&receiptSecret=leak`, `translacat-dev://account-deletion?operationId=${receipt.operationId}&operationId=other`]) {
    assert.equal(validDeletionCallback(candidate, receipt), false);
  }
  assert.throws(() => deletionBrowserUrl("http://translacat.vercel.app", receipt));
  assert.throws(() => parseDeletionReceipt({ ...receipt, returnScheme: "https" }));
});

test("receipt entropy is exactly 32 bytes and invalid status never becomes completed", () => {
  // 준비
  const bytes = Uint8Array.from({ length: 32 }, (_, index) => index * 7);

  // 실행·검증
  assert.equal(receiptSecret(bytes), Buffer.from(bytes).toString("base64url"));
  assert.throws(() => receiptSecret(new Uint8Array(31)));
  assert.throws(() => parseDeletionReceipt({ ...receipt, receiptSecret: "a".repeat(42) }));
  assert.throws(() => parseDeletionStatus({ ...pending, status: "COMPLETED" }, receipt.operationId));
  assert.throws(() => parseDeletionStatus({ ...pending, operationId: "other" }, receipt.operationId));
});

test("device receipt is durably saved and read back before browser opens", async () => {
  // 준비
  const f = fixture();
  await f.controller.restore();

  // 실행
  await f.controller.begin(receipt.expectedPublicId);

  // 검증: 앱에는 삭제 API가 없고 브라우저 복귀 후 읽기 전용 상태만 확인한다.
  assert.deepEqual(f.events, ["read", "random", "write", "read", "browser", "status"]);
  assert.equal(f.accepted(), 1);
  assert.equal(f.controller.snapshot().status?.status, "PENDING");
});

test("secure storage failure prevents browser launch and any status request", async () => {
  // 준비
  const f = fixture({ failStorage: true });
  await f.controller.restore();

  // 실행
  await f.controller.begin(receipt.expectedPublicId);

  // 검증
  assert.equal(f.events.includes("browser"), false);
  assert.equal(f.events.includes("status"), false);
  assert.equal(f.accepted(), 0);
  assert.ok(f.controller.snapshot().error);
});

test("saved receipt cannot initiate deletion for a different current account", async () => {
  // 준비
  const f = fixture({ saved: receipt });
  await f.controller.restore();

  // 실행
  await f.controller.begin("TC-OTHER");

  // 검증
  assert.equal(f.events.includes("random"), false);
  assert.equal(f.events.includes("browser"), false);
  assert.equal(f.accepted(), 0);
  assert.match(f.controller.snapshot().error!, /다른 계정/);
});

test("unconfirmed or malformed status never clears an account", async () => {
  // 준비
  const f = fixture({ saved: receipt, result: { ...pending, operationId: "different" } });
  await f.controller.restore();

  // 실행
  await f.controller.check();

  // 검증
  assert.equal(f.accepted(), 0);
  assert.equal(f.controller.snapshot().status, null);
  assert.equal(f.events.filter(value => value === "status").length, 1);
  assert.equal(f.controller.snapshot().pending, null);
});

test("late status after disposal cannot log out a newly opened account", async () => {
  // 준비
  let finish: (value: unknown) => void = () => {};
  const response = new Promise(resolve => { finish = resolve; });
  const f = fixture({ saved: receipt, readStatus: () => response });
  await f.controller.restore();

  // 실행: 통신이 끝나기 전에 화면 소유권을 버린다.
  const request = f.controller.check();
  f.controller.dispose();
  finish(pending);
  await request;

  // 검증
  assert.equal(f.accepted(), 0);
});

test("ignored abort still has bounded status timeout and never retries a mutation", async () => {
  // 준비
  const f = fixture({ saved: receipt, readStatus: () => new Promise(() => {}) });
  await f.controller.restore();

  // 실행
  await f.controller.check();

  // 검증
  assert.equal(f.controller.snapshot().pending, null);
  assert.equal(f.accepted(), 0);
  assert.deepEqual(f.events, ["read", "status"]);
});

test("not-found receipt response is informational and never treated as deletion success", async () => {
  // 준비
  const f = fixture({ saved: receipt, readStatus: async () => { throw new ApiError(404, "HTTP_404"); } });
  await f.controller.restore();

  // 실행
  await f.controller.check();

  // 검증
  assert.equal(f.accepted(), 0);
  assert.match(f.controller.snapshot().notice!, /아직 접수되지/);
  assert.equal(f.controller.snapshot().status, null);
});

test("strict-effect remount restores the same receipt without new entropy or browser launch", async () => {
  // 준비
  const f = fixture({ saved: receipt });
  await f.controller.restore();
  f.controller.dispose();

  // 실행
  f.controller.attach();
  await f.controller.restore();

  // 검증
  assert.equal(f.controller.snapshot().receipt?.operationId, receipt.operationId);
  assert.deepEqual(f.events, ["read", "read"]);
});


test("explicit local receipt removal permits a new account without sending a deletion request", async () => {
  // 준비: 이전 계정 영수증이 복구돼도 사용자의 확인 전에는 지우지 않는다.
  const f = fixture({ saved: receipt });
  await f.controller.restore();
  assert.equal(f.events.includes("remove"), false);

  // 실행
  await f.controller.forget();

  // 검증: 서버 호출·로그아웃 없이 기기 기록만 사라진다.
  assert.equal(f.controller.snapshot().receipt, null);
  assert.equal(f.controller.snapshot().status, null);
  assert.equal(f.accepted(), 0);
  assert.deepEqual(f.events, ["read", "remove", "read"]);
  assert.match(f.controller.snapshot().notice!, /서버에 접수된 삭제 처리는 계속/);
});

test("failed local receipt removal preserves the previous receipt for recovery", async () => {
  // 준비
  const f = fixture({ saved: receipt, failStorage: true });
  await f.controller.restore();

  // 실행
  await f.controller.forget();

  // 검증
  assert.equal(f.controller.snapshot().receipt?.operationId, receipt.operationId);
  assert.ok(f.controller.snapshot().error);
  assert.equal(f.accepted(), 0);
  assert.equal(f.events.includes("status"), false);
});
