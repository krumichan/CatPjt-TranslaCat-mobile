import { ApiError } from "../../api/client.ts";
import { ChatContractError } from "../../domain/chat/contracts.ts";
import type { OpenRoom } from "../../domain/chat/types.ts";
import type { ChatService } from "../chat/service.ts";
import type { OpenInvitation } from "./contracts.ts";
import type { OpenInvitationService } from "./service.ts";

export interface InvitationPreviewState {
  invitation: OpenInvitation | null;
  room: OpenRoom | null;
  loading: boolean;
  busy: boolean;
  uncertain: boolean;
  error: string | null;
  notice: string | null;
}
export const emptyInvitationPreview = (): InvitationPreviewState => ({ invitation: null, room: null,
  loading: true, busy: false, uncertain: false, error: null, notice: null });
const uncertainJoins = new Set<string>();

export function invitationError(error: unknown) {
  if (error instanceof ApiError && error.status === 401) return "로그인 상태를 확인해 주세요.";
  if (error instanceof ApiError && [400, 403, 404, 409].includes(error.status)) return "이 초대나 방을 이용할 수 없어요. 방 상태와 참여 가능 여부를 다시 확인해 주세요.";
  return "초대를 확인하지 못했어요. 연결 상태를 확인하고 다시 불러와 주세요.";
}

export function createInvitationPreviewController(invitations: OpenInvitationService, chat: ChatService,
  invitationId: string, scope: string, isCurrent: () => boolean, publish: (state: InvitationPreviewState) => void,
  onJoined: (roomId: string) => void, onRead: () => void, timeoutMs = 15000) {
  let state = { ...emptyInvitationPreview(), uncertain: uncertainJoins.has(scope) };
  let disposed = false;
  let revision = 0;
  let joining = false;
  let reading = false;
  const requests = new Set<AbortController>();
  const current = () => !disposed && isCurrent();
  const update = (patch: Partial<InvitationPreviewState>) => {
    if (!current()) return;
    state = { ...state, ...patch };
    publish(state);
  };
  const fence = (version: number) => {
    if (!current() || version !== revision) throw new ApiError(0, "SESSION_CHANGED");
  };
  async function request<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const abort = new AbortController();
    requests.add(abort);
    let timer: ReturnType<typeof setTimeout>;
    let rejectOnAbort: () => void;
    // 토큰 갱신이나 모의 transport가 signal을 무시해도 화면 대기는 기한 안에 끝낸다.
    const cancelled = new Promise<never>((_, reject) => {
      rejectOnAbort = () => reject(new ApiError(0, "REQUEST_ABORTED"));
      abort.signal.addEventListener("abort", rejectOnAbort, { once: true });
      timer = setTimeout(() => abort.abort(), timeoutMs);
    });
    try { return await Promise.race([Promise.resolve().then(() => {
      if (!current() || abort.signal.aborted) throw new ApiError(0, "REQUEST_ABORTED");
      return work(abort.signal);
    }), cancelled]); }
    finally { clearTimeout(timer!); abort.signal.removeEventListener("abort", rejectOnAbort!); requests.delete(abort); }
  }
  async function fetchPreview(version: number) {
    const invitation = await request(signal => invitations.detail(invitationId, signal));
    fence(version);
    const room = await request(signal => chat.openRoom(invitation.roomId, signal));
    fence(version);
    if (room.id !== invitation.roomId) throw new ChatContractError();
    return { invitation, room };
  }
  async function load() {
    if (!current() || state.busy || reading) return false;
    reading = true;
    const version = ++revision;
    update({ loading: true, invitation: null, room: null, error: null, notice: null });
    try {
      let { invitation, room } = await fetchPreview(version);
      if (room.joined) uncertainJoins.delete(scope);
      // 읽음 처리는 현재 수신한 초대 한 건에만 적용한다. 실패해도 자동 참여하지 않는다.
      if (!invitation.isRead) {
        try { invitation = await request(signal => invitations.read(invitationId, room.id, signal)); fence(version); onRead(); }
        catch { fence(version); update({ notice: "초대는 열었지만 읽음 상태를 저장하지 못했어요. 다시 불러오면 확인할 수 있어요." }); }
      }
      fence(version);
      update({ invitation, room, uncertain: uncertainJoins.has(scope) });
      return true;
    } catch (error) {
      if (current() && version === revision) update({ invitation: null, room: null, error: invitationError(error) });
      return false;
    } finally { reading = false; if (version === revision) update({ loading: false }); }
  }
  async function join(nickname: string) {
    if (!current() || state.busy || state.loading || state.uncertain || !state.invitation || !state.room) return false;
    if (!state.room.myOpenProfile && (!nickname.trim() || nickname.trim().length > 50)) {
      update({ error: "이 방에서 사용할 닉네임을 1~50자로 입력해 주세요." });
      return false;
    }
    const version = ++revision;
    update({ busy: true, error: null, notice: null });
    let attempted = false;
    try {
      // 초대 수신권한과 방 상태를 버튼 직전 다시 확인한다. 읽은 초대만으로 멤버십을 가정하지 않는다.
      const { invitation, room } = await fetchPreview(version);
      update({ invitation, room });
      if (room.joined) { uncertainJoins.delete(scope); onJoined(room.id); return true; }
      if (!room.joinable) { update({ notice: blockedInvitationReason(room.joinBlockedReason) }); return false; }
      fence(version);
      attempted = true;
      joining = true;
      const joined = await request(signal => chat.join(room.id, room.myOpenProfile ? null : nickname.trim(), signal));
      fence(version);
      if (!joined.joined || joined.id !== room.id) throw new ChatContractError();
      uncertainJoins.delete(scope);
      update({ room: joined, uncertain: false });
      onJoined(joined.id);
      return true;
    } catch (error) {
      const rejected = error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 408;
      if (attempted && !rejected) uncertainJoins.add(scope);
      if (current() && version === revision) update({ uncertain: uncertainJoins.has(scope), error: invitationError(error),
        notice: attempted && !rejected ? "참여 결과를 확인하지 못했어요. 자동으로 다시 요청하지 않아요. 참여 상태를 먼저 확인해 주세요." : null });
      return false;
    } finally { joining = false; if (version === revision) update({ busy: false }); }
  }
  return {
    getState: () => state, load, join,
    acknowledge: () => {
      if (!current() || state.loading || state.busy || !state.room || state.error) return;
      uncertainJoins.delete(scope);
      update({ uncertain: false, notice: null });
    },
    openJoined: () => { if (current() && !state.loading && !state.busy && state.room?.joined) onJoined(state.room.id); },
    dispose: () => {
      if (joining) uncertainJoins.add(scope);
      disposed = true;
      revision++;
      for (const request of requests) request.abort();
    },
  };
}

export function blockedInvitationReason(reason: string) {
  return ({ ROOM_CLOSED: "종료된 방이에요.", ROOM_FULL: "정원이 가득 찼어요.", BANNED: "이 방의 참여가 제한됐어요." } as Record<string, string>)[reason]
    ?? "현재 이 방에 참여할 수 없어요.";
}
