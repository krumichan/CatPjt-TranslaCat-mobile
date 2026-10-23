import { ApiError } from "../../api/client.ts";
import { ChatContractError } from "../../domain/chat/contracts.ts";
import { refreshMessageWindow, restoreUnreadHistory } from "../../domain/chat/entry.ts";
import { catchUpMessages, compareIds, latestMessageId, mergeMessages, mergeTranslations, recoverEmptyRoomHistory } from "../../domain/chat/timeline.ts";
import type { ChatLanguageSettings, ChatMessage, ChatRoom, ChatTranslation, OpenProfile } from "../../domain/chat/types.ts";
import type { RoomEvent } from "../../realtime/events.ts";
import { chatErrorMessage, type ChatService } from "./service.ts";

export interface RoomState {
  key: string;
  room: ChatRoom | null;
  profile: OpenProfile | null;
  language: ChatLanguageSettings | null;
  messages: ChatMessage[];
  cursor: string | null;
  hasMore: boolean;
  loading: boolean;
  syncing: boolean;
  loadingMore: boolean;
  sending: boolean;
  uncertain: boolean;
  connection: string;
  authorityReady: boolean;
  error: string | null;
  notice: string | null;
  entryTarget: { messageId: string | null; unread: boolean } | null;
}

export interface RoomConnection {
  open: boolean;
  onStatus: (status: string) => void;
  onInvalidEvent: (error: unknown) => void;
  onConnect: () => void;
  onEvent: (event: RoomEvent) => void;
}

type RoomService = Pick<ChatService, "room" | "myOpenProfile" | "firstUnread" | "messages" | "after" | "language" | "read" | "send">;
type Schedule = (callback: () => void, delayMs: number) => () => void;
interface Cycle {
  abort: AbortController;
  timers: Map<string, () => void>;
  stopSocket: (() => void) | null;
  syncing: boolean;
  syncAgain: boolean;
  reading: boolean;
  terminal: boolean;
  syncFailures: number;
  readFailures: number;
}

const scheduleTimer: Schedule = (callback, delay) => {
  const timer = setTimeout(callback, delay);
  return () => clearTimeout(timer);
};
const statusOf = (error: unknown) => error && typeof error === "object" && "status" in error ? Number(error.status) : null;
const denied = (error: unknown) => [400, 401, 403, 404].includes(statusOf(error) ?? -1);
const retryable = (error: unknown) => !(error instanceof ChatContractError)
  && (statusOf(error) === null || statusOf(error) === 0 || statusOf(error) === 408 || statusOf(error) === 429 || (statusOf(error) ?? 0) >= 500);
const backoff = (failures: number) => Math.min(1000 * 2 ** Math.min(failures, 5), 30000);
class InactiveRequest extends Error {}

export function createRoomChatController({ key, roomId, service, isCurrent, isActive, connect, schedule = scheduleTimer }: {
  key: string;
  roomId: string;
  service: RoomService;
  isCurrent: () => boolean;
  isActive: () => boolean;
  connect: (handlers: RoomConnection) => () => void;
  schedule?: Schedule;
}) {
  let state: RoomState = {
    key, room: null, profile: null, language: null, messages: [], cursor: null, hasMore: false,
    loading: true, syncing: false, loadingMore: false, sending: false, uncertain: false,
    connection: "DISCONNECTED", authorityReady: false, error: null, notice: null, entryTarget: null,
  };
  const listeners = new Set<() => void>();
  let cycle: Cycle | null = null;
  let cursor: string | null = null;
  let emptyBaseline = false;
  let readCursor: string | null = null;
  let readingReady = false;
  let visibleIds: string[] = [];
  let historyEpoch = 0;
  let revision = 0;
  const freshIds = new Set<string>();
  const translations = new Map<string, ChatTranslation[]>();
  const live = (c: Cycle) => cycle === c && !c.terminal && !c.abort.signal.aborted && isCurrent() && isActive();
  const publish = (patch: Partial<RoomState>) => {
    state = { ...state, ...patch };
    listeners.forEach(listener => listener());
  };
  const update = (c: Cycle, patch: Partial<RoomState>) => { if (live(c)) publish(patch); };
  const cancel = (c: Cycle, name: string) => { c.timers.get(name)?.(); c.timers.delete(name); };
  const later = (c: Cycle, name: string, delay: number, work: () => void) => {
    if (!live(c) || c.timers.has(name)) return;
    c.timers.set(name, schedule(() => { c.timers.delete(name); if (live(c)) work(); }, delay));
  };
  const checked = async <T,>(c: Cycle, promise: Promise<T>): Promise<T> => {
    const result = await promise;
    if (!live(c)) throw new InactiveRequest();
    return result;
  };
  const request = async <T,>(c: Cycle, work: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    if (!live(c)) throw new InactiveRequest();
    const cancellation = new AbortController();
    let cancelTimeout = () => {};
    let onAbort = () => {};
    // 토큰 대기·fetch·응답 읽기 전체를 제한한다. 종료된 요청의 늦은 응답은 사용하지 않는다.
    const deadline = new Promise<never>((_, reject) => {
      onAbort = () => { reject(new InactiveRequest()); cancellation.abort(); };
      c.abort.signal.addEventListener("abort", onAbort, { once: true });
      cancelTimeout = schedule(() => { reject(new ApiError(0, "REQUEST_TIMEOUT")); cancellation.abort(); }, 15000);
    });
    try { return await checked(c, Promise.race([Promise.resolve().then(() => work(cancellation.signal)), deadline])); }
    finally { cancelTimeout(); c.abort.signal.removeEventListener("abort", onAbort); }
  };
  const merge = (incoming: ChatMessage[], authoritative = false) => mergeMessages(state.messages, incoming.map(message => ({
    ...message, translations: message.contentVisibility !== undefined && message.contentVisibility !== "VISIBLE"
      ? [] : mergeTranslations(message.translations, translations.get(message.id) ?? []),
  })), { authoritativeUnreadCounts: authoritative });
  const applySnapshot = (c: Cycle, messages: ChatMessage[], capturedRevision: number) => {
    if (!live(c)) return;
    update(c, { messages: merge(messages, true) });
    if (revision === capturedRevision) messages.forEach(message => freshIds.add(message.id));
  };
  const resetHistory = (c: Cycle) => {
    historyEpoch++;
    cursor = null;
    emptyBaseline = false;
    readCursor = null;
    readingReady = false;
    visibleIds = [];
    translations.clear();
    freshIds.clear();
    update(c, { messages: [], cursor: null, hasMore: false, entryTarget: null });
  };
  const fail = (c: Cycle, error: unknown) => {
    if (!live(c)) return;
    if (denied(error) || error instanceof ChatContractError) {
      resetHistory(c);
      c.stopSocket?.();
      c.stopSocket = null;
      c.timers.forEach(stop => stop());
      c.timers.clear();
      publish({ room: null, profile: null, connection: "ERROR", authorityReady: false, loading: false, syncing: false, loadingMore: false, sending: false, uncertain: state.uncertain || state.sending, error: chatErrorMessage(error) });
      c.terminal = true;
      c.abort.abort();
    } else update(c, { error: chatErrorMessage(error) });
  };
  const visibleTarget = () => latestMessageId(state.messages.filter(message => visibleIds.includes(message.id)));

  // 읽음 PATCH는 단조 증가하는 커서만 재시도한다. 화면 밖·복원 중 메시지를 읽음으로 만들지 않는다.
  const readVisible = (delay = 200) => {
    const c = cycle;
    if (!c || !live(c)) return;
    later(c, "read", delay, () => {
      if (!readingReady || !state.authorityReady || c.syncing || c.reading || !state.room || state.loading) return;
      const target = visibleTarget();
      if (!target || (readCursor && compareIds(target, readCursor) <= 0)) return;
      c.reading = true;
      const capturedEpoch = historyEpoch;
      let retryRead = false;
      let succeeded = false;
      void request(c, signal => service.read(roomId, target, signal)).then(response => {
        if (capturedEpoch !== historyEpoch) return;
        if (response.lastReadMessageId && (!readCursor || compareIds(response.lastReadMessageId, readCursor) > 0)) readCursor = response.lastReadMessageId;
        succeeded = response.lastReadMessageId !== null && compareIds(response.lastReadMessageId, target) >= 0;
        if (succeeded) c.readFailures = 0;
        if (state.notice?.startsWith("읽음 상태")) update(c, { notice: null });
      }).catch((error: unknown) => {
        if (!live(c) || capturedEpoch !== historyEpoch) return;
        if (denied(error) || error instanceof ChatContractError) { fail(c, error); return; }
        retryRead = retryable(error);
        update(c, { notice: `읽음 상태를 저장하지 못했어요. 연결되면 다시 확인할게요. ${chatErrorMessage(error)}` });
      }).finally(() => {
        c.reading = false;
        if (!live(c) || capturedEpoch !== historyEpoch || !readingReady) return;
        const targetNow = visibleTarget();
        if ((retryRead || succeeded) && targetNow && (!readCursor || compareIds(targetNow, readCursor) > 0)) readVisible(backoff(c.readFailures++));
      });
    });
  };

  const requestSync = (c: Cycle, delay = 500) => {
    if (!live(c)) return;
    if (c.syncing) { c.syncAgain = true; return; }
    later(c, "sync", delay, () => { void sync(c); });
  };
  const invalidate = (c: Cycle, delay = 500) => {
    if (!live(c)) return;
    revision++;
    freshIds.clear();
    requestSync(c, delay);
  };
  const before = (c: Cycle, id: string | null) => request(c, signal => service.messages(roomId, id, signal));

  // 보이는 과거 페이지도 재조회한다. 이미 읽은 이벤트를 REST 집계에서 또 빼지 않는다.
  const refreshVisible = async (c: Cycle, capturedRevision: number) => {
    const visible = state.messages.filter(message => visibleIds.includes(message.id));
    const first = visible[0]?.id;
    const last = latestMessageId(visible);
    if (!first || !last || visible.every(message => freshIds.has(message.id))) return;
    const next = state.messages.find(message => compareIds(message.id, last) > 0)?.id;
    const start = await before(c, next ?? null);
    const window = await checked(c, refreshMessageWindow(start, first, next ?? null, id => before(c, id)));
    const retained = new Set(window.map(message => message.id));
    // 조회한 가시 범위에서 사라진 행만 제거한다. 다른 기록과 새 실시간 메시지는 보존한다.
    update(c, { messages: state.messages.filter(message => compareIds(message.id, first) < 0
      || compareIds(message.id, last) > 0 || retained.has(message.id)) });
    applySnapshot(c, window, capturedRevision);
  };

  const sync = async (c: Cycle) => {
    if (!live(c)) return;
    if (c.syncing) { c.syncAgain = true; return; }
    cancel(c, "sync");
    cancel(c, "poll");
    c.syncing = true;
    const capturedRevision = revision;
    let retry = false;
    let succeeded = false;
    update(c, { syncing: true, error: null });
    try {
      // 모든 await 뒤에 활성 화면과 계정 세대를 확인해 이전 요청이 새 커서를 바꾸지 못하게 한다.
      const room = await request(c, signal => service.room(roomId, signal));
      const profile = room.roomType === "OPEN" ? await request(c, signal => service.myOpenProfile(roomId, signal)) : null;
      // 조회 도중 도착한 관리 이벤트보다 오래된 권한을 다시 활성화하지 않는다.
      if (capturedRevision !== revision) { c.syncAgain = true; return; }
      if (profile && state.profile && profile.joinedAt !== state.profile.joinedAt) resetHistory(c);
      update(c, { room, profile, authorityReady: true });
      if (cursor) {
        try {
          const nextCursor = await checked(c, catchUpMessages(cursor,
            id => request(c, signal => service.after(roomId, id, signal)),
            messages => applySnapshot(c, messages, capturedRevision)));
          cursor = nextCursor;
        } catch (error) {
          if (!live(c)) return;
          if (![400, 404].includes(statusOf(error) ?? -1)) throw error;
          // 접근 범위가 바뀐 기준 행은 버리고 새 membership의 기록을 처음부터 읽는다.
          resetHistory(c);
        }
      }
      const needsEntry = state.entryTarget === null;
      let firstUnread: string | null = null;
      let entryAvailable = true;
      if (needsEntry) {
        try { firstUnread = await request(c, signal => service.firstUnread(roomId, signal)); }
        catch (error) {
          if (!live(c)) return;
          if (denied(error) || error instanceof ChatContractError) throw error;
          entryAvailable = false;
          retry = retryable(error);
          update(c, { notice: "읽던 위치를 확인하지 못했어요. 연결되면 다시 확인할게요." });
        }
      }
      const latest = await before(c, null);
      let entryPage = latest;
      if (needsEntry && state.entryTarget === null && entryAvailable && firstUnread) {
        try { entryPage = await checked(c, restoreUnreadHistory(latest, firstUnread, id => before(c, id))); }
        catch (error) {
          if (!live(c)) return;
          if (!(error instanceof ChatContractError && error.code === "CHAT_ENTRY_ANCHOR_MISSING")) throw error;
          entryAvailable = false;
          update(c, { notice: "읽던 메시지 위치가 바뀌었어요. 최신 메시지로 이동해 주세요." });
        }
      }
      const resetting = cursor === null;
      if (resetting && emptyBaseline) {
        cursor = await checked(c, recoverEmptyRoomHistory(latest, id => before(c, id), messages => applySnapshot(c, messages, capturedRevision)));
        update(c, { cursor: null, hasMore: false });
      } else {
        applySnapshot(c, entryPage.messages, capturedRevision);
        if (resetting) {
          update(c, { cursor: entryPage.nextCursorId, hasMore: entryPage.hasNext });
          cursor = latestMessageId(latest.messages);
        }
      }
      if (resetting) emptyBaseline = cursor === null;
      if (needsEntry && state.entryTarget === null && entryAvailable) {
        update(c, { entryTarget: { messageId: firstUnread ?? latestMessageId(latest.messages), unread: firstUnread !== null } });
        if (state.notice?.startsWith("읽던 위치")) update(c, { notice: null });
      }
      if (!needsEntry) await refreshVisible(c, capturedRevision);
      if (!live(c)) return;
      try { update(c, { language: await request(c, signal => service.language(roomId, signal)) }); }
      catch (error) {
        if (!live(c)) return;
        if (denied(error) || error instanceof ChatContractError) throw error;
        retry ||= retryable(error);
        update(c, { notice: "번역 표시 설정을 가져오지 못해 원문과 받은 번역을 함께 표시해요." });
      }
      if (room.closed || !room.active) {
        c.stopSocket?.();
        c.stopSocket = null;
        update(c, { connection: "DISCONNECTED" });
      } else if (!c.stopSocket) c.stopSocket = connect({
        open: room.roomType === "OPEN",
        onStatus: connection => update(c, { connection }),
        onInvalidEvent: error => fail(c, error),
        onConnect: () => { update(c, { authorityReady: false }); invalidate(c, 0); },
        onEvent: event => receive(c, event),
      });
      succeeded = !retry;
      if (succeeded) c.syncFailures = 0;
    } catch (error) {
      if (!live(c)) return;
      retry = retryable(error);
      fail(c, error);
    } finally {
      c.syncing = false;
      update(c, { syncing: false, loading: false });
      if (live(c)) {
        // 이벤트 폭주도 한 번에 합친다. 실패한 조회만 지연 재시도하며 POST는 건드리지 않는다.
        if (retry) { c.syncAgain = false; requestSync(c, backoff(c.syncFailures++)); }
        else if (c.syncAgain) { c.syncAgain = false; requestSync(c); }
        else if (succeeded) later(c, "poll", 30000, () => invalidate(c, 0));
        readVisible();
      }
    }
  };

  const receive = (c: Cycle, event: RoomEvent) => {
    if (!live(c) || event.roomId !== roomId) return;
    if (event.kind === "message") update(c, { messages: merge([event.message]) });
    if (event.kind === "translation") {
      const existing = state.messages.find(message => message.id === event.messageId);
      if (existing?.contentVisibility && existing.contentVisibility !== "VISIBLE") return;
      translations.set(event.messageId, mergeTranslations(translations.get(event.messageId) ?? [], [event.translation]));
      if (translations.size > 500) translations.delete(translations.keys().next().value!);
      update(c, { messages: merge(state.messages) });
    }
    if (event.kind === "read" && event.last && (!readCursor || compareIds(event.last, readCursor) > 0)) readCursor = event.last;
    if (event.kind === "memberRead") invalidate(c);
    if (event.kind === "refresh") {
      // 관리 메뉴·전송을 즉시 잠그고 이벤트의 역할 값 대신 HTTP 상태를 신뢰한다.
      update(c, { authorityReady: false });
      invalidate(c, 0);
    }
  };

  const stop = () => {
    const old = cycle;
    cycle = null;
    readingReady = false;
    visibleIds = [];
    old?.abort.abort();
    old?.stopSocket?.();
    old?.timers.forEach(cancelTimer => cancelTimer());
    old?.timers.clear();
    publish({ syncing: false, loadingMore: false, sending: false, connection: "DISCONNECTED", authorityReady: false, ...(state.sending ? {
      uncertain: true, notice: "화면을 떠나는 동안 전송 결과를 확인하지 못했어요. 대화를 확인한 뒤 다시 작성해 주세요.",
    } : {}) });
  };
  const start = () => {
    if (!roomId || !isCurrent() || !isActive() || (cycle && live(cycle))) return;
    if (cycle) stop();
    const c: Cycle = { abort: new AbortController(), timers: new Map(), stopSocket: null, syncing: false, syncAgain: false,
      reading: false, terminal: false, syncFailures: 0, readFailures: 0 };
    cycle = c;
    revision++;
    freshIds.clear();
    update(c, { loading: !state.room, authorityReady: false, error: null });
    void sync(c);
  };

  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    start, stop,
    markVisible(ids: string[]) {
      visibleIds = ids;
      if (cycle && state.messages.some(message => ids.includes(message.id) && !freshIds.has(message.id))) requestSync(cycle);
      readVisible();
    },
    setReadingReady(ready: boolean) { readingReady = ready; if (ready) readVisible(); },
    chooseLatest() { if (cycle && !state.entryTarget) update(cycle, { entryTarget: { messageId: latestMessageId(state.messages), unread: false } }); },
    clearUncertain() { if (cycle) update(cycle, { uncertain: false, notice: null }); },
    async refresh() {
      if (cycle?.terminal) { stop(); start(); return; }
      if (!cycle || !live(cycle)) return;
      cycle.stopSocket?.();
      cycle.stopSocket = null;
      revision++;
      freshIds.clear();
      update(cycle, { authorityReady: false });
      await sync(cycle);
    },
    async loadOlder() {
      const c = cycle;
      if (!c || !live(c) || !state.authorityReady || !state.room || !state.cursor || !state.hasMore || state.loadingMore) return;
      const capturedEpoch = historyEpoch;
      const capturedRevision = revision;
      update(c, { loadingMore: true });
      try {
        const page = await before(c, state.cursor);
        if (capturedEpoch !== historyEpoch) return;
        update(c, { messages: merge(page.messages), cursor: page.nextCursorId, hasMore: page.hasNext });
        if (revision === capturedRevision) page.messages.forEach(message => freshIds.add(message.id));
      } catch (error) { if (capturedEpoch === historyEpoch) fail(c, error); }
      finally { update(c, { loadingMore: false }); }
    },
    async send(content: string): Promise<boolean> {
      const c = cycle;
      if (!c || !live(c) || !state.authorityReady || !state.room?.active || state.room.closed || state.sending || state.uncertain || !content.trim() || content.length > 5000) return false;
      const capturedEpoch = historyEpoch;
      update(c, { sending: true, notice: null });
      try {
        const message = await request(c, signal => service.send(roomId, content.trim(), signal));
        if (capturedEpoch !== historyEpoch) { update(c, { uncertain: true }); return false; }
        update(c, { messages: merge([message]) });
        return true;
      } catch (error) {
        if (!live(c)) return false;
        const status = statusOf(error);
        const rejected = status !== null && status >= 400 && status < 500 && status !== 408;
        update(c, { uncertain: !rejected, notice: rejected ? chatErrorMessage(error)
          : "전송 결과를 확인하지 못했어요. 이미 저장됐을 수 있으니 대화를 새로고침해 확인해 주세요. 자동으로 다시 보내지 않아요." });
        return false;
      } finally { update(c, { sending: false }); }
    },
  };
}
