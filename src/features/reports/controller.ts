import { ApiError } from "../../api/client.ts";
import { reportBody, type ReportInput, type ReportReceipt, type ReportTarget, type ReportReason } from "./service.ts";

export interface ReportState { confirmation: ReportInput | null; pending: boolean; uncertain: boolean; receipt: ReportReceipt | null; error: string | null }
export const emptyReportState = (): ReportState => ({ confirmation: null, pending: false, uncertain: false, receipt: null, error: null });

export function createReportController({ roomId, create, requestId, isCurrent, onChange, timeoutMs = 15000 }: {
  roomId: string; create(roomId: string, input: ReportInput, signal: AbortSignal): Promise<ReportReceipt>;
  requestId(): string; isCurrent(): boolean; onChange(state: ReportState): void; timeoutMs?: number;
}) {
  let state = emptyReportState();
  let disposed = false;
  let revision = 0;
  let inFlight: AbortController | null = null;
  const live = () => !disposed && isCurrent();
  const update = (patch: Partial<ReportState>) => { state = { ...state, ...patch }; if (live()) onChange(state); };
  const prepare = (target: ReportTarget, reason: ReportReason, detail: string) => {
    if (!live() || state.pending || state.uncertain || state.receipt) return;
    const input = { ...target, reason, detail, clientRequestId: requestId() };
    reportBody(input);
    update({ confirmation: input, error: null });
  };
  const confirm = async () => {
    if (!live() || state.pending || !state.confirmation || state.receipt) return;
    const input = state.confirmation;
    const version = ++revision;
    const controller = new AbortController();
    inFlight = controller;
    update({ pending: true, error: null });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => {
      controller.abort(); reject(new ApiError(0, "REPORT_TIMEOUT"));
    }, timeoutMs); });
    try {
      // 같은 사용자의 명시적 재확인만 같은 UUID/본문으로 허용한다. 자동 POST 재시도는 하지 않는다.
      const receipt = await Promise.race([create(roomId, input, controller.signal), deadline]);
      if (live() && revision === version && !controller.signal.aborted) update({ pending: false, uncertain: false, receipt, confirmation: null });
    } catch (failure) {
      if (!live() || revision !== version) return;
      const knownRejection = failure instanceof ApiError && [400, 401, 403, 404, 409, 422, 429].includes(failure.status);
      update({ pending: false, uncertain: !knownRejection, confirmation: knownRejection ? null : input,
        error: knownRejection ? "신고 대상·참여 상태를 확인해 주세요. 내용이 변경됐거나 요청이 제한됐을 수 있어요."
          : "접수 결과를 확인하지 못했어요. 같은 내용의 접수 확인을 누르면 중복 생성 없이 다시 확인해요." });
    } finally { clearTimeout(timer); if (inFlight === controller) inFlight = null; }
  };
  return { prepare, confirm, snapshot: () => state,
    cancel() { if (live() && !state.pending && !state.uncertain) update({ confirmation: null }); },
    attach() { disposed = false; },
    resume() { if (live()) onChange(state); },
    pause() {
      ++revision;
      if (inFlight) {
        inFlight.abort();
        update({ pending: false, uncertain: true, error: "신고 접수 중 화면을 벗어났어요. 동일 신고 접수 확인으로 결과를 확인해 주세요." });
      } else if (!state.uncertain && !state.receipt) update({ confirmation: null });
    },
    dispose() { disposed = true; ++revision; inFlight?.abort(); },
  };
}
