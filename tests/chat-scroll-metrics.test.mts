import assert from "node:assert/strict";
import test from "node:test";

import { ChatScrollMetrics } from "../src/domain/chat/scroll-metrics.ts";

test("측정 전에는 native scroll의 크기를 초기 위치 계산에 사용한다", () => {
  // 준비·실행: onLayout보다 scroll 이벤트가 먼저 도착한다.
  const metrics = new ChatScrollMetrics();
  metrics.observeScroll(5400, 6000, 600);

  // 검증: 첫 배치를 위해 아직 없는 측정값만 보완한다.
  assert.equal(metrics.offset, 5400);
  assert.equal(metrics.content, 6000);
  assert.equal(metrics.viewport, 600);
});

test("키보드 resize 측정 뒤 늦은 scroll의 이전 viewport가 현재 높이를 덮지 않는다", () => {
  // 준비: 최신 위치에서 키보드가 열려 목록 높이가 600에서 300으로 줄었다.
  const metrics = new ChatScrollMetrics();
  metrics.measureContent(6000);
  metrics.measureViewport(600);
  metrics.observeScroll(5400, 6000, 600);
  assert.equal(metrics.measureViewport(300), true);

  // 실행: resize 전에 만들어진 scroll 이벤트가 나중에 전달된다.
  metrics.observeScroll(5400, 6000, 600);

  // 검증: offset은 관측하되 하단 계산은 실제 새 높이를 사용한다.
  assert.equal(metrics.viewport, 300);
  assert.equal(metrics.offset, 5400);
  assert.equal(metrics.content - metrics.viewport, 5700);
});

test("scroll이 먼저 새 크기를 알려도 뒤의 실제 측정 변화는 한 번 인식한다", () => {
  // 준비·실행: 첫 scroll fallback 뒤 동일한 실제 측정 이벤트가 온다.
  const metrics = new ChatScrollMetrics();
  metrics.observeScroll(5700, 6000, 300);

  // 검증: fallback과 별도로 측정 이벤트를 기억해 필요한 배치 보정을 놓치지 않는다.
  assert.equal(metrics.measureViewport(300), true);
  assert.equal(metrics.measureContent(6000), true);
  assert.equal(metrics.measureViewport(300), false);
  assert.equal(metrics.measureContent(6000), false);
});

test("번역으로 콘텐츠 높이가 바뀐 뒤 늦은 scroll의 옛 높이로 하단을 계산하지 않는다", () => {
  // 준비: 번역 결과로 마지막 메시지가 길어졌다.
  const metrics = new ChatScrollMetrics();
  metrics.measureViewport(300);
  metrics.measureContent(6000);
  metrics.observeScroll(5700, 6000, 300);
  assert.equal(metrics.measureContent(6400), true);

  // 실행·검증: 과거 contentSize가 최신 콘텐츠 높이를 줄이지 못한다.
  metrics.observeScroll(5700, 6000, 300);
  assert.equal(metrics.content, 6400);
  assert.equal(metrics.content - metrics.viewport, 6100);
  assert.equal(metrics.measureContent(6400), false);
});

test("content와 viewport 측정이 각각 다른 순서로 와도 측정된 축만 우선한다", () => {
  // 준비·실행: 한 종류의 측정만 있는 상태에서 scroll 크기가 갱신된다.
  const viewportFirst = new ChatScrollMetrics();
  viewportFirst.measureViewport(300);
  viewportFirst.observeScroll(5400, 6000, 600);
  const contentFirst = new ChatScrollMetrics();
  contentFirst.measureContent(6400);
  contentFirst.observeScroll(5400, 6000, 600);

  // 검증: 측정이 없는 나머지 크기는 초기 fallback을 계속 사용할 수 있다.
  assert.equal(viewportFirst.viewport, 300);
  assert.equal(viewportFirst.content, 6000);
  assert.equal(contentFirst.content, 6400);
  assert.equal(contentFirst.viewport, 600);
});

test("키보드를 닫은 뒤 실제 viewport 확장은 이전 작은 scroll 크기로 되돌아가지 않는다", () => {
  // 준비: 키보드가 열린 작은 목록에서 실제 닫기 측정이 발생한다.
  const metrics = new ChatScrollMetrics();
  metrics.measureContent(6000);
  metrics.measureViewport(300);
  metrics.observeScroll(5700, 6000, 300);
  metrics.measureViewport(600);

  // 실행·검증: 늦게 전달된 작은 viewport 이벤트는 새 하단 기준을 바꾸지 않는다.
  metrics.observeScroll(5400, 6000, 300);
  assert.equal(metrics.viewport, 600);
  assert.equal(metrics.content - metrics.viewport - metrics.offset, 0);
});
