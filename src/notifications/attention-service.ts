import { ApiError, type createApiClient } from "../api/client.ts";
import { ChatContractError, count, record } from "../domain/chat/contracts.ts";

export type NotificationAttention = {
  unreadChatMessageCount: number;
  unreadChatRoomCount: number;
  unreadActivityCount: number;
  totalAttentionCount: number;
};

export const attentionKey = (sessionKey: string | null) => ["notification-attention", sessionKey] as const;

export function parseNotificationAttention(value: unknown): NotificationAttention {
  const dto = record(value);
  const summary = {
    unreadChatMessageCount: count(dto.unreadChatMessageCount),
    unreadChatRoomCount: count(dto.unreadChatRoomCount),
    unreadActivityCount: count(dto.unreadActivityCount),
    totalAttentionCount: count(dto.totalAttentionCount),
  };
  if (summary.unreadChatRoomCount > summary.unreadChatMessageCount
    || summary.unreadChatMessageCount + summary.unreadActivityCount !== summary.totalAttentionCount) {
    throw new ChatContractError();
  }
  return summary;
}

export function createAttentionService(api: ReturnType<typeof createApiClient>, timeoutMs = 15000) {
  return {
    async summary(signal?: AbortSignal): Promise<NotificationAttention> {
      const cancellation = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let abort = () => {};
      // 토큰 복원 대기도 제한하고, 늦게 끝난 이전 요청은 결과로 사용하지 않는다.
      const deadline = new Promise<never>((_, reject) => {
        abort = () => { cancellation.abort(); reject(new ApiError(0, "REQUEST_ABORTED")); };
        if (signal?.aborted) { abort(); return; }
        signal?.addEventListener("abort", abort, { once: true });
        timer = setTimeout(() => { cancellation.abort(); reject(new ApiError(0, "REQUEST_TIMEOUT")); }, timeoutMs);
      });
      try {
        const value = await Promise.race([deadline, Promise.resolve().then(() => {
          if (cancellation.signal.aborted) throw new ApiError(0, "REQUEST_ABORTED");
          return api.request("/chat/notifications/summary", { signal: cancellation.signal });
        })]);
        if (cancellation.signal.aborted) throw new ApiError(0, "REQUEST_ABORTED");
        return parseNotificationAttention(value);
      } finally {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      }
    },
  };
}
