import { ApiError, type createApiClient } from "../api/client.ts";
import type { PushInstallation } from "./installation.ts";

export type PushRegistration = {
  installationId: string; accountBindingId: string; generation: number; tokenVersion: number;
};
export type PushConfiguration = {
  platform: "android" | "ios"; appEnvironment: "development" | "preview" | "production"; projectId: string;
};
export type PushRegistry = {
  register(installation: PushInstallation, expoPushToken: string): Promise<PushRegistration>;
  disable(installation: PushInstallation): Promise<void>;
};

export function isExpoPushToken(value: unknown): value is string {
  return typeof value === "string" && /^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]{1,256}\]$/.test(value);
}

export function createPushRegistry(api: ReturnType<typeof createApiClient>, config: PushConfiguration): PushRegistry {
  async function bounded<T>(path: string, method: "PUT" | "DELETE", body: unknown): Promise<T> {
    const cancellation = new AbortController();
    const timer = setTimeout(() => cancellation.abort(), 12_000);
    try { return await api.request<T>(path, { method, body, signal: cancellation.signal }); }
    finally { clearTimeout(timer); }
  }

  return {
    async register(installation, expoPushToken) {
      if (!isExpoPushToken(expoPushToken)) throw new ApiError(0, "INVALID_PUSH_TOKEN");
      const response = await bounded<PushRegistration>(`/users/me/push-installations/${installation.installationId}`, "PUT", {
        provider: "expo", expoPushToken, ...config,
        installationProof: installation.installationProof, generation: installation.generation,
      });
      // 서버의 opaque binding만 계정 경계에 연결한다. 로컬 sessionKey나 사용자 ID를 대체 값으로 쓰지 않는다.
      if (!response || response.installationId !== installation.installationId
        || response.generation !== installation.generation || !Number.isSafeInteger(response.tokenVersion) || response.tokenVersion < 1
        || typeof response.accountBindingId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(response.accountBindingId)) {
        throw new ApiError(0, "INVALID_PUSH_REGISTRATION");
      }
      return {
        installationId: response.installationId, accountBindingId: response.accountBindingId,
        generation: response.generation, tokenVersion: response.tokenVersion,
      };
    },
    async disable(installation) {
      await bounded(`/users/me/push-installations/${installation.installationId}`, "DELETE", {
        installationProof: installation.installationProof, generation: installation.generation,
      });
    },
  };
}
