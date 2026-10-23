import Constants, { ExecutionEnvironment } from "expo-constants";
import * as Crypto from "expo-crypto";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { AndroidImportance } from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

import { runtime } from "@/config/runtime";
import { createDeviceAcquisition } from "@/notifications/acquisition";
import { InstallationIdentity } from "@/notifications/installation";

export function createNativeInstallation() {
  const scope = [runtime.environment, runtime.projectId, runtime.apiBaseUrl].join("|");
  const key = "translacat.push.installation.v1." + Array.from(scope).map(value => value.codePointAt(0)!.toString(16)).join("_");
  const options = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
  return new InstallationIdentity({
    read: () => SecureStore.getItemAsync(key, options),
    write: value => SecureStore.setItemAsync(key, value, options),
  }, async () => ({
    installationId: Crypto.randomUUID(),
    installationProof: Array.from(await Crypto.getRandomBytesAsync(32), byte => byte.toString(16).padStart(2, "0")).join(""),
  }));
}

export const acquireNativePushToken = createDeviceAcquisition({
  supported: () => Platform.OS !== "web" && Device.isDevice && !!runtime.projectId
    && Constants.executionEnvironment !== ExecutionEnvironment.StoreClient,
  ensureChannel: async () => {
    if (Platform.OS === "android") await Notifications.setNotificationChannelAsync("chat-messages", {
      name: "채팅 메시지", importance: AndroidImportance.HIGH,
    });
  },
  permission: Notifications.getPermissionsAsync,
  requestPermission: Notifications.requestPermissionsAsync,
  expoToken: async nativeToken => {
    // listener의 token은 FCM/APNs 주소다. Expo 토큰으로 변환한 결과만 등록한다.
    const options: Notifications.ExpoPushTokenOptions = { projectId: runtime.projectId! };
    if (nativeToken) options.devicePushToken = nativeToken as Notifications.DevicePushToken;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        Notifications.getExpoPushTokenAsync(options),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("PUSH_TOKEN_TIMEOUT")), 12_000); }),
      ]);
      return result.data;
    } finally { if (timer) clearTimeout(timer); }
  },
});
