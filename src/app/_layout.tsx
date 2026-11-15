import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";

import { AppProviders } from "@/providers/AppProviders";
import { colors } from "@/ui/theme";

export const unstable_settings = { initialRouteName: "(tabs)" };

/** 공용 앱 상태를 연결하고 탭·로그인·대화방 경로를 등록한다. */
export default function RootLayout() {
  return (
    <AppProviders>
      <StatusBar style="dark" />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="sign-in" options={{ presentation: "modal", title: "로그인" }} />
        <Stack.Screen name="chat/[roomId]" options={{ title: "대화방" }} />
      </Stack>
    </AppProviders>
  );
}
