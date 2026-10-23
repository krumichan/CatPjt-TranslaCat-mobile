import { ApiError } from "../../api/client.ts";
import { ChatContractError } from "../../domain/chat/contracts.ts";
import type { RoomEvent } from "../../realtime/events.ts";
import type { FriendEntry } from "../friends/service.ts";
import { invitationInput } from "../open-invitations/contracts.ts";
import { banBody, inviteBody, ManagementInputError, type InviteTargets, type ManagedRoom, type RoomBan, type RoomMember } from "./contracts.ts";
import type { RoomManagementService } from "./service.ts";

export function capabilities(room: ManagedRoom | null) {
  const open = room?.roomType === "OPEN";
  const manager = room?.myRole === "OWNER" || room?.myRole === "ADMIN";
  return {
    invite: !!room?.active && room.roomType === "GROUP" && !["OPEN", "AI"].includes(room.sourceType) && manager,
    leave: !!room?.active && open && (room.myRole === "MEMBER" || room.myRole === "ADMIN"),
    close: !!room?.active && !room.closed && open && room.myRole === "OWNER",
    share: !!room?.active && !room.closed && open,
    bans: !!room?.active && !room.closed && open && manager,
  };
}

export function memberActions(room: ManagedRoom | null, member: RoomMember, myMemberId: string | null) {
  const eligible = !!room?.active && !room.closed && room.roomType === "OPEN" && member.active
    && myMemberId !== null && member.id !== myMemberId && member.role !== "OWNER";
  const owner = room?.myRole === "OWNER";
  return {
    assignAdmin: eligible && owner && member.role === "MEMBER",
    revokeAdmin: eligible && owner && member.role === "ADMIN",
    transfer: eligible && owner,
    ban: eligible && (owner || (room?.myRole === "ADMIN" && member.role === "MEMBER")),
  };
}

export interface RoomManagementState {
  room: ManagedRoom | null;
  members: RoomMember[];
  myMemberId: string | null;
  friends: FriendEntry[];
  friendsError: string | null;
  bans: RoomBan[];
  hasMoreBans: boolean;
  loadingBans: boolean;
  bansError: string | null;
  loading: boolean;
  busy: boolean;
  ready: boolean;
  uncertain: boolean;
  revision: number;
  error: string | null;
  notice: string | null;
  exited: boolean;
}

export interface RoomManagementConnection {
  open: boolean;
  onConnect: () => void;
  onStatus: (status: string) => void;
  onInvalidEvent: (error: unknown) => void;
  onEvent: (event: RoomEvent) => void;
}

export interface RoomManagementOptions {
  connect?: (handlers: RoomManagementConnection) => () => void;
  schedule?: (callback: () => void, delay: number) => () => void;
}

interface RoomAuthority {
  room: ManagedRoom;
  members: RoomMember[];
  myMemberId: string;
}

function authorityKey(authority: RoomAuthority) {
  return JSON.stringify([
    authority.room.roomType, authority.room.sourceType, authority.room.active, !!authority.room.closed, authority.room.myRole,
    authority.myMemberId, authority.members.map(member => [member.id, member.role, member.active]).sort(),
  ]);
}

export function emptyRoomManagement(): RoomManagementState {
  return { room: null, members: [], myMemberId: null, friends: [], friendsError: null,
    bans: [], hasMoreBans: false, loadingBans: false, bansError: null,
    loading: true, busy: false, ready: false, uncertain: false, revision: 0, error: null, notice: null, exited: false };
}

function errorMessage(error: unknown) {
  if (error instanceof ChatContractError && error.code === "INVALID_INVITATION_INPUT") return "TranslaCat ID 한 개를 1~255자로 입력해 주세요.";
  if (error instanceof ApiError && error.serverCode === "OPEN_INVITATION_RATE_LIMITED") return "초대를 잠시 후 다시 보내 주세요. 같은 사람에게 짧은 시간에 여러 번 보낼 수 없어요.";
  if (error instanceof ApiError && error.serverCode === "OPEN_INVITATION_TARGET_UNAVAILABLE") return "이 ID로는 지금 초대를 보낼 수 없어요. ID와 초대 가능 여부를 확인해 주세요.";
  if (error instanceof ManagementInputError) return "초대할 ID 또는 강퇴 사유(1~500자)를 확인해 주세요.";
  if (error instanceof ApiError && error.status === 401) return "로그인 상태를 확인해 주세요.";
  if (error instanceof ApiError && [400, 403, 404, 409].includes(error.status)) {
    return "방 상태나 권한이 바뀌었을 수 있어요. 참여 중인 사용자·초대 대상·관리 권한을 다시 확인해 주세요.";
  }
  return "방 정보를 확인하지 못했어요. 연결 상태를 확인하고 다시 불러와 주세요.";
}

// 화면 이탈 뒤에도 같은 로그인·방의 불확실한 변경을 자동으로 재전송하지 않는다.
const uncertainScopes = new Set<string>();
const openInvitationAttempts = new Map<string, { targetPublicId: string; requestId: string }>();
class StaleRead extends Error {}
class ExitedRoom extends Error {}
// bans의 400도 강등·강퇴 경합일 수 있으므로 퇴장 대신 방 권한을 다시 확인한다.
const bansAccessChanged = (error: unknown) => error instanceof ApiError && [400, 403, 404].includes(error.status);
// room GET의 400은 서버가 멤버십 부재를 반환하는 공개 계약이다. 쓰기·차단 목록 400에는 적용하지 않는다.
const roomAccessLost = (error: unknown) => error instanceof ApiError && [400, 403, 404].includes(error.status);
const scheduleTimer = (callback: () => void, delay: number) => {
  const timer = setTimeout(callback, delay);
  return () => clearTimeout(timer);
};

export function createRoomManagementController(service: RoomManagementService, roomId: string, selfId: string,
  scopeKey: string, isCurrent: () => boolean, publish: (state: RoomManagementState) => void,
  timeoutMs = 15000, options: RoomManagementOptions = {}) {
  let state = { ...emptyRoomManagement(), uncertain: uncertainScopes.has(scopeKey) };
  let disposed = false;
  let reading = false;
  let refreshQueued = false;
  let readFailures = 0;
  let nextBanCursor: string | null = null;
  let mutationPending = false;
  let connectionStarted = false;
  let connectionGeneration = 0;
  let lastAuthorityKey: string | null = null;
  let lastBansKey: string | null = null;
  let lastAuthorityRevision = 0;
  let stopConnection: (() => void) | null = null;
  let cancelRefresh: (() => void) | null = null;
  let cancelPoll: (() => void) | null = null;
  const schedule = options.schedule ?? scheduleTimer;
  const requests = new Set<AbortController>();
  const current = () => !disposed && isCurrent();
  const update = (patch: Partial<RoomManagementState>) => {
    if (!current()) return;
    state = { ...state, ...patch };
    publish(state);
  };

  function disconnect() {
    // 폐기한 구독에서 늦게 오는 콜백도 연결 세대로 제외한다.
    connectionGeneration++;
    connectionStarted = false;
    const stop = stopConnection;
    stopConnection = null;
    stop?.();
  }

  function stopWatching() {
    // 화면 생명주기에 속한 예약 조회와 실시간 구독을 함께 종료한다.
    cancelRefresh?.();
    cancelPoll?.();
    cancelRefresh = null;
    cancelPoll = null;
    disconnect();
    refreshQueued = false;
  }

  function exitRoom(notice = "이 방에 더 이상 참여하고 있지 않아요. 방 목록에서 다시 확인해 주세요.") {
    if (!current() || state.exited) return;
    // 종료 상태를 먼저 공개하여 구독 해제 중 발생할 수 있는 콜백도 무시한다.
    nextBanCursor = null;
    update({ room: null, members: [], myMemberId: null, friends: [], friendsError: null,
      bans: [], hasMoreBans: false, loadingBans: false, bansError: null, loading: false,
      ready: false, exited: true, revision: state.revision + 1, error: null, notice });
    stopWatching();
  }

  function fence(revision: number) {
    if (!current() || state.exited) throw new ExitedRoom();
    if (revision !== state.revision) throw new StaleRead();
  }

  async function request<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (!current()) throw new ApiError(0, "SESSION_CHANGED");
    const abort = new AbortController();
    requests.add(abort);
    let timer: ReturnType<typeof setTimeout>;
    let onAbort: () => void;
    // 공유 토큰 갱신 대기까지 기한을 두고, 늦은 응답은 소비하되 화면에 반영하지 않는다.
    const cancelled = new Promise<never>((_, reject) => {
      onAbort = () => reject(new ApiError(0, "REQUEST_ABORTED"));
      abort.signal.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => abort.abort(), timeoutMs);
    });
    try {
      const value = await Promise.race([work(abort.signal), cancelled]);
      if (!current() || abort.signal.aborted) throw new ApiError(0, "SESSION_CHANGED");
      return value;
    } finally {
      clearTimeout(timer!);
      abort.signal.removeEventListener("abort", onAbort!);
      requests.delete(abort);
    }
  }

  function queueRefresh(delay = 50) {
    // 진행 중 조회·변경은 끝날 때 최신 GET을 한 번만 수행하도록 예약을 합친다.
    if (!current() || state.exited || reading || state.busy || state.loadingBans || cancelRefresh) return;
    cancelRefresh = schedule(() => {
      cancelRefresh = null;
      if (current() && !state.exited) void load();
    }, delay);
  }

  function invalidate() {
    if (!current() || state.exited) return;
    // 이벤트 payload의 역할은 신뢰하지 않는다. 확인창과 관리 자료를 먼저 폐기하고 GET만 예약한다.
    cancelPoll?.();
    cancelPoll = null;
    nextBanCursor = null;
    refreshQueued = true;
    update({ revision: state.revision + 1, ready: false, room: null, members: [], myMemberId: null,
      friends: [], friendsError: null, bans: [], hasMoreBans: false, bansError: null, error: null });
    queueRefresh();
  }

  function watch(room: ManagedRoom) {
    // 검증된 방 종류로 최초 연결을 만들고 이후 reconnect에서는 같은 구독 생명주기를 유지한다.
    if (room.closed) { disconnect(); return; }
    if (!options.connect || connectionStarted || !current() || state.exited) return;
    connectionStarted = true;
    const generation = ++connectionGeneration;
    const receive = () => { if (generation === connectionGeneration) invalidate(); };
    try {
      const stop = options.connect({
        open: room.roomType === "OPEN",
        onConnect: receive,
        onStatus: status => { if (["DISCONNECTED", "RETRYING", "ERROR"].includes(status)) receive(); },
        onInvalidEvent: receive,
        onEvent: event => { if (event.kind === "refresh" && event.roomId === roomId) receive(); },
      });
      if (!current() || state.exited) stop();
      else stopConnection = stop;
    } catch {
      // 연결 생성 자체가 실패하면 동기 GET 반복 없이 다음 안전망 조회에서 연결을 다시 시도한다.
      connectionStarted = false;
      connectionGeneration++;
    }
  }

  function poll(succeeded: boolean) {
    if (!current() || state.exited) return;
    cancelPoll?.();
    // 수신 누락에는 낮은 빈도 GET, 읽기 실패에는 상한이 있는 backoff만 사용한다. POST는 예약하지 않는다.
    const delay = succeeded ? 30000 : Math.min(1000 * 2 ** Math.min(Math.max(readFailures - 1, 0), 5), 30000);
    cancelPoll = schedule(() => {
      cancelPoll = null;
      if (!current() || state.exited) return;
      if (reading || state.busy || state.loadingBans) poll(succeeded);
      else void load(true);
    }, delay);
  }

  async function readRoom(revision: number) {
    // room 접근 응답만 멤버십 상실의 기준으로 사용하고 오래된 응답은 먼저 제외한다.
    let room: ManagedRoom;
    try { room = await request(signal => service.room(roomId, signal)); }
    catch (error) {
      fence(revision);
      if (roomAccessLost(error)) { exitRoom(); throw new ExitedRoom(); }
      throw error;
    }
    fence(revision);
    if (!room.active) { exitRoom(); throw new ExitedRoom(); }
    return room;
  }

  async function readAuthority(revision: number, canRecheck = true): Promise<RoomAuthority> {
    // 세 조회가 같은 무효화 세대에 속할 때만 자기 신원·역할을 함께 공개한다.
    const room = await readRoom(revision);
    try {
      const members = await request(signal => service.members(roomId, room.roomType === "OPEN", signal));
      fence(revision);
      const me = room.roomType === "OPEN" ? await request(signal => service.me(roomId, signal)) : null;
      fence(revision);
      const myMemberId = me?.id ?? selfId;
      const own = members.find(member => member.id === myMemberId);
      if (!own?.active || own.role !== room.myRole || (me && (!me.active || me.role !== own.role))) throw new ChatContractError();
      return { room, members, myMemberId };
    } catch (error) {
      fence(revision);
      // 목록·프로필 조회 사이 강퇴되면 서버가 400을 줄 수 있다. room 접근을 한 번 더 확인하여 퇴장을 판정한다.
      if (canRecheck && roomAccessLost(error)) return readAuthority(revision, false);
      throw error;
    }
  }

  async function load(background = false) {
    // 조회 결과를 완성한 뒤 한 번에 공개하고 조회 중 무효화는 다음 세대로 이어서 처리한다.
    if (!current() || reading || state.busy || state.loadingBans || state.exited) return false;
    cancelRefresh?.();
    cancelPoll?.();
    cancelRefresh = null;
    cancelPoll = null;
    reading = true;
    let succeeded = false;
    try {
      do {
        refreshQueued = false;
        const revision = state.revision;
        const preserveExisting = background && state.ready;
        if (!preserveExisting) nextBanCursor = null;
        // 정상 안전망 조회는 작성 중인 확인창과 목록을 유지하고 완료 전까지 변경 버튼만 잠근다.
        if (preserveExisting) update({ loading: true, error: null });
        else update({ loading: true, ready: false, room: null, error: null, members: [], myMemberId: null,
          friends: [], friendsError: null, bans: [], hasMoreBans: false, bansError: null });
        try {
          let authority = await readAuthority(revision);
          // 변함없는 안전망 GET은 사용자가 펼친 차단 페이지·초대 선택·cursor를 보존한다.
          const keepAuxiliary = preserveExisting && authorityKey(authority) === lastAuthorityKey;
          let friends: FriendEntry[] = keepAuxiliary ? state.friends : [];
          let friendsError: string | null = keepAuxiliary ? state.friendsError : null;
          let bans: RoomBan[] = keepAuxiliary ? state.bans : [];
          let bansError: string | null = keepAuxiliary ? state.bansError : null;
          let hasMoreBans = keepAuxiliary ? state.hasMoreBans : false;
          let cursor: string | null = keepAuxiliary ? nextBanCursor : null;

          // 부가 목록 실패는 참여자 읽기와 분리한다. bans의 400/403/404는 퇴장으로 단정하지 않고 실제 권한을 다시 확인한다.
          if (!keepAuxiliary && capabilities(authority.room).invite) {
            try { friends = await request(signal => service.friends(signal)); }
            catch { friendsError = "친구 목록을 불러오지 못했어요. TranslaCat ID로 초대하거나 다시 불러와 주세요."; }
            fence(revision);
          }
          if (!keepAuxiliary && capabilities(authority.room).bans) {
            try {
              const page = await request(signal => service.bans(roomId, null, signal));
              bans = page.items;
              hasMoreBans = page.hasNext;
              cursor = page.nextCursor;
            } catch (error) {
              fence(revision);
              if (bansAccessChanged(error)) authority = await readAuthority(revision);
              if (capabilities(authority.room).bans) bansError = errorMessage(error);
            }
            fence(revision);
          }
          // 이벤트 누락을 poll이 발견했을 때만 기존 동의를 폐기한다. 변함없는 30초 조회는 revision을 유지한다.
          const nextAuthorityKey = authorityKey(authority);
          const nextBansKey = keepAuxiliary ? lastBansKey : JSON.stringify(bans.map(item => [item.id, item.releasable]).sort());
          const changed = lastAuthorityKey !== null && (lastAuthorityKey !== nextAuthorityKey || lastBansKey !== nextBansKey)
            && lastAuthorityRevision === revision;
          const publishedRevision = revision + (changed ? 1 : 0);
          lastAuthorityKey = nextAuthorityKey;
          lastBansKey = nextBansKey;
          lastAuthorityRevision = publishedRevision;
          nextBanCursor = cursor;
          update({ ...authority, revision: publishedRevision, friends, friendsError, bans, bansError, hasMoreBans, ready: true,
            notice: authority.room.closed ? "방이 종료됐어요. 대화 기록은 계속 읽을 수 있어요." : state.notice });
          succeeded = true;
          readFailures = 0;
          watch(authority.room);
        } catch (error) {
          if (!current() || state.exited) break;
          // 조회 중 도착한 이벤트보다 오래된 응답은 성공·실패 모두 버리고 최신 조회 한 번으로 합친다.
          if (error instanceof StaleRead || revision !== state.revision) continue;
          succeeded = false;
          readFailures++;
          update({ revision: state.revision + (state.ready ? 1 : 0), room: null, members: [], myMemberId: null,
            friends: [], bans: [], hasMoreBans: false, ready: false, error: errorMessage(error) });
        }
      } while (current() && !state.exited && refreshQueued);
    } finally {
      reading = false;
      update({ loading: false });
      if (refreshQueued) queueRefresh(0);
      else poll(succeeded);
    }
    return succeeded && current() && state.ready;
  }

  async function readBans(cursor: string) {
    // 다음 페이지도 권한 세대에 묶어 강퇴 사유가 권한 회수 뒤 다시 노출되지 않게 한다.
    if (!current() || !state.ready || !capabilities(state.room).bans) return false;
    const revision = state.revision;
    update({ loadingBans: true, bansError: null });
    try {
      const page = await request(signal => service.bans(roomId, cursor, signal));
      fence(revision);
      if (page.items.some(item => state.bans.some(existing => existing.id === item.id))) throw new ChatContractError();
      nextBanCursor = page.nextCursor;
      update({ bans: [...state.bans, ...page.items], hasMoreBans: page.hasNext });
      return true;
    } catch (error) {
      if (current() && !state.exited && revision === state.revision) {
        if (bansAccessChanged(error)) invalidate();
        else update({ bansError: errorMessage(error) });
      }
      return false;
    } finally {
      update({ loadingBans: false });
      if (refreshQueued) queueRefresh(0);
    }
  }

  async function mutate(allowed: (room: ManagedRoom) => boolean, work: (signal: AbortSignal) => Promise<unknown>,
    notice: string, exit = false) {
    if (!current() || !state.ready || state.loading || state.loadingBans || state.busy || state.uncertain || state.exited) return false;
    const revision = state.revision;
    update({ busy: true, error: null, notice: null });
    let succeeded = false;
    let attempted = false;
    try {
      // preflight 응답과 POST 사이에도 이벤트 세대를 확인하여 오래된 확인창의 변경을 전송하지 않는다.
      const room = await readRoom(revision);
      fence(revision);
      update({ room });
      if (!allowed(room)) throw new ApiError(403, "ROOM_ACTION_NOT_ALLOWED");
      fence(revision);
      attempted = true;
      mutationPending = true;
      await request(work);
      succeeded = true;
      if (exit) exitRoom(notice);
      else if (revision === state.revision) update({ notice, ready: true });
    } catch (error) {
      const rejected = error instanceof ManagementInputError || (error instanceof ApiError
        && error.status >= 400 && error.status < 500 && error.status !== 408);
      if (attempted && !rejected) {
        uncertainScopes.add(scopeKey);
        update({ uncertain: true, notice: "요청 결과를 확인하지 못했어요. 이미 반영됐을 수 있으니 다시 불러온 목록을 확인해 주세요." });
      }
      if (!(error instanceof StaleRead) && !(error instanceof ExitedRoom) && !state.exited) {
        update({ error: errorMessage(error), ready: false });
      }
    } finally {
      mutationPending = false;
      update({ busy: false });
    }
    // 처리 중 이벤트는 POST를 재전송하지 않고, 작업이 끝난 뒤 권한 GET 한 번으로만 수렴한다.
    if (current() && !state.exited && ((succeeded && !exit) || refreshQueued)) await load();
    return succeeded && current();
  }

  const targetAllowed = (room: ManagedRoom, id: string, action: keyof ReturnType<typeof memberActions>) => {
    const target = state.members.find(member => member.id === id);
    return !!target && memberActions(room, target, state.myMemberId)[action];
  };

  return {
    getState: () => state,
    load,
    loadMoreBans: () => {
      if (!state.ready || state.loading || state.busy || state.loadingBans || !state.hasMoreBans || !nextBanCursor) return Promise.resolve(false);
      return readBans(nextBanCursor);
    },
    invite: (input: InviteTargets) => mutate(room => {
      const body = inviteBody(input);
      return capabilities(room).invite && !state.members.some(member => body.targetUserIds.includes(Number(member.id))
        || (!!member.publicId && body.targetPublicIds.includes(member.publicId)));
    }, signal => service.invite(roomId, input, signal), "초대했어요. 참여자 목록을 새로 불러왔어요."),
    sendOpenInvitation: (targetPublicId: string, requestId: string) => {
      let input: ReturnType<typeof invitationInput>;
      try { input = invitationInput(targetPublicId, requestId); }
      catch (error) { update({ error: errorMessage(error) }); return Promise.resolve(false); }
      const attemptScope = JSON.stringify([scopeKey, input.targetPublicId]);
      const attempt = openInvitationAttempts.get(attemptScope) ?? input;
      return mutate(room => capabilities(room).share, async signal => {
        // 불확실했던 동일 대상의 명시 재시도도 같은 멱등 키를 유지한다. 자동 POST 재전송은 하지 않는다.
        openInvitationAttempts.set(attemptScope, attempt);
        await service.sendOpenInvitation(roomId, attempt.targetPublicId, attempt.requestId, signal);
      }, "초대를 보냈어요. 상대방이 ‘오픈채팅 초대’에서 확인하고 직접 참여할 수 있어요.").then(succeeded => {
        // timeout·화면 이탈 뒤 늦은 성공이 와도 보존 중인 시도 키를 지우지 않는다.
        if (succeeded && openInvitationAttempts.get(attemptScope) === attempt) openInvitationAttempts.delete(attemptScope);
        return succeeded;
      });
    },
    leave: () => mutate(room => capabilities(room).leave, signal => service.leave(roomId, signal), "방에서 나왔어요.", true),
    close: () => mutate(room => capabilities(room).close, signal => service.close(roomId, signal), "방을 종료했어요. 대화 기록은 유지돼요.", true),
    assignAdmin: (id: string) => mutate(room => targetAllowed(room, id, "assignAdmin"), signal => service.changeAdmin(roomId, id, true, signal), "관리자로 지정했어요."),
    revokeAdmin: (id: string) => mutate(room => targetAllowed(room, id, "revokeAdmin"), signal => service.changeAdmin(roomId, id, false, signal), "관리자 권한을 해제했어요."),
    transfer: (id: string) => mutate(room => targetAllowed(room, id, "transfer"), signal => service.transfer(roomId, id, signal), "방장을 위임했어요. 이제 나가기 메뉴를 사용할 수 있어요."),
    ban: (id: string, reason: string) => mutate(room => {
      banBody(id, reason);
      return targetAllowed(room, id, "ban");
    }, signal => service.ban(roomId, id, reason, signal), "강퇴하고 재입장을 차단했어요."),
    releaseBan: (id: string) => mutate(room => !!room.active && !room.closed && capabilities(room).bans
      && state.bans.some(ban => ban.id === id && ban.releasable), signal => service.releaseBan(roomId, id, signal), "재입장 차단을 해제했어요. 상대가 직접 다시 참여할 수 있어요."),
    acknowledge: () => {
      if (!current() || state.loading || state.loadingBans || state.busy || !state.ready || state.error || state.bansError) return false;
      uncertainScopes.delete(scopeKey);
      update({ uncertain: false, notice: null });
      return true;
    },
    dispose: () => {
      // 진행 중 쓰기의 결과 불확실성은 같은 scope에 남기고 화면 자원과 GET을 정리한다.
      if (mutationPending) uncertainScopes.add(scopeKey);
      disposed = true;
      stopWatching();
      for (const abort of requests) abort.abort();
    },
  };
}
