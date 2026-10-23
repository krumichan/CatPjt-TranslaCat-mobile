import assert from "node:assert/strict";
import test from "node:test";

import { ChatScrollFollow } from "../src/domain/chat/scroll-follow.ts";

function fixture(resizeForLatestButton = false) {
  // 준비: 네이티브 RAF·제스처 종료 타이머를 결정적으로 진행하고 실제 이동 명령을 기록한다.
  let sequence = 0;
  let now = 0;
  let active = true;
  let ready = true;
  let following = false;
  let lastVisible = true;
  const metrics = { content: 6000, viewport: 600, offset: 5384 };
  const frames = new Map<number, () => void>();
  const timers = new Map<number, { callback: () => void; due: number }>();
  const commands: number[] = [];
  const states: boolean[] = [];
  const controller = new ChatScrollFollow({
    scheduler: {
      requestFrame: (callback) => { frames.set(++sequence, callback); return sequence; },
      cancelFrame: (id) => { frames.delete(id); },
      setTimer: (callback, delay) => { timers.set(++sequence, { callback, due: now + delay }); return sequence; },
      clearTimer: (id) => { timers.delete(id as number); },
    },
    canFollow: () => active && ready,
    isAtBottom: () => lastVisible && metrics.content - metrics.viewport - metrics.offset <= 18,
    scrollToEnd: () => {
      commands.push(metrics.content - metrics.viewport);
      metrics.offset = metrics.content - metrics.viewport - 16;
      controller.scrolled();
    },
    onFollowingChange: (value) => {
      following = value;
      states.push(value);
      if (resizeForLatestButton) {
        metrics.viewport += value ? 38 : -38;
        controller.contentOrViewportChanged();
      }
    },
  });
  const flushFrame = () => {
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach((callback) => callback());
  };
  const advance = (ms: number) => {
    now += ms;
    for (const [id, timer] of [...timers]) {
      if (timer.due <= now && timers.delete(id)) timer.callback();
    }
  };
  const scrollUp = (amount: number) => {
    metrics.offset -= amount;
    controller.scrolled();
  };
  const reachBottom = () => {
    metrics.offset = metrics.content - metrics.viewport - 16;
    controller.scrolled();
  };
  return {
    controller, commands, states, metrics, frames, timers, flushFrame, advance, scrollUp, reachBottom,
    get following() { return following; },
    setActive: (value: boolean) => { active = value; },
    setReady: (value: boolean) => { ready = value; },
    setLastVisible: (value: boolean) => { lastVisible = value; },
  };
}

test("최신 이동 직후 10~30px 위로 드래그하면 예약된 자동 이동을 즉시 취소한다", () => {
  // 준비: 키보드·새 메시지 측정으로 다음 프레임의 하단 이동이 예약된 상태다.
  const f = fixture();
  f.controller.positionConfirmed(true);
  f.controller.contentOrViewportChanged();
  assert.equal(f.frames.size, 1);

  // 실행: 기존 80px 재활성화 범위 안에서 시작하고 위쪽으로 계속 움직인다.
  f.controller.beginDrag();
  f.scrollUp(10);
  f.flushFrame();
  f.scrollUp(20);
  f.controller.contentOrViewportChanged();
  f.flushFrame();
  f.advance(1000);

  // 검증: 손을 움직이는 중 하단 복귀 명령이 생기지 않는다.
  assert.equal(f.following, false);
  assert.deepEqual(f.commands, []);
  assert.deepEqual(f.states, [true, false]);
});

test("긴 마지막 말풍선이 계속 보여도 위로 스크롤하는 동안 하단으로 붙잡지 않는다", () => {
  // 준비: 마지막 행이 화면보다 훨씬 높아 스크롤 중에도 계속 viewable인 경우다.
  const f = fixture();
  f.controller.positionConfirmed(true);
  f.controller.beginDrag();

  // 실행: 마지막 행 내부 이동과 momentum·번역으로 인한 높이 변경이 겹친다.
  f.scrollUp(10);
  f.controller.endDrag();
  f.controller.beginMomentum();
  for (let i = 0; i < 20; i += 1) {
    f.scrollUp(30);
    f.metrics.content += 5;
    f.controller.contentOrViewportChanged();
    f.controller.scrolled();
    f.flushFrame();
  }
  f.controller.endMomentum();
  f.advance(120);
  f.controller.contentOrViewportChanged();
  f.flushFrame();

  // 검증: 행의 표시 여부만으로 읽던 위치를 취소하지 않는다.
  assert.equal(f.following, false);
  assert.deepEqual(f.commands, []);
});

test("하단 허용 오차 안에서도 드래그가 진행 중이면 자동 따라가기를 켜지 않는다", () => {
  // 준비·실행: 손이 아직 화면에 있고 작은 이동만 발생한 상황이다.
  const f = fixture();
  f.controller.positionConfirmed(true);
  f.controller.beginDrag();
  f.scrollUp(1);
  f.advance(5000);
  f.controller.contentOrViewportChanged();
  f.flushFrame();

  // 검증: 시간 경과나 하단 근접 여부로 활성 제스처를 끝내지 않는다.
  assert.equal(f.following, false);
  assert.deepEqual(f.commands, []);
});

test("손을 뗀 뒤 momentum 종료와 마지막 scroll까지 기다리고 실제 하단에서만 재개한다", () => {
  // 준비: 사용자가 지난 기록을 읽다가 하단으로 돌아온다.
  const f = fixture();
  f.controller.positionConfirmed(false);
  f.controller.beginDrag();
  f.scrollUp(500);
  f.controller.endDrag();
  f.controller.beginMomentum();

  // 실행: 관성 중 하단에 닿아도 즉시 제어권을 빼앗지 않는다.
  f.reachBottom();
  f.advance(1000);
  assert.equal(f.following, false);
  f.controller.endMomentum();
  f.advance(100);
  f.controller.scrolled();
  f.advance(100);
  assert.equal(f.following, false);
  f.advance(20);

  // 검증: 종료 이후 새 콘텐츠가 생길 때 한 번 따라가며, 종료 자체는 이동하지 않는다.
  assert.equal(f.following, true);
  assert.deepEqual(f.commands, []);
  f.metrics.content += 200;
  f.controller.contentOrViewportChanged();
  f.flushFrame();
  assert.equal(f.commands.length, 1);
});

test("반복 scroll 이벤트는 자동 scrollToEnd 명령을 다시 만들지 않는다", () => {
  // 준비·실행: 프로그램의 하단 이동이 scroll 이벤트를 다시 전달한다.
  const f = fixture();
  f.controller.positionConfirmed(true);
  f.controller.contentOrViewportChanged();
  f.flushFrame();
  for (let i = 0; i < 100; i += 1) {
    f.controller.scrolled();
    f.flushFrame();
  }

  // 검증: 한 번의 콘텐츠 변경에는 한 번의 명령만 존재한다.
  assert.equal(f.commands.length, 1);
  assert.equal(f.frames.size, 0);
});

test("최신 버튼의 표시로 뷰포트가 줄어도 위로 읽는 위치와 버튼 상태가 진동하지 않는다", () => {
  // 준비: 최신 버튼이 생기거나 사라질 때 목록 높이가 실제로 변하는 화면을 흉내 낸다.
  const f = fixture(true);
  f.controller.positionConfirmed(true);
  f.flushFrame();
  f.commands.length = 0;

  // 실행: 위로 드래그하면 버튼이 나타나며 추가 layout/scroll이 발생한다.
  f.controller.beginDrag();
  f.scrollUp(10);
  f.controller.endDrag();
  f.advance(120);
  for (let i = 0; i < 10; i += 1) {
    f.controller.scrolled();
    f.controller.contentOrViewportChanged();
    f.flushFrame();
  }

  // 검증: 버튼은 한 번 표시되고 이동 명령과 높이 변경이 서로 반복되지 않는다.
  assert.deepEqual(f.states, [true, false]);
  assert.equal(f.following, false);
  assert.deepEqual(f.commands, []);
});

test("사용자 제스처 없는 프로그램 momentum은 따라가기 상태를 끊거나 새 이동을 만들지 않는다", () => {
  // 준비·실행
  const f = fixture();
  f.controller.positionConfirmed(true);
  f.controller.beginMomentum();
  f.controller.scrolled();
  f.controller.endMomentum();
  f.advance(120);

  // 검증
  assert.equal(f.following, true);
  assert.deepEqual(f.commands, []);
  assert.equal(f.timers.size, 0);
});

test("휠 스크롤은 연속 이벤트가 끝난 뒤에도 과거 위치이면 자동 이동하지 않는다", () => {
  // 준비·실행: 웹 미리보기에서 pointer drag 없이 wheel만 사용한다.
  const f = fixture();
  f.controller.positionConfirmed(true);
  for (let i = 0; i < 5; i += 1) {
    f.controller.wheel();
    f.scrollUp(30);
    f.advance(100);
    assert.equal(f.following, false);
  }
  f.advance(20);
  f.controller.contentOrViewportChanged();
  f.flushFrame();

  // 검증
  assert.equal(f.following, false);
  assert.deepEqual(f.commands, []);
});

test("제스처 시작 전 큐에 있던 콜백이 늦게 실행되어도 아래로 이동하지 않는다", () => {
  // 준비: 이미 브리지로 넘겨진 콜백은 cancel만으로 완전히 회수되지 않을 수 있다.
  const f = fixture();
  f.controller.positionConfirmed(true);
  f.controller.contentOrViewportChanged();
  const staleFrame = [...f.frames.values()][0]!;

  // 실행·검증: 세대가 달라진 콜백은 제스처 종료 이후에도 무효다.
  f.controller.beginDrag();
  f.scrollUp(200);
  f.controller.endDrag();
  f.advance(120);
  staleFrame();
  assert.deepEqual(f.commands, []);
  assert.equal(f.following, false);
});

test("방 변경·읽기 미준비·백그라운드 상태에서는 예약 작업으로 이동하지 않는다", () => {
  // 준비·실행·검증: 각 경계에서 예약된 프레임의 실행 조건도 다시 검사한다.
  for (const boundary of ["reset", "not-ready", "inactive"] as const) {
    const f = fixture();
    f.controller.positionConfirmed(true);
    f.controller.contentOrViewportChanged();
    if (boundary === "reset") f.controller.reset();
    if (boundary === "not-ready") f.setReady(false);
    if (boundary === "inactive") f.setActive(false);
    f.flushFrame();
    assert.deepEqual(f.commands, [], boundary);
  }
});

test("미읽음 기준으로 들어온 방은 새 메시지와 레이아웃 변화에도 읽던 위치를 유지한다", () => {
  // 준비·실행
  const f = fixture();
  f.controller.positionConfirmed(false);
  f.metrics.content += 500;
  f.metrics.viewport -= 200;
  f.controller.contentOrViewportChanged();
  f.controller.scrolled();
  f.flushFrame();

  // 검증: 명시적인 최신 이동 또는 실제 하단 도달 전까지 따라가지 않는다.
  assert.equal(f.following, false);
  assert.deepEqual(f.commands, []);
});

test("하단 거리만 맞고 마지막 행이 실제 보이지 않으면 따라가기를 재개하지 않는다", () => {
  // 준비·실행: 가상화 측정 중 낡은 콘텐츠 높이로 하단처럼 계산되는 경우다.
  const f = fixture();
  f.controller.beginDrag();
  f.reachBottom();
  f.setLastVisible(false);
  f.controller.endDrag();
  f.advance(120);
  f.controller.contentOrViewportChanged();
  f.flushFrame();

  // 검증
  assert.equal(f.following, false);
  assert.deepEqual(f.commands, []);
});


test("450ms 표시 지연 전에 실제 하단에서 입력창을 누르면 최신 의도를 복구한다", () => {
  // 준비: 실제로 하단에 도착했지만 읽음용 마지막 행 콜백은 120ms 종료 판정보다 늦게 온다.
  const f = fixture();
  f.controller.positionConfirmed(false);
  f.controller.beginDrag();
  f.reachBottom();
  f.setLastVisible(false);
  f.controller.endDrag();
  f.advance(120);
  assert.equal(f.following, false);

  // 실행: 키보드가 열리기 전 물리적 하단을 캡처한 뒤 실제 목록 높이가 줄어든다.
  f.controller.prepareForViewportChange(true);
  f.metrics.viewport -= 300;
  f.controller.contentOrViewportChanged();
  f.flushFrame();
  f.setLastVisible(true);
  f.advance(450);

  // 검증: 가시성 지연이 최신 대화를 키보드 뒤에 남기지 않는다.
  assert.equal(f.following, true);
  assert.equal(f.metrics.content - f.metrics.viewport - f.metrics.offset, 16);
  assert.equal(f.commands.length, 1);
});

test("제스처 종료 직후 포커스가 와도 늦게 시작하는 관성 이동을 자동 하단 이동으로 방해하지 않는다", () => {
  // 준비: 손은 뗐지만 momentum 시작이 아직 도착하지 않은 settling 구간이다.
  const f = fixture();
  f.controller.positionConfirmed(true);
  f.controller.beginDrag();
  f.reachBottom();
  f.controller.endDrag();

  // 실행: 입력창 포커스 뒤 관성이 시작되어 과거 쪽으로 이동하며 키보드 높이도 바뀐다.
  f.controller.prepareForViewportChange(true);
  f.controller.beginMomentum();
  f.scrollUp(300);
  f.metrics.viewport -= 250;
  f.controller.contentOrViewportChanged();
  f.flushFrame();
  f.controller.endMomentum();
  f.advance(120);
  f.flushFrame();

  // 검증: 아직 끝나지 않은 제스처를 idle로 바꾸거나 자동 하단 이동을 예약하지 않는다.
  assert.equal(f.following, false);
  assert.deepEqual(f.commands, []);
  assert.equal(f.frames.size, 0);
  assert.equal(f.timers.size, 0);
});

test("과거 메시지 위치에서 입력창을 눌러도 키보드 열기와 닫기가 최신 이동을 만들지 않는다", () => {
  // 준비: 최신에서 위로 이동해 과거 메시지를 읽는 중이다.
  const f = fixture();
  f.controller.positionConfirmed(true);
  f.controller.beginDrag();
  f.scrollUp(700);
  f.controller.endDrag();
  f.advance(120);
  const readingOffset = f.metrics.offset;

  // 실행: 입력 포커스와 키보드 show/hide에 해당하는 레이아웃 변화가 반복된다.
  f.controller.prepareForViewportChange(false);
  for (const viewport of [350, 320, 600]) {
    f.metrics.viewport = viewport;
    f.controller.contentOrViewportChanged();
    f.flushFrame();
    f.advance(150);
  }

  // 검증: 읽던 위치를 유지하고 지속 추적 타이머도 만들지 않는다.
  assert.equal(f.following, false);
  assert.equal(f.metrics.offset, readingOffset);
  assert.deepEqual(f.commands, []);
  assert.equal(f.timers.size, 0);
});

test("드래그나 관성 도중에는 물리적 하단이어도 입력 포커스로 추적을 재활성화하지 않는다", () => {
  // 준비·실행: 손이 움직이는 상태와 관성이 진행 중인 상태를 각각 확인한다.
  for (const gesture of ["drag", "momentum"] as const) {
    const f = fixture();
    f.controller.positionConfirmed(true);
    f.controller.beginDrag();
    if (gesture === "momentum") {
      f.controller.endDrag();
      f.controller.beginMomentum();
    }
    f.controller.prepareForViewportChange(true);
    f.metrics.viewport -= 300;
    f.controller.contentOrViewportChanged();
    f.flushFrame();
    f.advance(1000);

    // 검증: 키보드 변화가 사용자의 스크롤 제어권을 빼앗지 않는다.
    assert.equal(f.following, false, gesture);
    assert.deepEqual(f.commands, [], gesture);
  }
});

test("최신 유지 의도는 첫 키보드 resize 뒤 이미 벌어진 간격만으로 해제되지 않는다", () => {
  // 준비: 하단을 보고 있을 때 첫 native resize가 focus 처리보다 먼저 관측된 상황이다.
  const f = fixture();
  f.controller.positionConfirmed(true);
  f.metrics.viewport -= 300;

  // 실행: 현재 물리적 간격은 커졌지만 이미 확인된 최신 유지 의도는 존재한다.
  f.controller.prepareForViewportChange(false);
  f.controller.contentOrViewportChanged();
  f.flushFrame();
  f.advance(120);

  // 검증: 변경 후 간격을 과거 열람 의도로 오해하지 않는다.
  assert.equal(f.following, true);
  assert.equal(f.metrics.content - f.metrics.viewport - f.metrics.offset, 16);
});

test("읽기 준비 전이나 비활성 화면에서는 입력 포커스가 최신 추적을 새로 켜지 않는다", () => {
  // 준비·실행·검증: 포커스가 늦게 전달돼도 화면 경계를 다시 검사한다.
  for (const boundary of ["inactive", "not-ready"] as const) {
    const f = fixture();
    if (boundary === "inactive") f.setActive(false);
    if (boundary === "not-ready") f.setReady(false);
    f.controller.prepareForViewportChange(true);
    f.controller.contentOrViewportChanged();
    f.flushFrame();
    f.advance(1000);
    assert.equal(f.following, false, boundary);
    assert.deepEqual(f.commands, [], boundary);
  }
});

test("native가 늦게 예전 offset을 복원하면 한 번만 마무리 보정하고 scroll로 반복하지 않는다", () => {
  // 준비: 첫 프레임은 새 목록 높이에 맞춰 정상적으로 하단에 도착한다.
  const f = fixture();
  f.controller.positionConfirmed(true);
  f.controller.prepareForViewportChange(true);
  f.metrics.viewport -= 300;
  f.controller.contentOrViewportChanged();
  f.flushFrame();
  assert.equal(f.commands.length, 1);

  // 실행: 늦은 native 배치가 예전 스크롤 위치를 복원하며 scroll을 전달한다.
  f.metrics.offset -= 300;
  f.controller.scrolled();
  f.advance(119);
  assert.equal(f.commands.length, 1);
  f.advance(1);
  assert.equal(f.commands.length, 2);
  f.metrics.offset -= 200;
  for (let i = 0; i < 20; i += 1) {
    f.controller.scrolled();
    f.flushFrame();
    f.advance(120);
  }

  // 검증: 배치 완료 보정은 한 번이며 계속되는 scroll을 강제 하단 추적으로 바꾸지 않는다.
  assert.equal(f.commands.length, 2);
  assert.equal(f.timers.size, 0);
  assert.equal(f.frames.size, 0);
});

test("키보드와 safe-area의 연속 resize는 마지막 변화가 끝난 후에만 마무리 보정한다", () => {
  // 준비: IME와 안전 영역 변경이 서로 다른 프레임에 목록 크기를 바꾼다.
  const f = fixture();
  f.controller.positionConfirmed(true);
  f.metrics.viewport = 400;
  f.controller.contentOrViewportChanged();
  f.flushFrame();
  f.advance(80);
  f.metrics.viewport = 350;
  f.controller.contentOrViewportChanged();
  f.flushFrame();
  f.metrics.offset -= 100;

  // 실행: 첫 변화의 타이머 시각에는 보정하지 않고 마지막 변화의 종료를 기다린다.
  const initialCommands = f.commands.length;
  f.advance(40);
  assert.equal(f.commands.length, initialCommands);
  f.advance(80);

  // 검증: 마지막으로 측정한 높이를 기준으로 한 번만 마무리한다.
  assert.equal(f.commands.length, initialCommands + 1);
  assert.equal(f.commands.at(-1), 5650);
  assert.equal(f.timers.size, 0);
});

test("키보드 마무리 보정 전에 수동 이동이나 화면 이탈이 오면 예약과 큐의 콜백을 취소한다", () => {
  // 준비·실행·검증: 취소된 타이머가 이미 실행 큐에 있었던 경우도 함께 확인한다.
  for (const boundary of ["drag", "wheel", "reset", "inactive"] as const) {
    const f = fixture();
    f.controller.positionConfirmed(true);
    f.controller.contentOrViewportChanged();
    f.flushFrame();
    const staleCallbacks = [...f.timers.values()].map((timer) => timer.callback);
    f.metrics.offset -= 300;
    if (boundary === "drag") f.controller.beginDrag();
    if (boundary === "wheel") f.controller.wheel();
    if (boundary === "reset") f.controller.reset();
    if (boundary === "inactive") {
      f.setActive(false);
      f.controller.cancelScheduled();
    }
    for (const callback of staleCallbacks) callback();
    f.advance(1000);
    f.flushFrame();
    assert.equal(f.commands.length, 1, boundary);
    assert.equal(f.frames.size, 0, boundary);
    assert.equal(f.timers.size, 0, boundary);
  }
});

test("최신을 보는 동안 키보드를 열고 닫으면 각 최종 viewport의 하단을 유지한다", () => {
  // 준비: 최신 위치를 확인한 상태에서 입력을 시작한다.
  const f = fixture();
  f.controller.positionConfirmed(true);
  f.controller.prepareForViewportChange(true);

  // 실행·검증: 열기·높이 변경·닫기가 모두 최신 메시지의 끝을 유지한다.
  for (const viewport of [330, 290, 600]) {
    f.metrics.viewport = viewport;
    f.controller.contentOrViewportChanged();
    f.flushFrame();
    f.advance(120);
    assert.equal(f.metrics.content - f.metrics.viewport - f.metrics.offset, 16);
    assert.equal(f.following, true);
  }
  assert.equal(f.commands.length, 3);
  assert.equal(f.timers.size, 0);
});
