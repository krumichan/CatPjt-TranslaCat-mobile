import type { AccessTokenProvider } from "../auth/token-provider.ts";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly serverCode?: string;
  readonly retryAfterSeconds?: number;

  constructor(status: number, code: string, serverCode?: string, retryAfterSeconds?: number) {
    super(code);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.serverCode = serverCode;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

type RequestOptions = {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  formData?: FormData;
  authenticated?: boolean;
  signal?: AbortSignal;
};

export function createApiClient({
  baseUrl,
  accessToken,
  fetcher = fetch,
  assertCurrentSession,
  onUnauthorized,
}: {
  baseUrl: string | null;
  accessToken: AccessTokenProvider;
  fetcher?: typeof fetch;
  assertCurrentSession?: () => void;
  onUnauthorized?: (failedToken: string) => void;
}) {
  return {
    async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
      // 설정과 경로를 먼저 검사하여 외부 주소로 인증 토큰이 전달되지 않게 한다.
      if (!baseUrl) throw new ApiError(0, "API_NOT_CONFIGURED");
      if (!path.startsWith("/") || path.startsWith("//")) {
        throw new ApiError(0, "INVALID_API_PATH");
      }
      if (options.formData !== undefined && (options.body !== undefined
        || typeof FormData === "undefined" || !(options.formData instanceof FormData))) {
        throw new ApiError(0, "INVALID_MULTIPART_BODY");
      }
      const base = new URL(baseUrl.replace(/\/$/, "") + "/");
      const url = new URL(path.slice(1), base);
      if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)
        || url.username || url.password || url.hash) {
        throw new ApiError(0, "INVALID_API_PATH");
      }

      // 계정 전환과 refresh 처리는 token provider가 소유한다. 클라이언트에서 자동 재시도하지 않는다.
      const headers = new Headers({ Accept: "application/json" });
      let requestToken: string | null = null;
      if (options.authenticated !== false) {
        assertCurrentSession?.();
        const token = await accessToken();
        requestToken = token;
        assertCurrentSession?.();
        if (!token) throw new ApiError(401, "SIGN_IN_REQUIRED");
        headers.set("Authorization", "Bearer " + token);
      }
      // multipart boundary는 네이티브 fetch가 파일과 함께 만든다. JSON 요청의 기존 헤더는 유지한다.
      if (options.body !== undefined) headers.set("Content-Type", "application/json");

      let response: Response;
      try {
        response = await fetcher(url, {
          method: options.method ?? "GET",
          headers,
          body: options.formData ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
          signal: options.signal,
          redirect: "error",
        });
      } catch {
        throw new ApiError(0, options.signal?.aborted ? "REQUEST_ABORTED" : "NETWORK_UNAVAILABLE");
      }
      if (options.authenticated !== false) assertCurrentSession?.();
      // 원문 오류와 사용자 메시지는 Error 및 로그에 반사하지 않는다.
      if (!response.ok) {
        if (response.status === 401 && requestToken) onUnauthorized?.(requestToken);
        let serverCode: string | undefined;
        let retryAfterSeconds: number | undefined;
        try {
          const failure = await response.json() as { body?: { errorCode?: unknown; retryAfterSeconds?: unknown } };
          const allowed = new Set([
            "AUTH_INVALID_CREDENTIALS", "AUTH_INVALID_INPUT", "AUTH_EMAIL_INVALID", "AUTH_PASSWORD_INVALID",
            "AUTH_PASSWORD_ATTEMPTS_EXCEEDED", "AUTH_TOKEN_INVALID", "INVALID_REFRESH_TOKEN", "REFRESH_TOKEN_EXPIRED",
            "AUTH_EMAIL_ALREADY_REGISTERED", "ACCOUNT_ALREADY_EXISTS", "ACCOUNT_LINK_REQUIRED", "REGISTRATION_CONFLICT",
            "AUTH_EMAIL_ACCOUNT_MISMATCH", "AUTH_EMAIL_SEND_FAILED", "AUTH_EMAIL_CHALLENGE_REPLACED",
            "AUTH_EMAIL_RESEND_TOO_SOON", "AUTH_EMAIL_HOURLY_LIMIT", "AUTH_EMAIL_DAILY_LIMIT",
            "AUTH_EMAIL_CODE_UNAVAILABLE", "AUTH_EMAIL_CODE_EXPIRED", "AUTH_EMAIL_CODE_ATTEMPTS_EXCEEDED",
            "AUTH_EMAIL_CODE_INVALID", "AUTH_EMAIL_VERIFICATION_INVALID", "AUTH_EMAIL_UNAVAILABLE", "AUTH_PASSWORD_RESET_INVALID",
            "AUTH_NICKNAME_INVALID", "AUTH_BIRTH_DATE_INVALID",
            "OPEN_INVITATION_INVALID_REQUEST", "OPEN_INVITATION_NOT_ALLOWED", "OPEN_INVITATION_REQUEST_CONFLICT",
            "OPEN_INVITATION_RATE_LIMITED", "OPEN_INVITATION_ROOM_CLOSED", "OPEN_INVITATION_MEMBER_ACCESS_DENIED",
            "OPEN_INVITATION_TARGET_UNAVAILABLE", "OPEN_INVITATION_NOT_FOUND",
          ]);
          if (typeof failure?.body?.errorCode === "string" && allowed.has(failure.body.errorCode)) serverCode = failure.body.errorCode;
          const retry = failure?.body?.retryAfterSeconds;
          if (typeof retry === "number" && Number.isInteger(retry) && retry >= 0 && retry <= 86400) retryAfterSeconds = retry;
        } catch { /* 빈 인증 거절 응답도 안전한 HTTP 오류로 처리한다. */ }
        throw new ApiError(response.status, "HTTP_" + response.status, serverCode, retryAfterSeconds);
      }
      if (response.status === 204) return undefined as T;
      let envelope: unknown;
      try { envelope = await response.json(); } catch { throw new ApiError(response.status, "INVALID_API_RESPONSE"); }
      if (options.authenticated !== false) assertCurrentSession?.();
      if (!envelope || typeof envelope !== "object" || !("body" in envelope)) {
        throw new ApiError(response.status, "INVALID_API_RESPONSE");
      }
      return (envelope as { body: T }).body;
    },
  };
}
