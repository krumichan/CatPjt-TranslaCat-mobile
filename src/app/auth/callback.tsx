import { useRouter } from "expo-router";
import { useEffect } from "react";
import { Text } from "react-native";

import { useAuth } from "@/auth/AuthProvider";
import { Button, PageHeading, Screen } from "@/ui/components";

export default function LoginCallbackScreen() {
  const auth = useAuth();
  const router = useRouter();
  useEffect(() => { if (auth.status === "signedIn") router.replace("/(tabs)"); }, [auth.status, router]);
  return (
    <Screen>
      <PageHeading title="앱으로 돌아왔어요" description="시작한 로그인 요청을 확인하고 있어요." />
      <Text>앱이 종료되어 로그인이 이어지지 않으면 로그인 화면에서 다시 시작해 주세요.</Text>
      <Button label="로그인 화면으로" secondary onPress={() => router.replace("/sign-in")} />
    </Screen>
  );
}
