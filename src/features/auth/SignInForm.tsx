import { useRouter } from "expo-router";
import { useState } from "react";
import { KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput, View } from "react-native";

import { ApiError } from "@/api/client";
import { useAuth } from "@/auth/AuthProvider";
import { runtime } from "@/config/runtime";
import { BackButton, BrandWordmark, Button, Screen } from "@/ui/components";
import { colors } from "@/ui/theme";
import { LegalLinks } from "./LegalLinks";

function loginMessage(error: unknown) {
  if (!(error instanceof ApiError)) return "로그인을 완료하지 못했어요. 잠시 후 다시 시도해 주세요.";
  if (error.code === "API_NOT_CONFIGURED") return "서버 연결이 준비되면 로그인할 수 있어요.";
  if (error.status === 429) return "로그인 시도가 많아요. 잠시 기다린 뒤 다시 시도해 주세요.";
  if (error.status === 401 || error.status === 400) return "이메일과 비밀번호를 확인해 주세요.";
  if (error.status === 403) return "이 계정으로 로그인할 수 없어요. 웹에서 계정 상태를 확인해 주세요.";
  if (error.code === "SESSION_CHANGED") return "로그인 상태가 바뀌었어요. 다시 시도해 주세요.";
  return "연결을 확인하고 다시 시도해 주세요. 로그인 정보는 저장되지 않았어요.";
}

export default function SignInForm() {
  const router = useRouter();
  const auth = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace("/(tabs)");
  };

  const submit = async () => {
    // 비밀번호는 입력 그대로 전달하고 별도 저장하거나 로그에 남기지 않는다.
    if (busy || !email.trim() || !password) return;
    setBusy(true);
    setError(null);
    try {
      await auth.signIn(email, password);
      setPassword("");
      router.replace("/(tabs)");
    } catch (failure) {
      setError(loginMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  const google = async () => {
    // 기존 브라우저 인증과 앱 복귀 흐름을 유지하고 중복 요청만 막는다.
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await auth.signInWithGoogle();
      setPassword("");
      router.replace("/(tabs)");
    } catch (failure) {
      const code = failure instanceof ApiError ? failure.code : "";
      setError(code === "MOBILE_AUTH_CANCELLED" ? "로그인을 취소했어요. 다시 시작할 수 있어요."
        : code === "API_NOT_CONFIGURED" ? "서버 연결이 준비되면 로그인할 수 있어요."
        : "앱 로그인을 완료하지 못했어요. 앱에서 다시 시작해 주세요.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView style={styles.keyboard} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <Screen>
        <BackButton onPress={goBack} />
        <View style={styles.content}>
          <View style={styles.brand}>
            <BrandWordmark width={240} />
            <Text style={styles.tagline}>언어를 넘어, 대화를 잇다</Text>
          </View>

          <View style={styles.card}>
            <Text style={styles.eyebrow}>다시 만나 반가워요</Text>
            <Text accessibilityRole="header" style={styles.title}>대화를 이어가요</Text>
            <Text style={styles.description}>웹에서 쓰던 TranslaCat 계정으로 로그인해 주세요.</Text>
            {!runtime.apiBaseUrl && <Text style={styles.description}>서버 연결이 준비되면 로그인할 수 있어요.</Text>}

            {Platform.OS !== "web" && (
              <View style={styles.googleSection}>
                <Button
                  label={busy ? "로그인 확인 중…" : "Google로 계속하기"}
                  leading={<Text style={styles.googleSymbol}>G</Text>}
                  secondary
                  onPress={() => void google()}
                  disabled={busy || !runtime.apiBaseUrl || auth.status === "restoring"}
                />
                <Text style={styles.hint}>브라우저에서 Google로 인증한 뒤 앱으로 돌아와요.</Text>
                <View style={styles.divider}>
                  <View style={styles.dividerLine} />
                  <Text style={styles.dividerLabel}>또는 이메일로 로그인</Text>
                  <View style={styles.dividerLine} />
                </View>
              </View>
            )}

            {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
            <View style={styles.form}>
              <Text style={styles.label}>이메일</Text>
              <TextInput
                accessibilityLabel="이메일"
                value={email}
                onChangeText={setEmail}
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="email"
                textContentType="username"
                editable={!busy}
                style={styles.input}
                placeholder="이메일 주소"
                placeholderTextColor={colors.muted}
                returnKeyType="next"
              />
              <Text style={styles.label}>비밀번호</Text>
              <TextInput
                accessibilityLabel="비밀번호"
                value={password}
                onChangeText={setPassword}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="current-password"
                textContentType="password"
                editable={!busy}
                style={styles.input}
                placeholder="비밀번호"
                placeholderTextColor={colors.muted}
                returnKeyType="go"
                onSubmitEditing={() => void submit()}
              />
              <View style={styles.button}>
                <Button
                  label={busy ? "로그인 중…" : "로그인"}
                  onPress={() => void submit()}
                  disabled={busy || !runtime.apiBaseUrl || !email.trim() || !password || auth.status === "restoring"}
                />
              </View>
            </View>
            <View style={styles.accountLinks}>
              <Button label="이메일로 가입하기" secondary disabled={busy || auth.status !== "signedOut"} onPress={() => { setPassword(""); router.push("/register"); }} />
              <Button label="비밀번호 찾기" secondary disabled={busy || auth.status !== "signedOut"} onPress={() => { setPassword(""); router.push("/password-reset"); }} />
            </View>
            <LegalLinks />
          </View>
          {Platform.OS === "web" && <Text style={styles.note}>웹 미리보기에서는 창을 새로 열면 다시 로그인해 주세요.</Text>}
          <Text style={styles.footer}>TranslaCat · 함께 나누는 모든 언어</Text>
        </View>
      </Screen>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  keyboard: { flex: 1 },
  content: { paddingTop: 20, paddingBottom: 24 },
  brand: { alignItems: "center", gap: 12, marginBottom: 30 },
  tagline: { color: colors.muted, fontSize: 13, lineHeight: 21 },
  card: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line, borderRadius: 26, padding: 22 },
  eyebrow: { marginBottom: 8, color: colors.chat, fontSize: 12, lineHeight: 20, fontWeight: "700" },
  title: { color: colors.ink, fontSize: 26, fontWeight: "800", lineHeight: 38, letterSpacing: -0.8 },
  description: { color: colors.muted, fontSize: 14, lineHeight: 23, marginTop: 8 },
  googleSection: { marginTop: 26 },
  googleSymbol: { color: colors.blue, fontSize: 20, fontWeight: "800" },
  hint: { marginTop: 10, color: colors.muted, fontSize: 12, lineHeight: 20, textAlign: "center" },
  divider: { marginTop: 24, marginBottom: 8, flexDirection: "row", alignItems: "center", gap: 10 },
  dividerLine: { flex: 1, height: 1, backgroundColor: colors.line },
  dividerLabel: { color: colors.muted, fontSize: 12, lineHeight: 20, flexShrink: 1, textAlign: "center" },
  form: { marginTop: 20, gap: 9 },
  accountLinks: { marginTop: 20, gap: 12 },
  label: { color: colors.ink, fontSize: 14, lineHeight: 21, fontWeight: "600" },
  input: { minHeight: 54, paddingHorizontal: 16, paddingVertical: 14, borderWidth: 1, borderColor: colors.blueLine,
    borderRadius: 12, backgroundColor: colors.surface, color: colors.ink, fontSize: 16, marginBottom: 8 },
  button: { marginTop: 8 },
  error: { color: colors.danger, backgroundColor: colors.dangerSoft, padding: 14, borderRadius: 12, marginTop: 16, fontSize: 14, lineHeight: 22 },
  note: { color: colors.muted, fontSize: 12, lineHeight: 21, marginTop: 20 },
  footer: { color: colors.muted, fontSize: 12, lineHeight: 20, textAlign: "center", marginTop: 28 },
});
