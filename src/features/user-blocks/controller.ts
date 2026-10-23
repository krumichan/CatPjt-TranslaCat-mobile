import { ApiError } from "../../api/client.ts";
import type { FriendPerson, FriendSearch } from "../friends/service.ts";
import type { UserBlock, UserBlockService } from "./service.ts";

export type BlockConfirmation = { kind: "block" | "unblock"; target: FriendPerson };
export interface BlockState {
  blocks: UserBlock[]; loaded: boolean; pending: "load" | "search" | "block" | "unblock" | null;
  candidate: FriendSearch | null; confirmation: BlockConfirmation | null; needsRefresh: boolean;
  error: string | null; notice: string | null;
}
export const emptyBlockState = (): BlockState => ({
  blocks: [], loaded: false, pending: null, candidate: null, confirmation: null,
  needsRefresh: false, error: null, notice: null,
});

export function blockError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return "로그인이 만료됐어요. 다시 로그인해 주세요.";
    if (error.status === 403) return "이 요청을 처리할 수 없어요. 계정 상태를 확인해 주세요.";
    if (error.status === 404) return "사용자를 찾지 못했어요. TranslaCat ID를 확인해 주세요.";
    if (error.status === 400 || error.status === 409) return "차단 상태가 변경됐거나 처리할 수 없는 대상이에요. 목록을 다시 확인해 주세요.";
  }
  return "연결 또는 응답을 확인하지 못했어요. 다시 확인해 주세요.";
}

export function createUserBlockController({ service, selfId, isCurrent, onChange, onRelationshipsChanged, requestTimeoutMs = 15000 }: {
  service: UserBlockService; selfId: string; isCurrent: () => boolean; onChange: (state: BlockState) => void;
  onRelationshipsChanged: () => void; requestTimeoutMs?: number;
}) {
  let state = emptyBlockState();
  let disposed = false;
  const cancellation = new AbortController();
  // 응답 없는 통신도 제한 시간에 해제한다. 늦은 응답은 소비하고 쓰기를 재전송하지 않는다.
  const request = async <T>(action: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const owned = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: () => void = () => {};
    const interrupted = new Promise<never>((_resolve, reject) => {
      abort = () => { owned.abort(); reject(new Error("BLOCK_REQUEST_INTERRUPTED")); };
      if (cancellation.signal.aborted) abort();
      else cancellation.signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(abort, requestTimeoutMs);
    });
    try {
      return await Promise.race([Promise.resolve().then(() => {
        if (owned.signal.aborted) throw new Error("BLOCK_REQUEST_INTERRUPTED");
        return action(owned.signal);
      }), interrupted]);
    } finally {
      clearTimeout(timer);
      cancellation.signal.removeEventListener("abort", abort);
    }
  };
  const current = () => !disposed && isCurrent();
  const update = (patch: Partial<BlockState>) => {
    if (current()) { state = { ...state, ...patch }; onChange(state); }
  };
  const available = () => current() && state.pending === null;
  const writable = () => available() && state.loaded && !state.needsRefresh;

  return {
    getSnapshot: () => state,
    async load() {
      if (!available()) return;
      update({ pending: "load", confirmation: null, candidate: null, error: null });
      try {
        const blocks = await request(signal => service.list(signal));
        update({ blocks, loaded: true, needsRefresh: false });
      } catch (error) { update({ error: blockError(error), needsRefresh: true }); }
      finally { update({ pending: null }); }
    },
    clearCandidate() { if (available()) update({ candidate: null, confirmation: null, error: null, notice: null }); },
    async search(publicId: string) {
      if (!writable()) return;
      update({ pending: "search", candidate: null, confirmation: null, error: null, notice: null });
      try {
        const candidate = await request(signal => service.search(publicId, signal));
        if (candidate.userId === selfId || candidate.friendStatus === "SELF") {
          update({ error: "내 계정은 차단할 수 없어요." });
        } else update({ candidate });
      } catch (error) { update({ error: blockError(error) }); }
      finally { update({ pending: null }); }
    },
    prepareBlock() {
      const target = state.candidate;
      if (!writable() || !target || target.userId === selfId) return;
      if (state.blocks.some(block => block.user.userId === target.userId)) {
        update({ notice: "이미 차단한 사용자예요. 아래 차단 목록에서 확인해 주세요." }); return;
      }
      update({ confirmation: { kind: "block", target: { ...target } }, error: null, notice: null });
    },
    prepareUnblock(userId: string) {
      const target = state.blocks.find(block => block.user.userId === userId)?.user;
      if (writable() && target) update({ confirmation: { kind: "unblock", target: { ...target } }, error: null, notice: null });
    },
    cancel() { if (available()) update({ confirmation: null }); },
    async confirm() {
      const confirmation = state.confirmation;
      if (!writable() || !confirmation) return;
      const { kind, target } = confirmation;
      update({ pending: kind, confirmation: null, candidate: null, error: null, notice: null, needsRefresh: true });
      let writeFailed = false;
      try {
        // 확인 직후 한 번만 전송한다. 응답 유실 때도 같은 쓰기를 자동 재시도하지 않는다.
        if (kind === "block") await request(signal => service.block(target, signal));
        else await request(signal => service.unblock(target.userId, signal));
      } catch { writeFailed = true; }
      if (!current()) return;
      onRelationshipsChanged();
      try {
        // 성공 응답과 결과 불명 모두 현재 목록으로 보정하며 GET 실패 중에는 추가 쓰기를 막는다.
        const blocks = await request(signal => service.list(signal));
        if (!current()) return;
        const blocked = blocks.some(block => block.user.userId === target.userId);
        const matches = kind === "block" ? blocked : !blocked;
        update({ blocks, loaded: true, needsRefresh: false,
          notice: matches ? (writeFailed ? "현재 차단 목록에서 처리 결과를 확인했어요."
            : kind === "block" ? "사용자를 차단했어요. 기존 친구 관계도 해제돼요." : "차단을 해제했어요. 친구 관계는 자동으로 복원되지 않아요.") : null,
          error: matches ? null : "요청한 상태를 확인하지 못했어요. 현재 목록을 확인하고 다시 선택해 주세요." });
      } catch {
        update({ error: "처리 결과를 확인하지 못했어요. 자동으로 다시 보내지 않아요. 차단 목록을 새로고침해 주세요." });
      } finally { update({ pending: null }); }
    },
    dispose() { disposed = true; cancellation.abort(); },
  };
}


