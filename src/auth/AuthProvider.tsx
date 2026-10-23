import { useQueryClient } from "@tanstack/react-query";
import * as SecureStore from "expo-secure-store";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { Platform } from "react-native";

import { ApiError, createApiClient } from "@/api/client";
import { AuthSession, type SessionStorage, type SessionTransport, type SessionUser, type TokenPair } from "@/auth/session";
import { runtime } from "@/config/runtime";
import { loginWithExistingWebsite } from "@/auth/native-web-login";

// 같은 개발 앱에서 API 서버를 바꾸어도 다른 서버로 저장 토큰을 전송하지 않는다.
const serverKey = Array.from(runtime.apiBaseUrl ?? "unconfigured").map(character => character.codePointAt(0)!.toString(16)).join("_");
const STORAGE_KEY = "translacat.auth.refresh.v1." + runtime.environment + "." + serverKey;

function createStorage(): SessionStorage {
  // 웹 미리보기는 메모리만 쓰며 브라우저 저장소에 native refresh를 보관하지 않는다.
  if (Platform.OS === "web") {
    let value: string | null = null;
    return { read: async () => value, write: async next => { value = next; }, remove: async () => { value = null; } };
  }
  const options = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
  return {
    read: () => SecureStore.getItemAsync(STORAGE_KEY, options),
    write: value => SecureStore.setItemAsync(STORAGE_KEY, value, options),
    remove: () => SecureStore.deleteItemAsync(STORAGE_KEY, options),
  };
}

function createTransport(): SessionTransport {
  const anonymous = createApiClient({ baseUrl: runtime.apiBaseUrl, accessToken: async () => null });
  const authenticated = (token: string) => createApiClient({ baseUrl: runtime.apiBaseUrl, accessToken: async () => token });
  return {
    login: (email, password) => anonymous.request<TokenPair>("/auth/login", {
      method: "POST", authenticated: false, body: { email, password },
    }),
    refresh: refreshToken => anonymous.request<TokenPair>("/auth/token/refresh", {
      method: "POST", authenticated: false, body: { refreshToken },
    }),
    profile: async token => {
      const profile = await authenticated(token).request<{
        userId: unknown; publicId: unknown; nickname: unknown;
      }>("/users/me/profile");
      if (!profile || typeof profile.userId !== "number" || !Number.isSafeInteger(profile.userId)
        || profile.userId <= 0 || typeof profile.publicId !== "string" || !profile.publicId
        || typeof profile.nickname !== "string") throw new ApiError(0, "INVALID_AUTH_RESPONSE");
      return { id: String(profile.userId), publicId: profile.publicId, name: profile.nickname, email: "" } satisfies SessionUser;
    },
    logout: async token => { await authenticated(token).request("/auth/logout", { method: "POST" }); },
  };
}

type AuthContextValue = ReturnType<typeof useAuthState>;
const AuthContext = createContext<AuthContextValue | null>(null);

function useAuthState() {
  const queryClient = useQueryClient();
  const [releaseListeners] = useState(() => new Set<(accessToken: string, sessionKey: string) => Promise<void>>());
  const [session] = useState(() => new AuthSession(createStorage(), createTransport(), Date.now, () => {
    // 새 계정 화면이 조회를 시작하기 전에 이전 요청과 cache를 정리한다.
    void queryClient.cancelQueries();
    queryClient.clear();
  }, async (accessToken, sessionKey) => {
    // 캡처된 세션으로만 부가 등록을 해제하고, 실패해도 본래 sid 폐기는 계속 진행한다.
    await Promise.allSettled(Array.from(releaseListeners, listener => listener(accessToken, sessionKey)));
  }));
  const registerSessionRelease = useCallback((listener: (accessToken: string, sessionKey: string) => Promise<void>) => {
    releaseListeners.add(listener);
    return () => { releaseListeners.delete(listener); };
  }, [releaseListeners]);
  const isCurrentSession = useCallback((key: string | null) => {
    const current = session.getSnapshot();
    return key !== null && current.status === "signedIn" && current.sessionKey === key;
  }, [session]);
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const api = useMemo(() => {
    const sessionKey = snapshot.sessionKey;
    return createApiClient({
      baseUrl: runtime.apiBaseUrl,
      accessToken: session.accessToken,
      assertCurrentSession: () => {
        if (session.getSnapshot().sessionKey !== sessionKey) throw new ApiError(0, "SESSION_CHANGED");
      },
      onUnauthorized: session.rejectCurrent,
    });
  }, [session, snapshot.sessionKey]);

  useEffect(() => { void session.restore(); }, [session]);
  return {
    ...snapshot, api, accessToken: session.accessToken, registerSessionRelease, isCurrentSession,
    signIn: session.signIn, signOut: session.signOut, retryRestore: session.restore,
    signInWithGoogle: () => session.signInExternal(loginWithExistingWebsite),
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const value = useAuthState();
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("AUTH_PROVIDER_REQUIRED");
  return value;
}
