import assert from "node:assert/strict";
import test from "node:test";

import { accountIdentity, createIdentityActions } from "../src/domain/identity.ts";

const id = "TC-ABCD-2345";
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((success, failure) => { resolve = success; reject = failure; });
  return { promise, resolve, reject };
}

test("설정 ID는 프로필 publicId이며 내부 숫자 userId를 대신 사용하지 않는다", () => {
  // 준비: 내부 ID와 공개 검색 ID가 다른 실제 프로필 구조다.
  const user = { id: "42", publicId: id, name: "합성 사용자" };

  // 실행
  const identity = accountIdentity({ status: "signedIn", user });
  const missing = accountIdentity({ status: "signedIn", user: { id: "42" } as { publicId?: unknown } });

  // 검증
  assert.equal(identity.status, "ready");
  assert.equal(identity.publicId, id);
  assert.equal(missing.status, "unavailable");
  assert.equal(missing.publicId, null);
});

test("기존 공개 ID는 현재 생성 형식에 맞추거나 대소문자를 바꾸지 않는다", () => {
  // 준비: 공개 검색은 생성기의 현재 TC 형식만 강제하지 않는다.
  const values = ["TCAT-00000002", "LegacyId-abc"];

  // 실행·검증
  for (const publicId of values) {
    const identity = accountIdentity({ status: "signedIn", user: { publicId } });
    assert.equal(identity.status, "ready");
    assert.equal(identity.publicId, publicId);
  }
});

test("누락·공백·제어문자·숫자형 응답은 복사할 ID로 노출하지 않는다", () => {
  // 준비
  const invalid = [null, undefined, "", " \t ", "TC-ABCD\n2345", "TC-ABCD\u0085", 42, {}];

  // 실행·검증
  for (const publicId of invalid) {
    const identity = accountIdentity({ status: "signedIn", user: { publicId } });
    assert.equal(identity.status, "unavailable");
    assert.equal(identity.publicId, null);
  }
  assert.equal(accountIdentity({ status: "signedIn", user: null }).status, "unavailable");
});

test("복원·로그아웃·재인증 상태에서는 남은 이전 사용자 ID를 숨긴다", () => {
  // 준비: 늦은 렌더에 이전 사용자 객체가 남아 있어도 상태 경계가 우선이다.
  const user = { publicId: id };

  // 실행·검증
  assert.equal(accountIdentity({ status: "restoring", user }).publicId, null);
  assert.equal(accountIdentity({ status: "signedOut", user }).publicId, null);
  const expired = accountIdentity({ status: "signedOut", user, error: "SESSION_EXPIRED" });
  assert.equal(expired.publicId, null);
  assert.match(expired.message, /다시 로그인/);
});

test("사용자 동작 전에는 복사·공유를 실행하지 않고 정확한 공개 ID만 전달한다", async () => {
  // 준비
  const copied: string[] = [];
  const shared: string[] = [];
  const actions = createIdentityActions({ sessionKey: "session-a", publicId: id, isCurrent: () => true,
    copy: async value => { copied.push(value); return true; },
    share: async value => { shared.push(value); return "shared"; },
  });
  actions.attach();
  assert.deepEqual(copied, []);
  assert.deepEqual(shared, []);

  // 실행
  await actions.copy();
  assert.match(actions.getSnapshot().message!, /복사했어요/);
  await actions.share();

  // 검증: 계정명·내부 숫자 ID·인증 자격을 함께 내보내지 않는다.
  assert.deepEqual(copied, [id]);
  assert.deepEqual(shared, [id]);
  assert.equal(actions.getSnapshot().message, "ID 공유 창을 열었어요.");
});

test("화면이 연결되지 않았거나 현재 세션이 아니거나 ID가 없으면 OS 작업을 하지 않는다", async () => {
  // 준비
  let current = false;
  let calls = 0;
  const actions = createIdentityActions({ sessionKey: "session-a", publicId: id, isCurrent: () => current,
    copy: async () => { calls++; return true; }, share: async () => { calls++; return "shared"; },
  });
  const empty = createIdentityActions({ sessionKey: "session-a", publicId: null, isCurrent: () => true,
    copy: async () => { calls++; return true; }, share: async () => { calls++; return "shared"; },
  });

  // 실행
  await actions.copy();
  actions.attach();
  await actions.share();
  current = true;
  actions.detach();
  await actions.copy();
  empty.attach();
  await empty.copy();

  // 검증
  assert.equal(calls, 0);
});

test("연속 복사·공유 탭은 현재 OS 작업 하나만 실행한다", async () => {
  // 준비
  const pending = deferred<boolean>();
  let copies = 0;
  let shares = 0;
  const actions = createIdentityActions({ sessionKey: "session-a", publicId: id, isCurrent: () => true,
    copy: () => { copies++; return pending.promise; }, share: async () => { shares++; return "shared"; },
  });
  actions.attach();

  // 실행
  const first = actions.copy();
  await actions.copy();
  await actions.share();

  // 검증
  assert.equal(copies, 1);
  assert.equal(shares, 0);
  assert.equal(actions.getSnapshot().pending, "copy");
  pending.resolve(true);
  await first;
  assert.equal(actions.getSnapshot().pending, null);
});

test("Clipboard false와 예외는 성공으로 표시하지 않고 원문 오류를 노출하지 않는다", async () => {
  // 준비
  let failure: "false" | "throw" = "false";
  const actions = createIdentityActions({ sessionKey: "session-a", publicId: id, isCurrent: () => true,
    copy: async () => { if (failure === "throw") throw new Error("SYNTHETIC_PRIVATE_DETAIL"); return false; },
    share: async () => "shared",
  });
  actions.attach();

  // 실행·검증
  await actions.copy();
  assert.equal(actions.getSnapshot().error, true);
  assert.match(actions.getSnapshot().message!, /길게 눌러/);
  failure = "throw";
  await actions.copy();
  assert.equal(actions.getSnapshot().pending, null);
  assert.doesNotMatch(JSON.stringify(actions.getSnapshot()), /SYNTHETIC_PRIVATE_DETAIL/);
});

test("공유 취소는 전송 성공으로 표시하지 않고 공유 오류는 재시도할 수 있다", async () => {
  // 준비
  let mode: "dismissed" | "throw" | "shared" = "dismissed";
  const actions = createIdentityActions({ sessionKey: "session-a", publicId: id, isCurrent: () => true,
    copy: async () => true,
    share: async () => { if (mode === "throw") throw new Error("SYNTHETIC_OS_DETAIL"); return mode; },
  });
  actions.attach();

  // 실행·검증
  await actions.share();
  assert.equal(actions.getSnapshot().message, null);
  mode = "throw";
  await actions.share();
  assert.equal(actions.getSnapshot().error, true);
  assert.doesNotMatch(JSON.stringify(actions.getSnapshot()), /SYNTHETIC_OS_DETAIL/);
  mode = "shared";
  await actions.share();
  assert.equal(actions.getSnapshot().error, false);
  assert.equal(actions.getSnapshot().message, "ID 공유 창을 열었어요.");
});

test("복사 완료 전에 계정이 바뀌면 이전 계정 성공을 새 화면에 표시하지 않는다", async () => {
  // 준비
  let current = true;
  const pending = deferred<boolean>();
  const actions = createIdentityActions({ sessionKey: "session-a", publicId: id, isCurrent: () => current,
    copy: () => pending.promise, share: async () => "shared",
  });
  actions.attach();
  const copy = actions.copy();

  // 실행
  current = false;
  actions.detach();
  pending.resolve(true);
  await copy;

  // 검증
  assert.deepEqual(actions.getSnapshot(), { pending: null, message: null, error: false });
});

test("blur 뒤 복귀해도 미완료 OS 작업 잠금은 유지하고 늦은 피드백은 숨긴다", async () => {
  // 준비
  const oldCopy = deferred<boolean>();
  const newShare = deferred<"shared" | "dismissed">();
  let shares = 0;
  const actions = createIdentityActions({ sessionKey: "session-a", publicId: id, isCurrent: () => true,
    copy: () => oldCopy.promise, share: () => { shares++; return newShare.promise; },
  });
  actions.attach();
  const first = actions.copy();

  // 실행: 화면 활동 세대가 바뀌어도 실제 Promise가 끝나기 전에는 새 작업을 실행하지 않는다.
  actions.cancel();
  await actions.share();
  assert.equal(shares, 0);
  assert.equal(actions.getSnapshot().pending, "copy");
  oldCopy.resolve(true);
  await first;

  // 검증
  assert.equal(actions.getSnapshot().pending, null);
  assert.equal(actions.getSnapshot().message, null);
  const second = actions.share();
  assert.equal(shares, 1);
  assert.equal(actions.getSnapshot().pending, "share");
  newShare.resolve("dismissed");
  await second;
  assert.equal(actions.getSnapshot().pending, null);
});

test("계정 변경에도 같은 OS 잠금을 유지하고 다음 복사는 새 계정 ID만 사용한다", async () => {
  // 준비: 실제 화면은 actions를 계정마다 재생성하지 않고 공개 ID·세션 소유권만 갱신한다.
  const pending = deferred<boolean>();
  let currentKey = "session-a";
  const copied: string[] = [];
  const actions = createIdentityActions({ sessionKey: "session-a", publicId: id, isCurrent: key => key === currentKey,
    copy: value => { copied.push(value); return copied.length === 1 ? pending.promise : Promise.resolve(true); },
    share: async () => "shared",
  });
  actions.attach();
  const oldCopy = actions.copy();

  // 실행: 같은 사용자라도 다른 sid의 세대는 별도로 취급한다.
  currentKey = "session-b";
  actions.updateIdentity("LegacyId-B", currentKey);
  await actions.copy();
  assert.deepEqual(copied, [id]);
  assert.equal(actions.getSnapshot().pending, "copy");
  pending.resolve(true);
  await oldCopy;

  // 검증: 이전 결과는 새 계정의 성공 안내가 되지 않으며 완료 후 새 ID 작업은 가능하다.
  assert.equal(actions.getSnapshot().message, null);
  await actions.copy();
  assert.deepEqual(copied, [id, "LegacyId-B"]);
  assert.match(actions.getSnapshot().message!, /복사했어요/);
});

test("StrictMode setup-cleanup-setup 뒤에도 복사할 수 있고 해제 뒤 오류는 반사하지 않는다", async () => {
  // 준비
  const pending = deferred<boolean>();
  let calls = 0;
  const actions = createIdentityActions({ sessionKey: "session-a", publicId: id, isCurrent: () => true,
    copy: () => { calls++; return pending.promise; }, share: async () => "shared",
  });

  // 실행
  actions.attach();
  actions.detach();
  actions.attach();
  const copy = actions.copy();
  actions.detach();
  pending.reject(new Error("SYNTHETIC_LATE_ERROR"));
  await copy;

  // 검증
  assert.equal(calls, 1);
  assert.deepEqual(actions.getSnapshot(), { pending: null, message: null, error: false });
});
