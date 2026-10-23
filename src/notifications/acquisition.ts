import type { DevicePushResult } from "./lifecycle.ts";
import { isExpoPushToken } from "./registry.ts";

export type NotificationPermission = { granted: boolean; canAskAgain: boolean };
export type PushDevicePort = {
  supported(): boolean;
  ensureChannel(): Promise<void>;
  permission(): Promise<NotificationPermission>;
  requestPermission(): Promise<NotificationPermission>;
  expoToken(nativeToken?: unknown): Promise<string>;
};

export function createDeviceAcquisition(port: PushDevicePort) {
  return async (askPermission: boolean, nativeToken?: unknown): Promise<DevicePushResult> => {
    if (!port.supported()) return { status: "unavailable" };
    // Android 13의 권한 대화상자보다 채널을 먼저 생성하며, 자동 동기화는 권한 요청을 반복하지 않는다.
    await port.ensureChannel();
    let permission = await port.permission();
    if (!permission.granted && askPermission && permission.canAskAgain) permission = await port.requestPermission();
    if (!permission.granted) return { status: permission.canAskAgain ? "permission-required" : "permission-blocked" };
    const token = await port.expoToken(nativeToken);
    if (!isExpoPushToken(token)) throw new Error("PUSH_TOKEN_UNAVAILABLE");
    return { status: "ready", token };
  };
}
