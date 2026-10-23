import { ApiError } from "../../api/client.ts";
import { parseDeletionReceipt, parseDeletionStatus, type DeletionReceipt, type DeletionStatus } from "./contracts.ts";

export interface DeletionState {
  receipt: DeletionReceipt | null;
  status: DeletionStatus | null;
  pending: "restore" | "prepare" | "browser" | "status" | "forget" | null;
  error: string | null;
  notice: string | null;
}
export const emptyDeletionState = (): DeletionState => ({ receipt: null, status: null, pending: "restore", error: null, notice: null });

export function createDeletionController({ storage, createReceipt, readStatus, openBrowser, current, onChange, onAccepted, requestTimeoutMs = 15000 }: {
  storage: { read(): Promise<string | null>; write(value: string): Promise<void>; remove(): Promise<void> };
  createReceipt(publicId: string): Promise<DeletionReceipt>;
  readStatus(receipt: DeletionReceipt, signal: AbortSignal): Promise<unknown>;
  openBrowser(receipt: DeletionReceipt): Promise<void>;
  current(): boolean;
  onChange(state: DeletionState): void;
  onAccepted(publicId: string): Promise<void>;
  requestTimeoutMs?: number;
}) {
  let state = emptyDeletionState();
  let disposed = false;
  let revision = 0;
  let restored = false;
  const inFlight = new Set<AbortController>();
  const active = () => !disposed && current();
  const publish = (patch: Partial<DeletionState>) => {
    state = { ...state, ...patch };
    if (active()) onChange(state);
  };
  const owned = (version: number) => active() && revision === version;

  const restore = async () => {
    const version = ++revision;
    restored = false;
    publish({ pending: "restore", error: null });
    try {
      const saved = await storage.read();
      if (!owned(version)) return;
      const receipt = saved === null ? null : parseDeletionReceipt(JSON.parse(saved));
      restored = true;
      publish({ receipt, status: null, pending: null });
    } catch {
      if (owned(version)) publish({ pending: null, error: "삭제 확인 정보를 불러오지 못했어요. 저장소를 확인한 뒤 다시 열어 주세요." });
    }
  };
  const check = async () => {
    if (!active() || state.pending !== null || !state.receipt) return;
    const receipt = state.receipt;
    const version = ++revision;
    const controller = new AbortController();
    inFlight.add(controller);
    let rejectDeadline: (() => void) | undefined;
    const deadline = new Promise<never>((_resolve, reject) => { rejectDeadline = () => reject(new ApiError(0, "DELETION_STATUS_TIMEOUT")); });
    const timer = setTimeout(() => { controller.abort(); rejectDeadline?.(); }, requestTimeoutMs);
    publish({ pending: "status", error: null, notice: null });
    try {
      // 로그인 자격 없이 상태 영수증만 전송한다. 이 컨트롤러에는 탈퇴 POST 권한이 없다.
      const status = parseDeletionStatus(await Promise.race([readStatus(receipt, controller.signal), deadline]), receipt.operationId);
      if (!owned(version) || controller.signal.aborted) return;
      publish({ status, pending: null });
      await onAccepted(receipt.expectedPublicId);
    } catch (failure) {
      if (!owned(version)) return;
      publish({ pending: null, error: null, notice: failure instanceof ApiError && failure.status === 404
        ? "아직 접수되지 않았거나 영수증 조회 기간이 지났어요. 삭제를 시작하지 않았다면 아래 본인 확인 화면에서 이어갈 수 있어요."
        : "처리 상태를 확인하지 못했어요. 연결을 확인하고 다시 눌러 주세요. 삭제 요청은 자동으로 보내지 않아요." });
    } finally {
      clearTimeout(timer);
      inFlight.delete(controller);
    }
  };
  const begin = async (publicId: string) => {
    if (!active() || !restored || state.pending !== null || state.status !== null) return;
    const version = ++revision;
    publish({ pending: "prepare", error: null, notice: null });
    try {
      const receipt = state.receipt ?? parseDeletionReceipt(await createReceipt(publicId));
      if (!owned(version)) return;
      if (receipt.expectedPublicId !== publicId) throw new ApiError(0, "DELETION_ACCOUNT_MISMATCH");

      // 앱 종료·응답 유실에도 조회할 수 있게 브라우저를 열기 전에 기기 보안 저장소 기록을 확인한다.
      await storage.write(JSON.stringify(receipt));
      const persisted = parseDeletionReceipt(JSON.parse((await storage.read()) ?? "null"));
      if (persisted.operationId !== receipt.operationId || persisted.receiptSecret !== receipt.receiptSecret
        || persisted.expectedPublicId !== receipt.expectedPublicId) throw new ApiError(0, "DELETION_STORAGE_FAILED");
      if (!owned(version)) return;
      publish({ receipt, pending: "browser" });
      await openBrowser(receipt);
      if (owned(version)) publish({ pending: null });
    } catch (failure) {
      if (owned(version)) publish({ pending: null, error: failure instanceof ApiError && failure.code === "DELETION_ACCOUNT_MISMATCH"
        ? "이 기기에 다른 계정의 삭제 확인 정보가 있어요. 해당 계정으로 로그인하거나 기존 요청 상태를 먼저 확인해 주세요."
        : "본인 확인 화면을 열지 못했어요. 삭제 영수증을 보관할 수 있는지와 연결 상태를 확인해 주세요." });
      if (failure instanceof ApiError && failure.code === "DELETION_ACCOUNT_MISMATCH") return;
    }
    if (owned(version) && state.receipt) await check();
  };

  const forget = async () => {
    if (!active() || state.pending !== null) return;
    const version = ++revision;
    inFlight.forEach(controller => controller.abort());
    publish({ pending: "forget", error: null });
    try {
      // 사용자가 확인한 기기 영수증만 지운다. 서버 삭제 작업을 취소하거나 재전송하지 않는다.
      await storage.remove();
      if (await storage.read() !== null) throw new Error("DELETION_STORAGE_FAILED");
      if (!owned(version)) return;
      restored = true;
      publish({ receipt: null, status: null, pending: null, notice: "이 기기의 영수증을 지웠어요. 서버에 접수된 삭제 처리는 계속 진행돼요." });
    } catch {
      if (owned(version)) publish({ pending: null, error: "영수증을 지우지 못했어요. 기기 저장소를 확인해 주세요." });
    }
  };

  return { restore, begin, check, forget, snapshot: () => state,
    attach() { disposed = false; },
    dispose() { disposed = true; ++revision; inFlight.forEach(controller => controller.abort()); inFlight.clear(); },
  };
}
