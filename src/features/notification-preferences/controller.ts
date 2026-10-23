export interface NotificationPreferenceState {
  value: boolean | null;
  loading: boolean;
  saving: boolean;
  uncertain: boolean;
  error: string | null;
  notice: string | null;
}

export const emptyNotificationPreference = (): NotificationPreferenceState => ({
  value: null, loading: true, saving: false, uncertain: false, error: null, notice: null,
});

export function createNotificationPreferenceController({ read, write, isCurrent, onConfirmed = () => {}, onChange, timeoutMs = 15000 }: {
  read: (signal: AbortSignal) => Promise<boolean>;
  write: (value: boolean, signal: AbortSignal) => Promise<boolean>;
  isCurrent: () => boolean;
  onConfirmed?: (value: boolean) => void;
  onChange: (state: NotificationPreferenceState) => void;
  timeoutMs?: number;
}) {
  let state = emptyNotificationPreference();
  let disposed = false;
  let revision = 0;
  let running: { abort: AbortController; timer: ReturnType<typeof setTimeout>; cancel: () => void } | null = null;
  const current = (owned: number) => !disposed && owned === revision && isCurrent();
  const update = (next: NotificationPreferenceState) => { state = next; if (!disposed && isCurrent()) onChange(state); };
  const cancel = () => {
    const pending = running;
    running = null;
    if (pending) { clearTimeout(pending.timer); pending.abort.abort(); pending.cancel(); }
  };
  const execute = async (work: (signal: AbortSignal) => Promise<boolean>, owned: number) => {
    const abort = new AbortController();
    let rejectTimeout!: (reason: unknown) => void;
    const deadline = new Promise<never>((_, reject) => { rejectTimeout = reject; });
    const timer = setTimeout(() => { abort.abort(); rejectTimeout(new Error("PREFERENCE_DEADLINE")); }, timeoutMs);
    const pending = { abort, timer, cancel: () => rejectTimeout(new Error("PREFERENCE_CANCELLED")) };
    running = pending;
    try {
      // Abort를 무시하는 늦은 응답도 deadline과 현재 화면 세대를 통과해야 적용한다.
      const value = await Promise.race([Promise.resolve().then(() => {
        if (!current(owned)) throw new Error("PREFERENCE_CANCELLED");
        return work(abort.signal);
      }), deadline]);
      if (typeof value !== "boolean") throw new Error("INVALID_PREFERENCE");
      return value;
    } finally {
      clearTimeout(timer);
      if (running === pending) running = null;
    }
  };

  return {
    getState: () => state,
    async load() {
      if (disposed || !isCurrent() || state.saving) return;
      const owned = ++revision;
      cancel();
      update({ ...state, loading: true, error: null, notice: null });
      try {
        const value = await execute(read, owned);
        if (!current(owned)) return;
        update({ value, loading: false, saving: false, uncertain: false, error: null, notice: null });
        if (current(owned)) onConfirmed(value);
      } catch {
        if (!current(owned)) return;
        update({ ...state, loading: false, error: "알림 설정을 확인하지 못했어요. 연결을 확인하고 다시 불러와 주세요." });
      }
    },
    async setValue(value: boolean) {
      // 조회 중이거나 결과가 불확실한 변경에는 새 PUT을 겹치지 않는다.
      if (disposed || !isCurrent() || state.loading || state.saving || state.uncertain
        || state.value === null || typeof value !== "boolean" || state.value === value) return;
      const previous = state.value;
      const owned = ++revision;
      cancel();
      update({ value, loading: false, saving: true, uncertain: false, error: null, notice: null });
      try {
        const confirmed = await execute(signal => write(value, signal), owned);
        if (confirmed !== value) throw new Error("INVALID_PREFERENCE");
        if (!current(owned)) return;
        update({ value: confirmed, loading: false, saving: false, uncertain: false, error: null, notice: "알림 설정을 저장했어요." });
        if (current(owned)) onConfirmed(confirmed);
      } catch {
        if (!current(owned)) return;
        // 화면은 마지막 확인 값으로 되돌리고, 서버 반영 여부는 GET으로 확인한다.
        update({ value: previous, loading: false, saving: false, uncertain: true,
          error: "저장 결과를 확인하지 못했어요. 설정을 다시 불러와 실제 값을 확인해 주세요.", notice: null });
      }
    },
    dispose() { disposed = true; revision++; cancel(); },
  };
}
