import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput, View } from "react-native";

import { createApiClient } from "@/api/client";
import { useAuth } from "@/auth/AuthProvider";
import { runtime } from "@/config/runtime";
import { useActivityGate } from "@/realtime/useActivity";
import { BackButton, Button, PageHeading, Screen } from "@/ui/components";
import { colors } from "@/ui/theme";

import { createEmailAccessController } from "./email-access-controller";
import { type EmailAccessFields, type EmailAccessMode } from "./email-access-contracts";
import { LegalLinks } from "./LegalLinks";

export default function EmailAccessScreen({ mode }: { mode: EmailAccessMode }) {
  const router = useRouter();
  const { status, boundaryGeneration, isCurrentSignedOutSession } = useAuth();
  const { active, isActive } = useActivityGate();
  const [clock, setClock] = useState(() => Date.now());
  const api = useMemo(() => createApiClient({ baseUrl: runtime.apiBaseUrl, accessToken: async () => null }), []);
  const controller = useMemo(() => createEmailAccessController({
    mode,
    current: () => status === "signedOut" && isCurrentSignedOutSession(boundaryGeneration) && isActive(),
    request: (path, body, signal) => api.request(path, { method: "POST", body, signal, authenticated: false }),
  }), [api, boundaryGeneration, isActive, isCurrentSignedOutSession, mode, status]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);

  useFocusEffect(useCallback(() => () => controller.suspend(true), [controller]));
  useEffect(() => {
    // 메일 앱으로 이동해도 발송된 challenge는 유지한다. 비밀번호와 진행 중 요청은 남기지 않는다.
    if (!active) { controller.suspend(); return; }
    controller.tick();
    const timer = setInterval(() => { controller.tick(); setClock(Date.now()); }, 1000);
    return () => clearInterval(timer);
  }, [active, controller]);
  useEffect(() => () => controller.suspend(true), [controller]);

  const back = () => {
    controller.suspend(true);
    if (router.canGoBack()) router.back();
    else router.replace("/sign-in");
  };
  const locked = state.busy !== null || !active || status !== "signedOut" || !runtime.apiBaseUrl;
  const cooldown = Math.max(0, Math.ceil((state.cooldownUntil - clock) / 1000));
  const remaining = Math.max(0, Math.ceil((state.expiresAt - clock) / 1000));
  const field = (name: keyof EmailAccessFields, label: string, options: {
    secret?: boolean; numeric?: boolean; email?: boolean; limit: number; placeholder?: string;
  }) => (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        value={state[name]}
        onChangeText={value => controller.setField(name, value)}
        editable={!locked && !state.completed}
        secureTextEntry={options.secret}
        keyboardType={options.email ? "email-address" : options.numeric ? "number-pad" : "default"}
        autoComplete={name === "code" ? "one-time-code" : options.secret ? "new-password" : options.email ? "email" : "off"}
        textContentType={name === "code" ? "oneTimeCode" : options.secret ? "newPassword" : options.email ? "emailAddress" : "none"}
        autoCapitalize="none"
        autoCorrect={false}
        maxLength={options.limit}
        placeholder={options.placeholder}
        placeholderTextColor={colors.muted}
        style={styles.input}
      />
    </View>
  );

  return (
    <KeyboardAvoidingView style={styles.keyboard} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <Screen>
        <BackButton onPress={back} />
        <PageHeading title={mode === "register" ? "이메일로 가입하기" : "비밀번호 찾기"}
          description={mode === "register" ? "이메일을 인증하고 TranslaCat 계정을 만들어요." : "가입 이메일을 인증한 뒤 새 비밀번호를 정해요."} />
        <View style={styles.card}>
          {status !== "signedOut" && <Text style={styles.help}>이메일 가입·비밀번호 찾기는 로그아웃한 뒤 이용해 주세요.</Text>}
          {mode === "reset" && <Text style={styles.help}>Google로만 가입했다면 Google로 로그인해 주세요. 계정 유무와 관계없이 동일한 인증 메일 안내를 제공해요.</Text>}
          {state.error && <Text accessibilityRole="alert" style={styles.error}>{state.error}</Text>}
          {state.message && <Text accessibilityLiveRegion="polite" style={styles.feedback}>{state.message}</Text>}
          {state.completed ? (
            <Button label="로그인으로 돌아가기" onPress={() => { controller.suspend(true); router.replace("/sign-in"); }} />
          ) : (
            <>
              {field("email", "이메일", { email: true, limit: 254, placeholder: "가입에 사용할 이메일 주소" })}
              <Button label={state.busy === "send" ? "인증 메일 발송 중…" : cooldown > 0 ? `${cooldown}초 후 다시 보내기` : "인증 메일 보내기"}
                secondary disabled={locked || cooldown > 0} onPress={() => void controller.send()} />
              {state.expiresAt > 0 && <Text style={styles.help}>{state.verified ? "인증 완료" : "인증번호 입력"} · 남은 시간 {Math.floor(remaining / 60)}분 {remaining % 60}초</Text>}
              {!state.verified && (
                <>
                  {field("code", "이메일 인증번호", { numeric: true, limit: 6, placeholder: "6자리 숫자" })}
                  <Button label={state.busy === "verify" ? "인증 확인 중…" : "인증번호 확인"}
                    secondary disabled={locked || state.expiresAt === 0 || state.code.length !== 6} onPress={() => void controller.verify()} />
                </>
              )}
              {mode === "register" && (
                <>
                  {field("nickname", "닉네임", { limit: 30, placeholder: "1~30자" })}
                  {field("birthDate", "생년월일", { limit: 10, placeholder: "YYYY-MM-DD (예: 1995-03-21)" })}
                </>
              )}
              {field("password", mode === "register" ? "비밀번호" : "새 비밀번호", { secret: true, limit: 128, placeholder: "8자 이상, UTF-8 72바이트 이하" })}
              {field("confirmation", "비밀번호 확인", { secret: true, limit: 128, placeholder: "같은 비밀번호를 다시 입력" })}
              <Button label={state.busy === "complete" ? "처리 중…" : mode === "register" ? "가입 완료하기" : "비밀번호 변경하기"}
                disabled={locked || !state.verified} onPress={() => void controller.complete()} />
              {mode === "reset" && <Text style={styles.help}>변경이 끝나면 기존 로그인은 해제돼요. 새 비밀번호로 다시 로그인해 주세요.</Text>}
            </>
          )}
        </View>
        <LegalLinks />
      </Screen>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  keyboard: { flex: 1 },
  card: { gap: 16, padding: 20, backgroundColor: colors.surface, borderColor: colors.line, borderWidth: 1, borderRadius: 24, marginBottom: 20 },
  field: { gap: 8 },
  label: { color: colors.ink, fontSize: 14, lineHeight: 22, fontWeight: "700" },
  input: { color: colors.ink, backgroundColor: colors.surface, borderColor: colors.blueLine, borderWidth: 1,
    borderRadius: 12, fontSize: 16, minHeight: 54, paddingHorizontal: 14, paddingVertical: 14 },
  help: { color: colors.muted, fontSize: 13, lineHeight: 22 },
  error: { color: colors.danger, fontSize: 14, lineHeight: 23 },
  feedback: { color: colors.ink, fontSize: 14, lineHeight: 23 },
});
