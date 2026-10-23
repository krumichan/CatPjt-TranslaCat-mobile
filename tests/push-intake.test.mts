import assert from "node:assert/strict";
import test from "node:test";

import { NotificationIntake } from "../src/notifications/intake.ts";
import { NotificationResponses } from "../src/notifications/response.ts";

const payload = { schemaVersion: 1, eventId: "cold-event", roomId: "11", messageId: "22", accountBindingId: "binding-a" };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

function setup() {
  const opened: string[] = [];
  const responses = new NotificationResponses(room => opened.push(room), () => {});
  responses.setSession({ sessionKey: "a", accountBindingId: "binding-a", verifyRoom: async () => true });
  return { opened, intake: new NotificationIntake(data => responses.receive(data)) };
}

test("새 warm B 탭 이후 늦은 cold A getter는 이전 방으로 탐색을 덮지 않는다", async () => {
  // 준비
  const { opened, intake } = setup();
  // 실행
  assert.equal(intake.live({ ...payload, eventId: "warm-event", roomId: "33" }), true);
  await tick();
  assert.equal(intake.cold(payload), false);
  await tick();
  // 검증
  assert.deepEqual(opened, ["33"]);
});

test("effect cleanup 이후 늦은 cold 또는 live 응답은 보류·탐색을 만들지 않는다", async () => {
  // 준비
  const { opened, intake } = setup();
  // 실행
  intake.stop();
  assert.equal(intake.cold(payload), false);
  assert.equal(intake.live({ ...payload, eventId: "late-live" }), false);
  await tick();
  // 검증
  assert.deepEqual(opened, []);
});

test("새 live가 없는 일반 cold 시작은 기존 인증·멤버십 검증을 거쳐 정상 탐색한다", async () => {
  // 준비
  const { opened, intake } = setup();
  // 실행
  assert.equal(intake.cold(payload), true);
  await tick();
  // 검증
  assert.deepEqual(opened, ["11"]);
});
