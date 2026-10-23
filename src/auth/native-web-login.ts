import { Platform } from "react-native";

import { ApiError, createApiClient } from "@/api/client";
import { createAuthBrowser } from "@/auth/auth-browser";
import { createMobileWebLogin } from "@/auth/mobile-web-login";
import { runtime } from "@/config/runtime";

export async function loginWithExistingWebsite() {
  if (Platform.OS === "web") throw new ApiError(0, "NATIVE_LOGIN_REQUIRED");
  if (!runtime.apiBaseUrl) throw new ApiError(0, "API_NOT_CONFIGURED");

  // 외부 인증 브라우저와 암호학적 난수를 사용하며 증명을 앱 URL·저장소에 보관하지 않는다.
  const [Crypto, WebBrowser] = await Promise.all([import("expo-crypto"), import("expo-web-browser")]);
  const scheme = runtime.environment === "production" ? "translacat" : runtime.environment === "preview" ? "translacat-preview" : "translacat-dev";
  const login = createMobileWebLogin({
    api: createApiClient({ baseUrl: runtime.apiBaseUrl, accessToken: async () => null }),
    webBaseUrl: runtime.webBaseUrl,
    redirectUri: scheme + "://auth/callback",
    randomBytes: () => Crypto.getRandomBytesAsync(32),
    challenge: async verifier => (await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, verifier, {
      encoding: Crypto.CryptoEncoding.BASE64,
    })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
    openBrowser: createAuthBrowser(Platform.OS, WebBrowser.openAuthSessionAsync),
  });
  return login();
}
