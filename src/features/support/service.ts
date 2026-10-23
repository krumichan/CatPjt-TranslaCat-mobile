import { ApiError, type createApiClient } from "../../api/client.ts";

export const SUPPORT_CATEGORIES = ["GENERAL", "ACCOUNT", "TRANSLATION", "LEARNING", "CHAT", "ACCOUNT_BOOK", "OTHER"] as const;
export const SUPPORT_STATUSES = ["WAITING", "ANSWERED", "CLOSED"] as const;
export const SUPPORT_AUTHOR_ROLES = ["USER", "ADMIN"] as const;
export const SUPPORT_PAGE_SIZE = 20;
export const SUPPORT_TITLE_MAX_LENGTH = 200;
export const SUPPORT_CONTENT_MAX_LENGTH = 10000;

export type SupportCategory = typeof SUPPORT_CATEGORIES[number];
export type SupportStatus = typeof SUPPORT_STATUSES[number];
export type SupportAuthorRole = typeof SUPPORT_AUTHOR_ROLES[number];

export const SUPPORT_CATEGORY_LABELS: Record<SupportCategory, string> = {
  GENERAL: "일반", ACCOUNT: "계정", TRANSLATION: "번역", LEARNING: "학습", CHAT: "채팅", ACCOUNT_BOOK: "가계부", OTHER: "기타",
};
export const SUPPORT_STATUS_LABELS: Record<SupportStatus, string> = { WAITING: "답변 대기", ANSWERED: "답변 완료", CLOSED: "종료" };

export interface SupportReply {
  id: string;
  parentId: string | null;
  content: string;
  authorRole: SupportAuthorRole;
  authorName: string;
  createdAt: string;
}

export interface SupportInquiry {
  id: string;
  ownerId: string;
  title: string;
  content: string;
  category: SupportCategory;
  status: SupportStatus;
  replyCount: number;
  createdAt: string;
  updatedAt: string;
  replies: SupportReply[];
  unread: boolean;
}

export interface SupportInquiryPage {
  items: SupportInquiry[];
  page: number;
  size: number;
  totalElements: number;
  totalPages: number;
}

export interface SupportCreateInput { title: string; content: string; category: SupportCategory }
export interface SupportReplyInput { content: string }

function invalidResponse(): never { throw new ApiError(0, "INVALID_API_RESPONSE"); }
function invalidInput(): never { throw new ApiError(0, "INVALID_SUPPORT_INPUT"); }

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalidResponse();
  return value as Record<string, unknown>;
}

function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return invalidResponse();
  return value;
}

function responseId(value: unknown): string {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return invalidResponse();
  return String(value);
}

function requestId(value: string): number {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) return invalidInput();
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || String(numeric) !== value) return invalidInput();
  return numeric;
}

function responseText(value: unknown, limit?: number): string {
  if (typeof value !== "string" || !value.trim() || (limit !== undefined && value.length > limit)) return invalidResponse();
  return value;
}

function timestamp(value: unknown): string {
  const result = responseText(value, 64);
  // 서버의 LocalDateTime과 ISO 시각만 표시 모델에 허용한다. 원문은 오류에 반사하지 않는다.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})?$/.test(result)
    || !Number.isFinite(Date.parse(result))) return invalidResponse();
  return result;
}

function member<T extends string>(value: unknown, options: readonly T[]): T {
  if (typeof value !== "string" || !options.includes(value as T)) return invalidResponse();
  return value as T;
}

function inputText(value: unknown, limit: number): string {
  // Java @Size와 동일하게 UTF-16 길이를 검사한 후 전송할 주변 공백을 정리한다.
  if (typeof value !== "string" || !value.trim() || value.length > limit) return invalidInput();
  return value.trim();
}

export function validateSupportCreateInput(input: SupportCreateInput): SupportCreateInput {
  if (!input || !SUPPORT_CATEGORIES.includes(input.category)) return invalidInput();
  return { title: inputText(input.title, SUPPORT_TITLE_MAX_LENGTH),
    content: inputText(input.content, SUPPORT_CONTENT_MAX_LENGTH), category: input.category };
}

export function validateSupportReplyInput(input: SupportReplyInput): SupportReplyInput {
  if (!input) return invalidInput();
  return { content: inputText(input.content, SUPPORT_CONTENT_MAX_LENGTH) };
}

function parseReply(value: unknown): SupportReply {
  const dto = object(value);
  return { id: responseId(dto.id), parentId: dto.parentId === null ? null : responseId(dto.parentId),
    content: responseText(dto.content, SUPPORT_CONTENT_MAX_LENGTH), authorRole: member(dto.authorRole, SUPPORT_AUTHOR_ROLES),
    authorName: responseText(dto.authorName), createdAt: timestamp(dto.createdAt) };
}

function parseInquiry(value: unknown, selfId: string, complete: boolean): SupportInquiry {
  // 관리자용 전체 목록 응답이 섞여도 타인의 문의나 이메일을 모바일 모델에 노출하지 않는다.
  const dto = object(value);
  const ownerId = responseId(object(dto.user).id);
  if (ownerId !== selfId) throw new ApiError(0, "SUPPORT_PERSONAL_INQUIRIES_ONLY");
  if (!Array.isArray(dto.replies) || typeof dto.unread !== "boolean") return invalidResponse();
  if (dto.relatedMessageId !== null) responseId(dto.relatedMessageId);
  const replies = dto.replies.map(parseReply);
  const replyCount = count(dto.replyCount);
  if (complete ? replyCount !== replies.length : replies.length !== 0) return invalidResponse();

  // 답변은 서버의 오름차순 ID 및 같은 문의 안의 선행 부모만 허용한다.
  const ids = new Set<string>();
  let previousId = 0;
  for (const reply of replies) {
    if (Number(reply.id) <= previousId || ids.has(reply.id) || (reply.parentId !== null && !ids.has(reply.parentId))) return invalidResponse();
    ids.add(reply.id);
    previousId = Number(reply.id);
  }

  return { id: responseId(dto.id), ownerId, title: responseText(dto.title, SUPPORT_TITLE_MAX_LENGTH),
    content: responseText(dto.content, SUPPORT_CONTENT_MAX_LENGTH), category: member(dto.category, SUPPORT_CATEGORIES),
    status: member(dto.status, SUPPORT_STATUSES), replyCount, createdAt: timestamp(dto.createdAt), updatedAt: timestamp(dto.updatedAt),
    replies, unread: dto.unread };
}

export function createSupportService(api: ReturnType<typeof createApiClient>, selfId: string) {
  requestId(selfId);
  return {
    async list(page = 0, signal?: AbortSignal): Promise<SupportInquiryPage> {
      if (!Number.isSafeInteger(page) || page < 0 || page > 2147483647) return invalidInput();
      const dto = object(await api.request(`/support/inquiries?${new URLSearchParams({ page: String(page), size: String(SUPPORT_PAGE_SIZE) })}`, { signal }));
      if (!Array.isArray(dto.items) || dto.items.length > SUPPORT_PAGE_SIZE
        || count(dto.page) !== page || count(dto.size) !== SUPPORT_PAGE_SIZE) return invalidResponse();
      const totalElements = count(dto.totalElements);
      const totalPages = count(dto.totalPages);
      const items = dto.items.map(value => parseInquiry(value, selfId, false));
      const expectedLength = Math.min(SUPPORT_PAGE_SIZE, Math.max(0, totalElements - page * SUPPORT_PAGE_SIZE));
      if (totalPages !== Math.ceil(totalElements / SUPPORT_PAGE_SIZE) || items.length !== expectedLength
        || new Set(items.map(item => item.id)).size !== items.length) return invalidResponse();
      return { items, page, size: SUPPORT_PAGE_SIZE, totalElements, totalPages };
    },
    async detail(id: string, signal?: AbortSignal): Promise<SupportInquiry> {
      const target = requestId(id);
      // 상세 GET은 서버에서 읽음 처리도 수행하므로 이 계층은 자동 재시도하지 않는다.
      const inquiry = parseInquiry(await api.request(`/support/inquiries/${target}`, { signal }), selfId, true);
      if (inquiry.id !== id) return invalidResponse();
      return inquiry;
    },
    async create(input: SupportCreateInput, signal?: AbortSignal): Promise<SupportInquiry> {
      const body = validateSupportCreateInput(input);
      // relatedMessageId는 고객지원 메시지 전용이다. 채팅 메시지 ID나 추가 입력 필드를 보내지 않는다.
      const inquiry = parseInquiry(await api.request("/support/inquiries", { method: "POST", body, signal }), selfId, true);
      if (inquiry.title !== body.title || inquiry.content !== body.content || inquiry.category !== body.category
        || inquiry.replyCount !== 0 || inquiry.status !== "WAITING") return invalidResponse();
      return inquiry;
    },
    async reply(id: string, input: SupportReplyInput, signal?: AbortSignal): Promise<SupportInquiry> {
      const target = requestId(id);
      const body = validateSupportReplyInput(input);
      // 이번 화면은 평문 후속 답변만 작성한다. parentId·역할·작성자·상태는 전송하지 않는다.
      const inquiry = parseInquiry(await api.request(`/support/inquiries/${target}/replies`, { method: "POST", body, signal }), selfId, true);
      const latestReply = inquiry.replies.at(-1);
      if (inquiry.id !== id || inquiry.status === "CLOSED" || latestReply?.content !== body.content
        || latestReply.parentId !== null) return invalidResponse();
      return inquiry;
    },
  };
}

export type SupportService = ReturnType<typeof createSupportService>;
