import { ApiError, type createApiClient } from "../api/client.ts";
import type { TokenPair } from "./session.ts";

const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function base64Url(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let result = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 6) { bits -= 6; result += BASE64URL[(value >>> bits) & 63]; }
    value &= (1 << bits) - 1;
  }
  if (bits) result += BASE64URL[(value << (6 - bits)) & 63];
  return result;
}

export function createMobileWebLogin({ api, webBaseUrl, redirectUri, randomBytes, challenge, openBrowser }: {
  api: ReturnType<typeof createApiClient>;
  webBaseUrl: string;
  redirectUri: string;
  randomBytes: () => Promise<Uint8Array>;
  challenge: (verifier: string) => Promise<string>;
  openBrowser: (url: string, redirect: string) => Promise<{ type: string; url?: string }>;
}) {
  return async (): Promise<TokenPair> => {
    // 시작 주소·복귀 주소는 앱 설정에서만 정하며 서버 응답으로 대체하지 않는다.
    const web = new URL(webBaseUrl);
    const redirect = new URL(redirectUri);
    if (web.protocol !== "https:" || web.username || web.password || web.search || web.hash || web.pathname !== "/"
      || !["translacat-dev://auth/callback", "translacat-preview://auth/callback", "translacat://auth/callback"].includes(redirectUri)
      || !["translacat-dev:", "translacat-preview:", "translacat:"].includes(redirect.protocol)
      || redirect.hostname !== "auth" || redirect.pathname !== "/callback"
      || redirect.username || redirect.password || redirect.port || redirect.search || redirect.hash) {
      throw new ApiError(0, "INVALID_MOBILE_AUTH_CONFIG");
    }
    const [verifierBytes, stateBytes] = await Promise.all([randomBytes(), randomBytes()]);
    if (verifierBytes.length !== 32 || stateBytes.length !== 32) throw new ApiError(0, "INVALID_MOBILE_AUTH_PROOF");
    const codeVerifier = base64Url(verifierBytes);
    const state = base64Url(stateBytes);
    const codeChallenge = await challenge(codeVerifier);
    if (!/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) throw new ApiError(0, "INVALID_MOBILE_AUTH_PROOF");

    const request = await api.request<{ requestId: string; expiresIn: number }>("/auth/mobile/requests", {
      method: "POST", authenticated: false, body: { codeChallenge, state, redirectUri },
    });
    if (!request || !UUID.test(request.requestId) || !Number.isInteger(request.expiresIn)
      || request.expiresIn <= 0 || request.expiresIn > 300) throw new ApiError(0, "INVALID_MOBILE_AUTH_RESPONSE");
    web.pathname = "/ko/mobile/sign-in";
    web.searchParams.set("requestId", request.requestId);
    const result = await openBrowser(web.toString(), redirectUri);
    if (result.type !== "success" || !result.url) throw new ApiError(0, "MOBILE_AUTH_CANCELLED");
    if (result.url.length > 1024 || !result.url.startsWith(redirectUri + "?")) throw new ApiError(0, "INVALID_MOBILE_AUTH_CALLBACK");

    // 잘못된 scheme·경로·중복 파라미터·state·요청 ID를 거부하고 일회 코드만 교환한다.
    let callback: URL;
    try { callback = new URL(result.url); } catch { throw new ApiError(0, "INVALID_MOBILE_AUTH_CALLBACK"); }
    const names = ["code", "state", "requestId"];
    if (callback.protocol !== redirect.protocol || callback.hostname !== redirect.hostname
      || callback.pathname !== redirect.pathname || callback.port || callback.username || callback.password || callback.hash
      || names.some(name => callback.searchParams.getAll(name).length !== 1)
      || Array.from(callback.searchParams.keys()).some(name => !names.includes(name))
      || callback.searchParams.get("state") !== state || callback.searchParams.get("requestId") !== request.requestId) {
      throw new ApiError(0, "INVALID_MOBILE_AUTH_CALLBACK");
    }
    const code = callback.searchParams.get("code")!;
    if (!/^[A-Za-z0-9_-]{43}$/.test(code)) throw new ApiError(0, "INVALID_MOBILE_AUTH_CALLBACK");
    return api.request<TokenPair>("/auth/mobile/exchange", {
      method: "POST", authenticated: false, body: { requestId: request.requestId, code, codeVerifier },
    });
  };
}
