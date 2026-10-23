import type { AuthSessionOpenOptions, WebBrowserAuthSessionResult } from "expo-web-browser";

type AuthSessionOpener = (
  url: string,
  redirectUri: string,
  options?: AuthSessionOpenOptions,
) => Promise<WebBrowserAuthSessionResult>;

export function createAuthBrowser(platform: string, openAuthSession: AuthSessionOpener) {
  return (url: string, redirectUri: string) => {
    // Android 인증 탭을 앱과 같은 task에서 열어 callback 복귀 뒤 별도 브라우저 task가 남지 않게 한다.
    // SDK의 URL listener·취소 처리를 그대로 쓰고 별도 dismiss나 중복 callback listener는 추가하지 않는다.
    if (platform === "android") {
      return openAuthSession(url, redirectUri, { createTask: false, useProxyActivity: false });
    }

    // iOS는 ASWebAuthenticationSession의 기존 기본값을 유지한다.
    return openAuthSession(url, redirectUri);
  };
}
