import Constants, { ExecutionEnvironment } from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { AndroidImportance } from "expo-notifications";
import { Platform } from "react-native";

export class DevelopmentSetupError extends Error {}

export async function acquireDevelopmentPushToken(projectId: string | null): Promise<string> {
  // 원격 푸시는 실제 native 개발 빌드에서만 확인한다.
  if (!__DEV__) throw new DevelopmentSetupError("개발 빌드에서만 사용할 수 있어요.");
  if (Platform.OS === "web") throw new DevelopmentSetupError("Android 또는 iPhone 개발 빌드에서 실행해 주세요.");
  if (Constants.executionEnvironment === ExecutionEnvironment.StoreClient) {
    throw new DevelopmentSetupError("Expo Go 대신 개발 빌드를 설치해 주세요.");
  }
  if (!Device.isDevice) throw new DevelopmentSetupError("이번 점검은 실제 휴대폰에서 진행해 주세요.");
  if (!projectId) throw new DevelopmentSetupError("Expo 프로젝트 연결이 먼저 필요해요.");

  // Android 채널은 권한 요청 전에 만든다.
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("chat-messages", {
      name: "채팅 메시지",
      importance: AndroidImportance.HIGH,
    });
  }
  let permission = await Notifications.getPermissionsAsync();
  if (!permission.granted && permission.canAskAgain) {
    permission = await Notifications.requestPermissionsAsync();
  }
  if (!permission.granted) throw new DevelopmentSetupError("휴대폰 설정에서 알림을 허용해 주세요.");

  // 토큰은 진단 화면의 메모리에만 보관한다. 서버 등록과 자동 로그 출력은 하지 않는다.
  const result = await Notifications.getExpoPushTokenAsync({ projectId });
  return result.data;
}

export async function showLocalNotificationTest(): Promise<void> {
  if (!__DEV__ || Platform.OS === "web") {
    throw new DevelopmentSetupError("실제 휴대폰의 개발 빌드에서 실행해 주세요.");
  }
  const permission = await Notifications.getPermissionsAsync();
  if (!permission.granted) {
    throw new DevelopmentSetupError("먼저 알림 권한과 푸시 토큰 확인을 실행해 주세요.");
  }
  await Notifications.scheduleNotificationAsync({
    content: {
      title: "TranslaCat 알림 표시 테스트",
      body: "이 알림은 기기에서 만들었어요. 서버 푸시 수신 검증과는 달라요.",
    },
    trigger: null,
  });
}
