import { ApiError } from "../../api/client.ts";
import { record, text } from "../../domain/chat/contracts.ts";

export interface DeletionReceipt {
  operationId: string;
  receiptSecret: string;
  expectedPublicId: string;
  returnScheme: "translacat-dev" | "translacat-preview" | "translacat";
}
export interface DeletionStatus {
  operationId: string;
  status: "PENDING" | "COMPLETED";
  requestedAtUtc: string;
  completedAtUtc: string | null;
  receiptExpiresAtUtc: string | null;
}

export function parseDeletionReceipt(value: unknown): DeletionReceipt {
  const dto = record(value);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(text(dto.operationId))
    || !/^[A-Za-z0-9_-]{43}$/.test(text(dto.receiptSecret))
    || !/^[A-Za-z0-9_-]{1,80}$/.test(text(dto.expectedPublicId))
    || !["translacat-dev", "translacat-preview", "translacat"].includes(text(dto.returnScheme))) {
    throw new ApiError(0, "INVALID_DELETION_RECEIPT");
  }
  return { operationId: dto.operationId as string, receiptSecret: dto.receiptSecret as string,
    expectedPublicId: dto.expectedPublicId as string, returnScheme: dto.returnScheme as DeletionReceipt["returnScheme"] };
}

export function parseDeletionStatus(value: unknown, operationId: string): DeletionStatus {
  const dto = record(value);
  const date = (item: unknown): item is string => typeof item === "string" && Number.isFinite(Date.parse(item));
  if (dto.operationId !== operationId || !["PENDING", "COMPLETED"].includes(text(dto.status))
    || !date(dto.requestedAtUtc) || (dto.completedAtUtc !== null && !date(dto.completedAtUtc))
    || (dto.receiptExpiresAtUtc !== null && !date(dto.receiptExpiresAtUtc))
    || (dto.status === "COMPLETED" && (dto.completedAtUtc === null || dto.receiptExpiresAtUtc === null))) {
    throw new ApiError(0, "INVALID_DELETION_STATUS");
  }
  return { operationId, status: dto.status as DeletionStatus["status"], requestedAtUtc: dto.requestedAtUtc,
    completedAtUtc: dto.completedAtUtc as string | null, receiptExpiresAtUtc: dto.receiptExpiresAtUtc as string | null };
}

export function deletionBrowserUrl(webBaseUrl: string, receipt: DeletionReceipt): string {
  const valid = parseDeletionReceipt(receipt);
  const base = new URL(webBaseUrl);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash || base.pathname !== "/") {
    throw new ApiError(0, "INVALID_DELETION_WEBSITE");
  }
  const url = new URL("/ko/account-deletion", base);
  // fragment는 HTTP 요청·referrer에 실리지 않고 페이지가 즉시 URL에서 제거한다. 인증 토큰은 포함하지 않는다.
  url.hash = new URLSearchParams({ ...valid }).toString();
  return url.toString();
}

export function validDeletionCallback(url: string, receipt: DeletionReceipt): boolean {
  try {
    const result = new URL(url);
    return result.protocol === receipt.returnScheme + ":" && result.hostname === "account-deletion"
      && (result.pathname === "" || result.pathname === "/") && !result.hash && !result.username && !result.password
      && Array.from(result.searchParams.keys()).length === 1 && result.searchParams.get("operationId") === receipt.operationId;
  } catch { return false; }
}

export function receiptSecret(bytes: Uint8Array): string {
  if (bytes.length !== 32) throw new ApiError(0, "INVALID_RANDOM_SOURCE");
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let result = "";
  for (let offset = 0; offset < bytes.length; offset += 3) {
    const number = (bytes[offset] << 16) | ((bytes[offset + 1] ?? 0) << 8) | (bytes[offset + 2] ?? 0);
    result += alphabet[(number >>> 18) & 63] + alphabet[(number >>> 12) & 63];
    if (offset + 1 < bytes.length) result += alphabet[(number >>> 6) & 63];
    if (offset + 2 < bytes.length) result += alphabet[number & 63];
  }
  return result;
}
