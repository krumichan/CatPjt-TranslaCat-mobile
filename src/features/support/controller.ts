import { ApiError } from "../../api/client.ts";
import { validateSupportCreateInput, validateSupportReplyInput, type SupportInquiry, type SupportInquiryPage, type SupportService } from "./service.ts";

export type { SupportCreateInput } from "./service.ts";
type SupportCreateInput = Parameters<SupportService["create"]>[0];
export type SupportUncertain = { kind: "create" | "reply"; inquiryId: string | null; reviewed: boolean };
export interface SupportState {
  page: SupportInquiryPage | null;
  pageNumber: number;
  detail: SupportInquiry | null;
  pending: "list" | "detail" | "create" | "reply" | null;
  error: string | null;
  notice: string | null;
  uncertain: SupportUncertain | null;
  createRevision: number;
  replyRevision: number;
}
export const emptySupportState = (uncertain: SupportUncertain | null = null): SupportState => ({
  page: null, pageNumber: 0, detail: null, pending: null, error: null, notice: null,
  uncertain: uncertain ? { ...uncertain, reviewed: false } : null, createRevision: 0, replyRevision: 0,
});

export type SupportRevisions = Pick<SupportState, "createRevision" | "replyRevision">;

// 화면 복귀로 새 통신 컨트롤러가 생겨도 같은 작업 화면의 성공 번호는 계속 증가한다.
export function withSupportRevisionOffset(state: SupportState, offset: SupportRevisions): SupportState {
  return { ...state, createRevision: offset.createRevision + state.createRevision,
    replyRevision: offset.replyRevision + state.replyRevision };
}

export function supportError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "SUPPORT_PERSONAL_INQUIRIES_ONLY") return "앱에서는 내 개인 문의만 확인할 수 있어요. 운영자 계정은 웹의 고객지원 문의함을 이용해 주세요.";
    if (error.status === 401) return "로그인이 만료됐어요. 다시 로그인해 주세요.";
    if (error.status === 403) return "이 문의를 확인하거나 변경할 수 없어요.";
    if (error.status === 404) return "문의를 찾지 못했어요. 내 문의 목록을 다시 확인해 주세요.";
    if (error.status === 409) return "문의 상태가 변경됐어요. 내용을 다시 확인해 주세요.";
    if (error.status === 400 || error.status === 422 || error.code === "INVALID_SUPPORT_INPUT") return "제목·내용·문의 유형을 확인해 주세요.";
  }
  return "연결 또는 문의 응답을 확인하지 못했어요. 다시 확인해 주세요.";
}

export function createSupportController({ service, isCurrent, onChange, initialUncertain = null, onUncertainChange = () => {}, requestTimeoutMs = 15000 }: {
  service: SupportService;
  isCurrent: () => boolean;
  onChange: (state: SupportState) => void;
  initialUncertain?: SupportUncertain | null;
  onUncertainChange?: (uncertain: SupportUncertain | null) => void;
  requestTimeoutMs?: number;
}) {
  let state = emptySupportState(initialUncertain);
  let disposed = false;
  const cancellation = new AbortController();
  const current = () => !disposed && isCurrent();
  const update = (patch: Partial<SupportState>) => {
    if (current()) { state = { ...state, ...patch }; onChange(state); }
  };
  const available = () => current() && state.pending === null;
  const writable = () => available() && state.uncertain === null;
  const markUncertain = (uncertain: SupportUncertain | null) => {
    if (!current()) return;
    onUncertainChange(uncertain);
    update({ uncertain });
  };

  // 응답을 보내지 않는 서버와 취소를 무시하는 통신도 끝낸다. 늦은 응답은 UI와 쓰기를 재개하지 않는다.
  const request = async <T>(action: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const owned = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: () => void = () => {};
    const interrupted = new Promise<never>((_resolve, reject) => {
      abort = () => { owned.abort(); reject(new Error("SUPPORT_REQUEST_INTERRUPTED")); };
      if (cancellation.signal.aborted) abort();
      else cancellation.signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(abort, requestTimeoutMs);
    });
    try {
      return await Promise.race([Promise.resolve().then(() => {
        if (owned.signal.aborted || !current()) throw new Error("SUPPORT_REQUEST_INTERRUPTED");
        return action(owned.signal);
      }), interrupted]);
    } finally {
      clearTimeout(timer);
      cancellation.signal.removeEventListener("abort", abort);
    }
  };
  const review = (kind: SupportUncertain["kind"], inquiryId: string | null) => {
    if (state.uncertain?.kind === kind && state.uncertain.inquiryId === inquiryId) {
      markUncertain({ ...state.uncertain, reviewed: true });
    }
  };
  const definiteRejection = (error: unknown) => error instanceof ApiError
    && [400, 401, 403, 404, 409, 422].includes(error.status);

  // 결과 불명인 POST는 재전송하지 않는다. 읽기 결과의 내용이 같아도 성공이라고 추정하지 않는다.
  const reconcile = async (kind: SupportUncertain["kind"], inquiryId: string | null) => {
    try {
      if (kind === "reply" && inquiryId) {
        const detail = await request(signal => service.detail(inquiryId, signal));
        update({ detail });
      } else {
        const page = await request(signal => service.list(0, signal));
        update({ page, pageNumber: 0, detail: null });
      }
      review(kind, inquiryId);
    } catch { /* 확인 조회 실패 때도 결과 불명 잠금과 작성 중인 내용은 유지한다. */ }
    update({ error: "전송 결과를 확인하지 못했어요. 자동으로 다시 보내지 않아요. 목록이나 문의 내용을 확인한 뒤 중복 전송에 주의해 주세요." });
  };

  const controller = {
    getSnapshot: () => state,
    async list(pageNumber = state.pageNumber) {
      if (!available()) return;
      if (!Number.isInteger(pageNumber) || pageNumber < 0 || pageNumber > 2147483647) {
        update({ error: "올바른 문의 목록 페이지를 선택해 주세요." }); return;
      }
      update({ pending: "list", error: null, notice: null, detail: null });
      try {
        const page = await request(signal => service.list(pageNumber, signal));
        update({ page, pageNumber });
        review("create", null);
      } catch (error) { update({ error: supportError(error) }); }
      finally { update({ pending: null }); }
    },
    async open(inquiryId: string) {
      if (!available()) return;
      if (!/^[1-9]\d*$/.test(inquiryId) || !Number.isSafeInteger(Number(inquiryId))) {
        update({ error: "올바른 문의를 선택해 주세요." }); return;
      }
      // 다른 상세 조회가 실패해도 이전 문의의 답글 입력을 새 문의로 오인하지 않게 비운다.
      update({ pending: "detail", detail: null, error: null, notice: null });
      try {
        const detail = await request(signal => service.detail(inquiryId, signal));
        update({ detail });
        review("reply", inquiryId);
      } catch (error) { update({ error: supportError(error) }); }
      finally { update({ pending: null }); }
    },
    async backToList() { await controller.list(state.pageNumber); },
    async create(input: SupportCreateInput) {
      if (!writable()) return;
      let body: SupportCreateInput;
      try { body = validateSupportCreateInput(input); }
      catch { update({ error: "문의 제목은 1~200자, 내용은 1~10,000자로 입력하고 문의 유형을 선택해 주세요." }); return; }
      update({ pending: "create", error: null, notice: null });
      markUncertain({ kind: "create", inquiryId: null, reviewed: false });
      try {
        const detail = await request(signal => service.create(body, signal));
        if (!current()) return;
        markUncertain(null);
        update({ detail, createRevision: state.createRevision + 1, notice: "문의를 보냈어요. 내 문의에서 답변을 확인할 수 있어요." });
      } catch (error) {
        if (!current()) return;
        if (definiteRejection(error)) { markUncertain(null); update({ error: supportError(error) }); }
        else await reconcile("create", null);
      } finally { update({ pending: null }); }
    },
    async reply(content: string) {
      const target = state.detail;
      if (!writable() || !target) return;
      if (target.status === "CLOSED") { update({ error: "종료된 문의에는 내용을 추가할 수 없어요. 새 문의를 작성해 주세요." }); return; }
      let body: Parameters<SupportService["reply"]>[1];
      try { body = validateSupportReplyInput({ content }); }
      catch { update({ error: "추가할 내용을 1~10,000자로 입력해 주세요." }); return; }
      update({ pending: "reply", error: null, notice: null });
      markUncertain({ kind: "reply", inquiryId: target.id, reviewed: false });
      try {
        const detail = await request(signal => service.reply(target.id, body, signal));
        if (!current()) return;
        // 같은 본문의 예전 답글이 재반환돼도 방금 보낸 내용이 처리됐다고 추정하지 않는다.
        const previousIds = new Set(target.replies.map(reply => reply.id));
        if (detail.id !== target.id || detail.replyCount <= target.replyCount
          || !detail.replies.some(reply => !previousIds.has(reply.id) && reply.content === body.content
            && reply.parentId === null)) throw new ApiError(0, "INVALID_API_RESPONSE");
        markUncertain(null);
        update({ detail, replyRevision: state.replyRevision + 1, notice: "문의에 내용을 추가했어요." });
      } catch (error) {
        if (!current()) return;
        if (definiteRejection(error)) { markUncertain(null); update({ error: supportError(error) }); }
        else await reconcile("reply", target.id);
      } finally { update({ pending: null }); }
    },
    acknowledgeUncertain() {
      if (!available() || !state.uncertain?.reviewed) return;
      markUncertain(null);
      update({ error: null, notice: "확인했어요. 이미 반영된 내용은 다시 보내지 않도록 주의해 주세요." });
    },
    dispose() { disposed = true; cancellation.abort(); },
  };
  return controller;
}
