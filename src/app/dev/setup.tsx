import * as Notifications from "expo-notifications";
import { Redirect, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { Platform, StyleSheet, Text, View } from "react-native";

import { runtime } from "@/config/runtime";
import { acquireDevelopmentPushToken, DevelopmentSetupError, showLocalNotificationTest } from "@/notifications/device";
import { parseChatNotification } from "@/notifications/intent";
import { BackButton, Button, InfoCard, PageHeading, Screen } from "@/ui/components";
import { colors } from "@/ui/theme";

export default function DevelopmentSetup() {
  const router = useRouter();
  const [token, setToken] = useState<string | null>(null);
  const [message, setMessage] = useState("실기기 개발 빌드에서 알림 권한과 토큰을 확인할 수 있어요.");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!__DEV__ || Platform.OS === "web") return;
    // 알림을 받았다고 로그인·읽음·대화 접근 권한을 만들지 않는다.
    const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
      const intent = parseChatNotification(response.notification.request.content.data);
      setMessage(intent
        ? "채팅 알림 형식을 확인했어요. 로그인과 멤버십 연결은 다음 단계예요."
        : "알림을 열었어요. 채팅 이동은 서버 계약 연결 후 검증해요.");
    });
    return () => subscription.remove();
  }, []);

  if (!__DEV__) return <Redirect href="/" />;

  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    try {
      await action();
    } catch (error) {
      // 공급자 오류에 포함될 수 있는 토큰과 원문 메시지는 화면이나 로그에 반사하지 않는다.
      setMessage(error instanceof DevelopmentSetupError
        ? error.message : "푸시 자격·휴대폰 설정·네트워크를 확인한 뒤 다시 시도해 주세요.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <BackButton onPress={() => router.replace("/settings")} />
      <PageHeading title="개발 점검" description="계정 연결과 실제 푸시 검증을 위한 개발 전용 화면이에요." />
      <InfoCard title="프로젝트 연결">
        {runtime.projectId ? "Expo 프로젝트 ID가 연결됐어요." : "Expo 프로젝트 연결 대기"}
        {"\n"}API: {runtime.apiBaseUrl ? "주소 설정됨 · 인증 연결 전" : "연결 전"}
        {"\n"}환경: {runtime.environment} · {Platform.OS}
      </InfoCard>
      <View style={styles.actions}>
        <Button label={busy ? "확인 중…" : "알림 권한과 푸시 토큰 확인"} onPress={() => {
          void run(async () => {
            setToken(await acquireDevelopmentPushToken(runtime.projectId));
            setMessage("토큰을 받았어요. 아직 서버 등록이나 원격 푸시 수신을 완료한 상태는 아니에요.");
          });
        }} />
        <Button label="기기 내 알림 표시 테스트" secondary onPress={() => {
          void run(async () => {
            await showLocalNotificationTest();
            setMessage("기기 내 알림을 예약했어요. 원격 푸시는 별도로 검증해 주세요.");
          });
        }} />
      </View>
      <Text accessibilityLiveRegion="polite" style={styles.message}>{message}</Text>
      {token && (
        <View style={styles.tokenCard}>
          <Text style={styles.label}>개발 토큰 · 이 화면에서만 확인</Text>
          <Text selectable style={styles.token}>{token}</Text>
          <Text style={styles.message}>Expo 테스트 도구에만 사용하고 GitHub·채팅·스크린샷에는 공유하지 마세요.</Text>
          <Button label="토큰 화면에서 지우기" secondary onPress={() => setToken(null)} />
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  actions: { gap: 12, marginTop: 16 },
  message: { color: colors.muted, lineHeight: 23, marginVertical: 16 },
  tokenCard: { padding: 16, backgroundColor: colors.surface, borderRadius: 18, gap: 12 },
  label: { color: colors.ink, fontWeight: "700" },
  token: { color: colors.ink, fontSize: 12, lineHeight: 20 },
});
