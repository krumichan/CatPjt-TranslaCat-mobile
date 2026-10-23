import { useRouter } from "expo-router";
import { ActivityIndicator, KeyboardAvoidingView, Platform } from "react-native";

import { useAuth } from "@/auth/AuthProvider";
import { AppHeader, BackButton, EmptyCard, PageHeading, Screen } from "@/ui/components";
import { colors } from "@/ui/theme";

import { supportStyles as styles } from "./support-styles";
import { SupportWorkspaceView } from "./SupportWorkspaceView";
import { useSupportWorkspace } from "./useSupportWorkspace";

export default function SupportScreen() {
  const auth = useAuth();
  const router = useRouter();
  return <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === "ios" ? "padding" : undefined}>
    <Screen>
      <AppHeader />
      <BackButton onPress={() => router.canGoBack() ? router.back() : router.replace("/settings")} />
      <PageHeading title="문의함" description="이용 중 궁금한 점을 보내고 운영 답변을 확인해요." />
      {auth.status === "restoring" ? <ActivityIndicator color={colors.blue} accessibilityLabel="로그인 확인 중" />
        : auth.status === "signedIn" && auth.sessionKey ? <SupportWorkspace key={auth.sessionKey} />
          : <EmptyCard kind="friends" title="내 문의와 운영 답변" description="로그인 후 문의를 작성하고 답변을 확인할 수 있어요." onSignIn={() => router.push("/sign-in")} />}
    </Screen>
  </KeyboardAvoidingView>;
}

function SupportWorkspace() {
  const workspace = useSupportWorkspace();
  return <SupportWorkspaceView workspace={workspace} />;
}
