import assert from "node:assert/strict";
import test from "node:test";

import { NotificationBadge, shouldDismissReadNotification } from "../src/notifications/badge.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function nextTurn() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("이전 계정 쓰기가 늦게 끝나도 새 계정의 최신 수로 복구하고 이전 응답을 거부한다", async () => {
  // 준비: 첫 계정의 네이티브 쓰기를 대기시킨다.
  const firstWrite = deferred<boolean>();
  const calls: number[] = [];
  const badge = new NotificationBadge(async (count) => {
    calls.push(count);
    return calls.length === 1 ? firstWrite.promise : true;
  });
  let active = "a";
  badge.setSession({ sessionKey: "a", isCurrent: () => active === "a" });
  badge.setCount("a", 8);
  await nextTurn();

  // 실행: 계정을 바꾼 뒤 같은 네이티브 쓰기 큐에서 새 값을 적용한다.
  active = "b";
  badge.setSession({ sessionKey: "b", isCurrent: () => active === "b" });
  assert.equal(badge.setCount("a", 99), false);
  badge.setCount("b", 3);
  assert.deepEqual(calls, [8]);
  firstWrite.resolve(true);
  await badge.drain();

  // 검증
  assert.deepEqual(calls, [8, 3]);
});

test("로그아웃은 진행 중인 네이티브 쓰기가 끝난 뒤 반드시 0으로 정리한다", async () => {
  // 준비
  const firstWrite = deferred<boolean>();
  const calls: number[] = [];
  const badge = new NotificationBadge(async (count) => {
    calls.push(count);
    return calls.length === 1 ? firstWrite.promise : true;
  });
  badge.setSession({ sessionKey: "a", isCurrent: () => true });
  badge.setCount("a", 7);
  await nextTurn();

  // 실행
  badge.setSession(null);
  firstWrite.resolve(true);
  await badge.drain();

  // 검증
  assert.deepEqual(calls, [7, 0]);
  assert.equal(badge.setCount("a", 10), false);
});

test("세션 변경 effect 전에도 현재 세션 판정이 취소되면 진행 중 수를 0으로 복구한다", async () => {
  // 준비
  const firstWrite = deferred<boolean>();
  const calls: number[] = [];
  let current = true;
  const badge = new NotificationBadge(async (count) => {
    calls.push(count);
    return calls.length === 1 ? firstWrite.promise : true;
  });
  badge.setSession({ sessionKey: "a", isCurrent: () => current });
  badge.setCount("a", 9);
  await nextTurn();

  // 실행
  current = false;
  firstWrite.resolve(true);
  await badge.drain();

  // 검증
  assert.deepEqual(calls, [9, 0]);
});

test("동일 계정의 연속 수는 마지막 값으로 합치고 네이티브 쓰기를 겹치지 않는다", async () => {
  // 준비
  const firstWrite = deferred<boolean>();
  const calls: number[] = [];
  let writing = 0;
  let maximumWriting = 0;
  const badge = new NotificationBadge(async (count) => {
    calls.push(count);
    maximumWriting = Math.max(maximumWriting, ++writing);
    const result = calls.length === 1 ? await firstWrite.promise : true;
    writing -= 1;
    return result;
  });
  badge.setSession({ sessionKey: "a", isCurrent: () => true });
  badge.setCount("a", 1);
  await nextTurn();

  // 실행
  for (const count of [2, 2, 3, 4]) badge.setCount("a", count);
  firstWrite.resolve(true);
  await badge.drain();

  // 검증
  assert.deepEqual(calls, [1, 4]);
  assert.equal(maximumWriting, 1);
});

test("지원 불가 false와 reject는 루프 없이 끝나고 명시적 갱신으로 재시도한다", async () => {
  // 준비
  const calls: number[] = [];
  const badge = new NotificationBadge(async (count) => {
    calls.push(count);
    if (calls.length === 1) return false;
    if (calls.length === 2) throw new Error("temporary native failure");
    return true;
  });
  badge.setSession({ sessionKey: "a", isCurrent: () => true });
  badge.setCount("a", 2);

  // 실행
  await badge.drain();
  badge.retry();
  await badge.drain();
  badge.setCount("a", 2);
  await badge.drain();

  // 검증
  assert.deepEqual(calls, [2, 2, 2]);
});

test("잘못된 수는 무시하고 큰 검증된 수는 네이티브 정수 범위로 제한한다", async () => {
  // 준비
  const calls: number[] = [];
  const badge = new NotificationBadge(async (count) => { calls.push(count); return true; });
  badge.setSession({ sessionKey: "a", isCurrent: () => true });

  // 실행
  for (const count of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(badge.setCount("a", count), false);
  }
  assert.equal(badge.setCount("a", Number.MAX_SAFE_INTEGER), true);
  await badge.drain();

  // 검증
  assert.deepEqual(calls, [2_147_483_647]);
});

test("새 계정의 수가 아직 없어도 이전 배지를 0으로 비우며 같은 세션 갱신은 수를 유지한다", async () => {
  // 준비
  const calls: number[] = [];
  const badge = new NotificationBadge(async (count) => { calls.push(count); return true; });
  badge.setSession({ sessionKey: "a", isCurrent: () => true });
  badge.setCount("a", 4);
  await badge.drain();

  // 실행
  badge.setSession({ sessionKey: "a", isCurrent: () => true });
  await badge.drain();
  badge.setSession({ sessionKey: "b", isCurrent: () => true });
  await badge.drain();

  // 검증
  assert.deepEqual(calls, [4, 4, 0]);
});

test("예외를 내는 세션 판정은 유효한 수를 쓰지 않고 안전하게 0만 적용한다", async () => {
  // 준비
  const calls: number[] = [];
  const badge = new NotificationBadge(async (count) => { calls.push(count); return true; });
  badge.setSession({ sessionKey: "a", isCurrent: () => { throw new Error("released session"); } });

  // 실행
  assert.equal(badge.setCount("a", 5), false);
  await badge.drain();

  // 검증
  assert.deepEqual(calls, [0]);
});

const message = { schemaVersion: 1, eventId: "message-event", roomId: "12",
  messageId: "9007199254740993", accountBindingId: "binding-a" };
const invitation = { schemaVersion: 2, kind: "OPEN_INVITATION", eventId: "invite-event", roomId: "12",
  notificationId: "42", accountBindingId: "binding-a" };

test("읽음 알림 정리는 같은 계정과 방의 읽은 커서까지만 큰 문자열 ID로 비교한다", () => {
  // 준비
  const input = { data: message, accountBindingId: "binding-a",
    readRoomCursor: { roomId: "12", lastReadMessageId: "9007199254740993" } };

  // 실행 및 검증
  assert.equal(shouldDismissReadNotification(input), true);
  assert.equal(shouldDismissReadNotification({ ...input, data: { ...message, messageId: "9007199254740992" } }), true);
  assert.equal(shouldDismissReadNotification({ ...input, data: { ...message, messageId: "9007199254740994" } }), false);
  assert.equal(shouldDismissReadNotification({ ...input, accountBindingId: "binding-b" }), false);
  assert.equal(shouldDismissReadNotification({ ...input, accountBindingId: null }), false);
  assert.equal(shouldDismissReadNotification({ ...input, readRoomCursor: { roomId: "13", lastReadMessageId: "9999999999999999" } }), false);
});

test("초대 정리는 현재 계정에서 읽음으로 확인한 개별 초대에만 적용한다", () => {
  // 준비
  const input = { data: invitation, accountBindingId: "binding-a", readInvitationIds: ["42"] };

  // 실행 및 검증
  assert.equal(shouldDismissReadNotification(input), true);
  assert.equal(shouldDismissReadNotification({ ...input, readInvitationIds: ["41"] }), false);
  assert.equal(shouldDismissReadNotification({ ...input, accountBindingId: "binding-b" }), false);
  assert.equal(shouldDismissReadNotification({ data: invitation, accountBindingId: "binding-a",
    readRoomCursor: { roomId: "12", lastReadMessageId: "999" } }), false);
});

test("잘못된 payload와 읽음 커서는 알림창에서 제거하지 않는다", () => {
  // 준비
  const input = { accountBindingId: "binding-a", readRoomCursor: { roomId: "12", lastReadMessageId: "9999999999999999" } };

  // 실행 및 검증
  for (const data of [null, {}, { ...message, messageId: 123 }, { ...message, roomId: "../12" },
    { ...invitation, schemaVersion: 3 }, { ...invitation, accountBindingId: "" }]) {
    assert.equal(shouldDismissReadNotification({ ...input, data }), false);
  }
  for (const lastReadMessageId of ["", "0", "01", "-1", "1.5", "1e8", "999999999999999999999"]) {
    assert.equal(shouldDismissReadNotification({ ...input, data: message,
      readRoomCursor: { roomId: "12", lastReadMessageId } }), false);
  }
  assert.equal(shouldDismissReadNotification({ ...input, data: message,
    readRoomCursor: { roomId: "12", lastReadMessageId: 9007199254740994 as unknown as string } }), false);
});
