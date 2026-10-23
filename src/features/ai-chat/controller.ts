import { ApiError } from "../../api/client.ts";
import type { ChatRoom } from "../../domain/chat/types.ts";
import type { RoomConnection } from "../chat/controller.ts";
import { AiInputError, type AiMember, type AiProfileInput, type AiSettings, type AiSettingsPatch } from "./contracts.ts";
import type { AiService } from "./service.ts";

export interface AiRoomState {
  room: ChatRoom | null;
  settings: AiSettings | null;
  members: AiMember[];
  loading: boolean;
  busy: boolean;
  managementAvailable: boolean;
  uncertain: boolean;
  accessLost: boolean;
  revision: number;
  error: string | null;
  notice: string | null;
}

export interface AiRoomOptions {
  connect?: (handlers: RoomConnection) => () => void;
  schedule?: (callback: () => void, delayMs: number) => () => void;
  pollIntervalMs?: number;
  requestTimeoutMs?: number;
}

// 화면을 닫고 다시 열어도 불확실한 생성 요청을 자동으로 다시 보내지 않는다. 프로필/토큰은 저장하지 않는다.
const uncertainScopes = new Set<string>();
const scheduleTimer = (callback: () => void, delay: number) => {
  const timer = setTimeout(callback, delay);
  return () => clearTimeout(timer);
};

export function manager(room: ChatRoom | null): boolean {
  return !!room?.active && !room.closed && (room.roomType === "GROUP" || room.roomType === "OPEN")
    && (room.myRole === "OWNER" || room.myRole === "ADMIN");
}

export function emptyAiRoom(): AiRoomState {
  return { room: null, settings: null, members: [], loading: true, busy: false,
    managementAvailable: false, uncertain: false, accessLost: false, revision: 0, error: null, notice: null };
}

export function aiErrorMessage(error: unknown): string {
  if (error instanceof AiInputError) return "닉네임 1~50자, 소개 200자 이하, 언어 코드 1~10자, AI 성격 1~4000자를 확인해 주세요.";
  if (error instanceof ApiError && error.status === 401) return "로그인 상태를 확인해 주세요.";
  if (error instanceof ApiError && [400, 403, 404].includes(error.status)) return "AI 설정에 접근할 수 없어요. 방 참여 상태와 관리 권한을 확인해 주세요.";
  return "AI 설정을 불러오지 못했어요. 연결 상태를 확인한 뒤 다시 불러와 주세요.";
}

export function createAiRoomController(service: AiService, roomId: string, scopeKey: string, isCurrent: () => boolean,
  publish: (state: AiRoomState) => void, options: AiRoomOptions = {}) {
  const abort = new AbortController();
  const schedule = options.schedule ?? scheduleTimer;
  let disposed = false;
  let terminal = false;
  let reading = false;
  let pendingRefresh = false;
  let pendingCreate = false;
  let revision = 0;
  let failures = 0;
  let readPromise: Promise<boolean> | null = null;
  let stopSocket: (() => void) | null = null;
  let socketGeneration = 0;
  let timer: { cancel: () => void; kind: "refresh" | "poll" } | null = null;
  const requests = new Set<() => void>();
  let state = { ...emptyAiRoom(), uncertain: uncertainScopes.has(scopeKey) };
  const current = () => !disposed && isCurrent();
  const live = () => current() && !terminal;
  const update = (patch: Partial<AiRoomState>) => {
    if (!current()) return;
    state = { ...state, ...patch };
    publish(state);
  };
  const cancelTimer = () => { timer?.cancel(); timer = null; };
  const disconnect = () => { socketGeneration++; stopSocket?.(); stopSocket = null; };
  const invalidate = () => {
    revision++;
    update({ revision, room: null, settings: null, members: [], managementAvailable: false, notice: null });
  };
  const finishRoom = (room: ChatRoom | null) => {
    // 방 종료와 참여 상실은 다른 안내를 유지하고 재연결·안전망 조회를 모두 중단한다.
    terminal = true;
    pendingRefresh = false;
    cancelTimer();
    disconnect();
    update({ room, settings: null, members: [], managementAvailable: false, loading: false,
      accessLost: room === null, error: null,
      notice: room?.closed ? "종료된 오픈채팅이에요. AI 설정을 변경할 수 없어요."
        : "이 방에 더 이상 참여하고 있지 않아요. 대화방 목록에서 참여 상태를 확인해 주세요." });
  };
  const roomDenied = (error: unknown) => error instanceof ApiError && [400, 403, 404].includes(error.status);
  const sameRevision = (expected: number) => live() && revision === expected;
  const request = <T,>(work: (signal: AbortSignal) => Promise<T>): Promise<T> => new Promise((resolve, reject) => {
    // 응답이 영원히 오지 않거나 fetch가 취소를 무시해도 작업 세대가 대기 상태에 갇히지 않게 한다.
    const cancellation = new AbortController();
    let finished = false;
    let cancelDeadline = () => {};
    const finish = (success: boolean, result: T | unknown) => {
      if (finished) return;
      finished = true;
      cancelDeadline();
      abort.signal.removeEventListener("abort", stop);
      requests.delete(stop);
      if (success) resolve(result as T);
      else reject(result);
    };
    const stop = () => { cancellation.abort(); finish(false, new ApiError(0, "REQUEST_ABORTED")); };
    requests.add(stop);
    abort.signal.addEventListener("abort", stop, { once: true });
    cancelDeadline = schedule(() => {
      cancellation.abort();
      finish(false, new ApiError(0, "REQUEST_TIMEOUT"));
    }, options.requestTimeoutMs ?? 15000);
    if (!live()) { stop(); return; }
    try { void work(cancellation.signal).then(value => finish(true, value), error => finish(false, error)); }
    catch (error) { finish(false, error); }
  });

  const wake = (delay: number, kind: "refresh" | "poll") => {
    if (!live() || reading || state.busy) return;
    if (timer && (timer.kind === "refresh" || kind === "poll")) return;
    cancelTimer();
    const owned = { cancel: () => {}, kind };
    timer = owned;
    owned.cancel = schedule(() => {
      if (timer !== owned) return;
      timer = null;
      if (!live()) return;
      pendingRefresh = true;
      void drain();
    }, delay);
  };
  const requestRefresh = () => {
    if (!live()) return;
    // 이벤트는 권한 데이터가 아니다. 기존 persona와 동의를 즉시 폐기한 뒤 HTTP로 다시 판정한다.
    invalidate();
    pendingRefresh = true;
    wake(75, "refresh");
  };
  const connect = (room: ChatRoom) => {
    if (!options.connect || stopSocket || !live()) return;
    const owned = ++socketGeneration;
    const connected = () => live() && owned === socketGeneration;
    stopSocket = () => {};
    try {
      const stop = options.connect({
        open: room.roomType === "OPEN",
        onEvent: event => { if (connected() && event.roomId === roomId && event.kind === "refresh") requestRefresh(); },
        onConnect: () => { if (connected()) requestRefresh(); },
        onStatus: status => {
          if (connected() && ["DISCONNECTED", "ERROR", "RETRYING"].includes(status)) requestRefresh();
        },
        onInvalidEvent: () => { if (connected()) requestRefresh(); },
      });
      if (!connected()) stop();
      else stopSocket = stop;
    } catch {
      // 소켓 연결 실패 중에도 HTTP 안전망은 현재 권한을 계속 확인한다.
      stopSocket = null;
    }
  };

  const readSnapshot = async () => {
    let expected = revision;
    const previous = state.room;
    let roomRequest = true;
    reading = true;
    update({ loading: true, error: null });
    try {
      // 권한·종료 상태를 먼저 확인한다. 관리자에게만 persona가 있는 관리 목록을 요청한다.
      const room = await request(signal => service.room(roomId, signal));
      if (!sameRevision(expected)) return false;
      roomRequest = false;
      // 정상 안전망 조회는 편집을 보존한다. 누락된 역할·종료 변경을 발견했을 때만 동의를 폐기한다.
      if (previous && (previous.myRole !== room.myRole || previous.roomType !== room.roomType
        || previous.active !== room.active || !!previous.closed !== !!room.closed)) {
        invalidate();
        expected = revision;
      }
      if (room.closed || !room.active) { invalidate(); finishRoom(room.closed ? room : null); return false; }
      if (room.roomType === "DIRECT") {
        update({ room, error: "AI는 활성 그룹 채팅과 오픈채팅에서 설정할 수 있어요." });
        return false;
      }
      connect(room);
      if (!sameRevision(expected)) return false;
      const settings = await request(signal => service.settings(roomId, signal));
      if (!sameRevision(expected)) return false;
      const members = manager(room) ? (await request(signal => service.members(roomId, signal))).members : [];
      if (!sameRevision(expected)) return false;
      failures = 0;
      update({ room, settings, members, managementAvailable: manager(room), accessLost: false });
      return true;
    } catch (error) {
      if (!sameRevision(expected)) return false;
      failures++;
      // CHAT의 방 GET은 강퇴/비참여에 400을 사용한다. 설정·목록·변경의 400에는 이 판정을 적용하지 않는다.
      invalidate();
      if (roomRequest && roomDenied(error)) finishRoom(null);
      else update({ error: aiErrorMessage(error) });
      return false;
    } finally {
      reading = false;
      update({ loading: live() && pendingRefresh });
    }
  };
  const drain = (): Promise<boolean> => {
    if (!live() || state.busy) return Promise.resolve(false);
    if (readPromise) return readPromise;
    cancelTimer();
    readPromise = (async () => {
      let loaded = false;
      // 읽는 동안 신호가 더 오면 이전 응답을 버리고 마지막 세대의 GET만 한 번 더 수행한다.
      while (live() && pendingRefresh && !state.busy) {
        pendingRefresh = false;
        loaded = await readSnapshot();
      }
      return loaded;
    })().finally(() => {
      readPromise = null;
      if (live()) wake(failures ? Math.min(1000 * 2 ** Math.min(failures - 1, 5), 30000)
        : Math.max(1000, options.pollIntervalMs ?? 30000), "poll");
    });
    return readPromise;
  };
  const load = () => {
    if (!live()) return Promise.resolve(false);
    requestRefresh();
    return drain();
  };

  const mutate = async (work: (signal: AbortSignal) => Promise<unknown>, create = false) => {
    if (!live() || reading || state.busy || state.uncertain || !state.managementAvailable || !manager(state.room)) return false;
    const expected = revision;
    const previous = state.room;
    let preflight = true;
    let sent = false;
    let saved = false;
    let savedRevision = -1;
    let failureMessage: string | null = null;
    cancelTimer();
    update({ busy: true, error: null, notice: null });
    try {
      // 변경마다 최신 HTTP 권한을 확인하고, 그 사이 이벤트가 오면 이전 동의로 쓰지 않는다.
      const room = await request(signal => service.room(roomId, signal));
      if (!sameRevision(expected)) return false;
      preflight = false;
      if (room.closed || !room.active) {
        invalidate();
        finishRoom(room.closed ? room : null);
        return false;
      }
      if (!manager(room) || previous?.myRole !== room.myRole || previous?.roomType !== room.roomType) {
        requestRefresh();
        return false;
      }
      if (!sameRevision(expected)) return false;
      sent = true;
      pendingCreate = create;
      await request(work);
      if (!sameRevision(expected)) return false;
      saved = true;
      requestRefresh();
      savedRevision = revision;
    } catch (error) {
      const rejected = error instanceof AiInputError || (error instanceof ApiError
        && error.status >= 400 && error.status < 500 && error.status !== 408);
      if (sent && !rejected) uncertainScopes.add(scopeKey);
      if (!current()) return false;
      if (preflight && sameRevision(expected)) {
        invalidate();
        if (roomDenied(error)) finishRoom(null);
        else { failures++; update({ error: aiErrorMessage(error) }); }
      }
      else if (revision === expected) {
        if (sent && !rejected) update({ uncertain: true,
          notice: "저장 결과를 확인하지 못했어요. 이미 반영됐을 수 있으니 목록을 다시 확인해 주세요. 자동으로 다시 요청하지 않아요." });
        if (error instanceof ApiError && [400, 403, 404].includes(error.status)) {
          // 변경 거절의 400은 강퇴로 단정하지 않고 현재 방 GET으로 권한을 다시 확인한다.
          requestRefresh();
          failureMessage = aiErrorMessage(error);
        } else if (error instanceof ApiError && error.status === 401) { invalidate(); failures++; }
        update({ error: aiErrorMessage(error) });
      } else if (sent && !rejected) update({ uncertain: true });
    } finally {
      pendingCreate = false;
      update({ busy: false });
      // 진행 중이던 POST를 재전송하지 않고, 대기 중인 권한 신호의 최신 GET이 끝날 때까지 기다린다.
      if (live() && pendingRefresh) await drain();
      else if (live()) wake(failures ? Math.min(1000 * 2 ** Math.min(failures - 1, 5), 30000)
        : Math.max(1000, options.pollIntervalMs ?? 30000), "poll");
    }
    if (failureMessage) update({ error: failureMessage });
    const accepted = saved && live() && revision === savedRevision && state.managementAvailable;
    if (accepted) update({ notice: "AI 설정을 저장했어요." });
    return accepted;
  };

  return {
    getState: () => state,
    load,
    create: (input: AiProfileInput) => mutate(signal => service.create(roomId, input, signal), true),
    update: (id: string, input: AiProfileInput) => mutate(signal => service.update(roomId, id, input, signal)),
    remove: (id: string) => mutate(signal => service.remove(roomId, id, signal)),
    settings: (patch: AiSettingsPatch) => mutate(signal => service.updateSettings(roomId, patch, signal)),
    acknowledge: () => {
      // 새로 조회한 목록을 사용자가 확인한 뒤 새 편집을 시작하도록 한다.
      if (!live() || state.loading || state.busy || !state.settings || state.error) return false;
      uncertainScopes.delete(scopeKey);
      update({ uncertain: false, notice: null });
      return true;
    },
    dispose: () => {
      if (pendingCreate) uncertainScopes.add(scopeKey);
      disposed = true;
      cancelTimer();
      disconnect();
      abort.abort();
    },
  };
}

