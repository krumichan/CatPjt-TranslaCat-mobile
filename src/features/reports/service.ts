import type { createApiClient } from "../../api/client.ts";
import { ChatContractError, flag, record, safeId, text, wireId } from "../../domain/chat/contracts.ts";

export const reportReasons = [
  ["SPAM", "스팸·광고"], ["HARASSMENT", "괴롭힘·욕설"], ["HATE", "혐오·차별"], ["SEXUAL", "성적·선정적 내용"],
  ["ILLEGAL", "불법 행위"], ["PERSONAL_INFORMATION", "개인정보 노출"], ["OTHER", "기타"],
] as const;
export type ReportReason = typeof reportReasons[number][0];
export type ReportTarget = { targetType: "MESSAGE"; messageId: string }
  | { targetType: "MEMBER"; targetOpenChatMemberId: string } | { targetType: "MEMBER"; targetUserId: string };
export type ReportInput = ReportTarget & { reason: ReportReason; detail: string; clientRequestId: string };
export interface ReportReceipt { id: string; roomId: string; targetType: "MESSAGE" | "MEMBER"; reason: ReportReason;
  status: "PENDING" | "IN_REVIEW" | "RESOLVED" | "DISMISSED"; createdAt: string; evidenceExpiresAt: string; duplicate: boolean }

export function reportTarget(query: Record<string, unknown>): ReportTarget {
  const selected = ["messageId", "targetOpenChatMemberId", "targetUserId"].filter(key => query[key] !== undefined);
  if (selected.length !== 1 || selected.some(key => typeof query[key] !== "string")) throw new ChatContractError("INVALID_REPORT_TARGET");
  const key = selected[0];
  const value = String(query[key]);
  wireId(value);
  if (key === "messageId") return { targetType: "MESSAGE", messageId: value };
  return key === "targetOpenChatMemberId" ? { targetType: "MEMBER", targetOpenChatMemberId: value } : { targetType: "MEMBER", targetUserId: value };
}

export function reportBody(input: ReportInput) {
  if (!reportReasons.some(([reason]) => reason === input.reason) || typeof input.detail !== "string" || input.detail.length > 2000
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.clientRequestId)) throw new ChatContractError("INVALID_REPORT_INPUT");
  const target = reportTarget(input);
  if (target.targetType !== input.targetType) throw new ChatContractError("INVALID_REPORT_INPUT");
  return { targetType: target.targetType, ...(target.targetType === "MESSAGE" ? { messageId: wireId(target.messageId) }
    : "targetOpenChatMemberId" in target ? { targetOpenChatMemberId: wireId(target.targetOpenChatMemberId) } : { targetUserId: wireId(target.targetUserId) }),
  reason: input.reason, detail: input.detail.trim() || undefined, clientRequestId: input.clientRequestId };
}

export function createReportService(api: ReturnType<typeof createApiClient>) {
  return { async create(roomId: string, input: ReportInput, signal?: AbortSignal): Promise<ReportReceipt> {
    const body = reportBody(input);
    const dto = record(await api.request(`/chat/rooms/${wireId(roomId)}/reports`, { method: "POST", body, signal }));
    if (safeId(dto.roomId) !== roomId || dto.targetType !== input.targetType || dto.reason !== input.reason
      || !["PENDING", "IN_REVIEW", "RESOLVED", "DISMISSED"].includes(text(dto.status))
      || !Number.isFinite(Date.parse(text(dto.createdAt))) || !Number.isFinite(Date.parse(text(dto.evidenceExpiresAt)))) throw new ChatContractError();
    return { id: safeId(dto.id), roomId, targetType: input.targetType, reason: input.reason,
      status: dto.status as ReportReceipt["status"], createdAt: text(dto.createdAt), evidenceExpiresAt: text(dto.evidenceExpiresAt), duplicate: flag(dto.duplicate) };
  } };
}
