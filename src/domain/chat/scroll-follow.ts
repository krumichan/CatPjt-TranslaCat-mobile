interface FollowScheduler {
  requestFrame: (callback: () => void) => number;
  cancelFrame: (handle: number) => void;
  setTimer: (callback: () => void, delay: number) => unknown;
  clearTimer: (handle: unknown) => void;
}

interface FollowOptions {
  scheduler: FollowScheduler;
  canFollow: () => boolean;
  isAtBottom: () => boolean;
  scrollToEnd: () => void;
  onFollowingChange: (following: boolean) => void;
}

type Gesture = "idle" | "drag" | "momentum" | "settling";

// 손을 뗀 뒤 오는 마지막 scroll/momentum 이벤트까지 기다린다.
const GESTURE_SETTLE_MS = 120;
const LAYOUT_SETTLE_MS = 120;

export class ChatScrollFollow {
  private options: FollowOptions;
  private following = false;
  private gesture: Gesture = "idle";
  private frame: number | null = null;
  private settleTimer: unknown = null;
  private layoutTimer: unknown = null;
  private generation = 0;

  constructor(options: FollowOptions) {
    this.options = options;
  }

  private setFollowing(value: boolean) {
    if (this.following === value) return;
    this.following = value;
    this.options.onFollowingChange(value);
  }

  cancelScheduled() {
    // 이미 큐에 들어간 콜백도 세대 번호로 무효화한다.
    this.generation += 1;
    if (this.frame !== null) this.options.scheduler.cancelFrame(this.frame);
    if (this.settleTimer !== null) this.options.scheduler.clearTimer(this.settleTimer);
    if (this.layoutTimer !== null) this.options.scheduler.clearTimer(this.layoutTimer);
    this.frame = null;
    this.settleTimer = null;
    this.layoutTimer = null;
  }

  reset() {
    this.cancelScheduled();
    this.gesture = "idle";
    this.setFollowing(false);
  }

  positionConfirmed(latest: boolean) {
    this.cancelScheduled();
    this.gesture = "idle";
    this.setFollowing(latest);
  }

  prepareForViewportChange(atMeasuredBottom: boolean) {
    // 읽음용 가시성 콜백은 늦을 수 있다. 키보드가 열리기 전의 실제 하단 의도를 보존한다.
    if (!this.options.canFollow() || this.gesture !== "idle") return;
    if (!this.following && !atMeasuredBottom) return;
    this.cancelScheduled();
    this.gesture = "idle";
    this.setFollowing(true);
    this.contentOrViewportChanged();
  }

  private canReconcile() {
    return this.following && this.gesture === "idle" && this.options.canFollow();
  }

  contentOrViewportChanged() {
    if (!this.canReconcile()) return;
    const generation = this.generation;

    // 중간 배치에는 프레임당 한 번, 마지막 키보드·목록 배치 뒤에는 한 번만 정합한다.
    if (this.frame === null) this.frame = this.options.scheduler.requestFrame(() => {
      if (generation !== this.generation) return;
      this.frame = null;
      if (this.canReconcile()) this.options.scrollToEnd();
    });
    if (this.layoutTimer !== null) this.options.scheduler.clearTimer(this.layoutTimer);
    this.layoutTimer = this.options.scheduler.setTimer(() => {
      if (generation !== this.generation) return;
      this.layoutTimer = null;
      if (this.canReconcile() && !this.options.isAtBottom()) this.options.scrollToEnd();
    }, LAYOUT_SETTLE_MS);
  }

  beginDrag() {
    // 1px의 첫 이동부터 자동 이동을 취소한다. 하단 근처여도 드래그 중에는 재활성화하지 않는다.
    this.cancelScheduled();
    this.gesture = "drag";
    this.setFollowing(false);
  }

  private settleAfterGesture() {
    if (this.settleTimer !== null) this.options.scheduler.clearTimer(this.settleTimer);
    const generation = this.generation;
    this.settleTimer = this.options.scheduler.setTimer(() => {
      if (generation !== this.generation) return;
      this.settleTimer = null;
      if (this.gesture !== "settling") return;
      this.gesture = "idle";
      // 실제 제스처가 끝난 시점의 하단 도달만 인정하며, 이 콜백 자체는 이동 명령을 보내지 않는다.
      this.setFollowing(this.options.canFollow() && this.options.isAtBottom());
    }, GESTURE_SETTLE_MS);
  }

  endDrag() {
    if (this.gesture !== "drag") return;
    this.gesture = "settling";
    this.settleAfterGesture();
  }

  beginMomentum() {
    // 프로그램에 의한 스크롤의 momentum 이벤트는 사용자의 드래그로 취급하지 않는다.
    if (this.gesture === "idle") return;
    if (this.settleTimer !== null) this.options.scheduler.clearTimer(this.settleTimer);
    this.settleTimer = null;
    this.gesture = "momentum";
  }

  endMomentum() {
    if (this.gesture !== "momentum") return;
    this.gesture = "settling";
    this.settleAfterGesture();
  }

  wheel() {
    this.cancelScheduled();
    this.gesture = "settling";
    this.setFollowing(false);
    this.settleAfterGesture();
  }

  scrolled() {
    // scroll 이벤트는 위치 관측뿐이다. onScroll → scrollToEnd 순환을 만들지 않는다.
    if (this.gesture === "settling") this.settleAfterGesture();
  }
}
