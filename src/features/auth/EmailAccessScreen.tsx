import { useFocusEffect, useRouter } from "expo-router";
import { type ComponentRef, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AccessibilityInfo, Keyboard, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";

import { createApiClient } from "@/api/client";
import { useAuth } from "@/auth/AuthProvider";
import { runtime } from "@/config/runtime";
import { useActivityGate } from "@/realtime/useActivity";
import { BackButton, Button, PageHeading } from "@/ui/components";
import { colors } from "@/ui/theme";

import { createEmailAccessController } from "./email-access-controller";
import { type EmailAccessFields, type EmailAccessMode } from "./email-access-contracts";
import { LegalLinks } from "./LegalLinks";
import { BirthDateField } from "./BirthDateField";

function subscribeKeyboardVisibility(notify: () => void) {
  const show = Keyboard.addListener("keyboardDidShow", notify);
  const hide = Keyboard.addListener("keyboardDidHide", notify);
  return () => { show.remove(); hide.remove(); };
}
const keyboardVisible = () => Keyboard.isVisible();
const keyboardHiddenOnServer = () => false;
type FormLocation = keyof EmailAccessFields | "send" | "verify";

export default function EmailAccessScreen({ mode }: { mode: EmailAccessMode }) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const keyboardOpen = useSyncExternalStore(subscribeKeyboardVisibility, keyboardVisible, keyboardHiddenOnServer);

  // 입력 위치는 렌더 중 읽지 않고 포커스·레이아웃·오류 안내 이벤트에서만 사용한다.
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const inputs = useRef<Partial<Record<keyof EmailAccessFields, ComponentRef<typeof TextInput>>>>({});
  const positions = useRef<Partial<Record<FormLocation, number>>>({});
  const cardTop = useRef(0);
  const focused = useRef<keyof EmailAccessFields | null>(null);
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

  const scrollToLocation = useCallback((location: FormLocation) => {
    const top = positions.current[location];
    if (top !== undefined) scroll.current?.scrollTo({ y: Math.max(0, cardTop.current + top - 12), animated: true });
  }, []);
  const revealError = useCallback(() => {
    // 필드 오류는 해당 입력으로, 통신 오류는 요청한 버튼으로 안내한다. 제출 오류는 고정 영역에 남긴다.
    const location = state.errorField ?? (state.errorAction === "complete" ? null : state.errorAction);
    if (!location) return;
    if (state.errorField) inputs.current[state.errorField]?.focus();
    requestAnimationFrame(() => scrollToLocation(location));
  }, [scrollToLocation, state.errorAction, state.errorField]);
  useEffect(() => {
    if (!state.error) return;
    AccessibilityInfo.announceForAccessibility(state.error);
    revealError();
  }, [revealError, state.error, state.errorRevision]);

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
  const errorHasLocation = !!state.errorField || state.errorAction === "send" || state.errorAction === "verify";
  const fieldError = (name: keyof EmailAccessFields) => state.errorField === name ? state.error ?? undefined : undefined;
  const actionError = (action: "send" | "verify") => state.error && !state.errorField && state.errorAction === action
    ? <Text accessibilityRole="alert" style={styles.error}>{state.error}</Text> : null;
  const field = (name: keyof EmailAccessFields, label: string, options: {
    secret?: boolean; numeric?: boolean; email?: boolean; limit: number; placeholder?: string;
  }) => (
    <View style={styles.field} onLayout={event => { positions.current[name] = event.nativeEvent.layout.y; }}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        ref={node => { if (node) inputs.current[name] = node; else delete inputs.current[name]; }}
        accessibilityLabel={label}
        value={state[name]}
        onChangeText={value => controller.setField(name, value)}
        onFocus={() => { focused.current = name; requestAnimationFrame(() => scrollToLocation(name)); }}
        onBlur={() => { if (focused.current === name) focused.current = null; }}
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
        style={[styles.input, fieldError(name) && styles.inputError]}
      />
      {fieldError(name) && <Text accessibilityRole="alert" style={styles.error}>{fieldError(name)}</Text>}
    </View>
  );

  return (
    <KeyboardAvoidingView style={styles.keyboard} behavior={Platform.OS === "ios" ? "padding" : "height"} keyboardVerticalOffset={0}>
      <SafeAreaView style={styles.keyboard} edges={["top", "left", "right"]}>
      {/* 스크롤 영역과 제출 영역을 분리해 키보드가 열려도 완료 버튼을 화면 안에 둔다. */}
      <ScrollView ref={scroll} style={styles.form} contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled" keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
        onLayout={() => { if (focused.current) scrollToLocation(focused.current); }}>
      <View style={styles.content}>
        <BackButton onPress={back} />
        <PageHeading title={mode === "register" ? "이메일로 가입하기" : "비밀번호 찾기"}
          description={mode === "register" ? "이메일을 인증하고 TranslaCat 계정을 만들어요." : "가입 이메일을 인증한 뒤 새 비밀번호를 정해요."} />
        <View style={styles.card} onLayout={event => { cardTop.current = event.nativeEvent.layout.y; }}>
          {status !== "signedOut" && <Text style={styles.help}>이메일 가입·비밀번호 찾기는 로그아웃한 뒤 이용해 주세요.</Text>}
          {mode === "reset" && <Text style={styles.help}>Google로만 가입했다면 Google로 로그인해 주세요. 계정 유무와 관계없이 동일한 인증 메일 안내를 제공해요.</Text>}
          {state.completed ? (
            <Text accessibilityLiveRegion="polite" style={styles.feedback}>{state.message}</Text>
          ) : (
            <>
              {field("email", "이메일", { email: true, limit: 254, placeholder: "가입에 사용할 이메일 주소" })}
              <View style={styles.field} onLayout={event => { positions.current.send = event.nativeEvent.layout.y; }}>
                <Button label={state.busy === "send" ? "인증 메일 발송 중…" : cooldown > 0 ? `${cooldown}초 후 다시 보내기` : "인증 메일 보내기"}
                  secondary disabled={locked || cooldown > 0} onPress={() => void controller.send()} />
                {actionError("send")}
              </View>
              {state.expiresAt > 0 && <Text style={styles.help}>{state.verified ? "인증 완료" : "인증번호 입력"} · 남은 시간 {Math.floor(remaining / 60)}분 {remaining % 60}초</Text>}
              {!state.verified && (
                <>
                  {field("code", "이메일 인증번호", { numeric: true, limit: 6, placeholder: "6자리 숫자" })}
                  <View style={styles.field} onLayout={event => { positions.current.verify = event.nativeEvent.layout.y; }}>
                    <Button label={state.busy === "verify" ? "인증 확인 중…" : "인증번호 확인"}
                      secondary disabled={locked || state.expiresAt === 0 || state.code.length !== 6} onPress={() => void controller.verify()} />
                    {actionError("verify")}
                  </View>
                </>
              )}
              {state.message && <Text accessibilityLiveRegion="polite" style={styles.feedback}>{state.message}</Text>}
              {mode === "register" && (
                <>
                  {field("nickname", "닉네임", { limit: 30, placeholder: "1~30자" })}
                  <View onLayout={event => { positions.current.birthDate = event.nativeEvent.layout.y; }}>
                    {/* 이전 로그인 세대의 미적용 날짜도 해당 화면과 함께 폐기한다. */}
                    <BirthDateField key={`${mode}:${boundaryGeneration}`} value={state.birthDate} onChange={value => controller.setField("birthDate", value)}
                      disabled={locked || state.completed} error={fieldError("birthDate")} />
                  </View>
                </>
              )}
              {field("password", mode === "register" ? "비밀번호" : "새 비밀번호", { secret: true, limit: 128, placeholder: "8자 이상, UTF-8 72바이트 이하" })}
              {field("confirmation", "비밀번호 확인", { secret: true, limit: 128, placeholder: "같은 비밀번호를 다시 입력" })}
              {mode === "reset" && <Text style={styles.help}>변경이 끝나면 기존 로그인은 해제돼요. 새 비밀번호로 다시 로그인해 주세요.</Text>}
            </>
          )}
          {/* 긴 안내는 본문과 함께 확대·스크롤하고, 고정 영역에는 완료 동작만 남긴다. */}
          {!state.completed && !state.error && !state.verified && <Text style={styles.help}>이메일 인증 후 {mode === "register" ? "가입을 완료" : "비밀번호를 변경"}할 수 있어요.</Text>}
        </View>
        <LegalLinks />
      </View>
      </ScrollView>
      <View style={[styles.footer, { paddingBottom: keyboardOpen ? 12 : Math.max(insets.bottom, 12) }]}>
        <View style={styles.footerContent}>
          {/* 긴 오류도 따로 스크롤해 읽되, 큰 글꼴에서 입력창과 완료 버튼을 밀어내지 않는다. */}
          {state.error && <ScrollView key={state.errorRevision} style={[styles.errorSummaryScroll, keyboardOpen && styles.keyboardErrorSummary]}
            contentContainerStyle={styles.errorSummary} keyboardShouldPersistTaps="handled" nestedScrollEnabled>
            <Text accessibilityRole="alert" accessibilityLiveRegion="assertive" style={styles.error}>{state.error}</Text>
            {errorHasLocation && <Pressable accessibilityRole="button" accessibilityLabel="오류가 있는 입력 위치로 이동"
              onPress={revealError} style={styles.errorLinkButton}>
              <Text style={styles.errorLink}>입력 위치 확인 ↑</Text>
            </Pressable>}
          </ScrollView>}
          <Button maxFontSizeMultiplier={2} label={state.completed ? "로그인으로 돌아가기" : state.busy === "complete" ? "처리 중…" : mode === "register" ? "가입 완료하기" : "비밀번호 변경하기"}
            disabled={!state.completed && (locked || !state.verified)}
            onPress={state.completed ? () => { controller.suspend(true); router.replace("/sign-in"); } : () => void controller.complete()} />
        </View>
      </View>
      </SafeAreaView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  keyboard: { flex: 1, backgroundColor: colors.background },
  form: { flex: 1, minHeight: 0 },
  scrollContent: { flexGrow: 1, paddingBottom: 20 },
  content: { width: "100%", maxWidth: 680, alignSelf: "center", paddingHorizontal: 20 },
  footer: { backgroundColor: colors.surface, borderTopColor: colors.line, borderTopWidth: 1, paddingHorizontal: 20, paddingTop: 12 },
  footerContent: { width: "100%", maxWidth: 640, alignSelf: "center", gap: 10 },
  errorSummary: { gap: 4, padding: 10, borderRadius: 12, backgroundColor: colors.dangerSoft },
  errorSummaryScroll: { maxHeight: 144, flexGrow: 0 },
  keyboardErrorSummary: { maxHeight: 96 },
  errorLinkButton: { minHeight: 36, justifyContent: "center", alignSelf: "flex-start" },
  errorLink: { color: colors.danger, fontSize: 13, lineHeight: 20, fontWeight: "700" },
  card: { gap: 16, padding: 20, backgroundColor: colors.surface, borderColor: colors.line, borderWidth: 1, borderRadius: 24, marginBottom: 20 },
  field: { gap: 8 },
  label: { color: colors.ink, fontSize: 14, lineHeight: 22, fontWeight: "700" },
  input: { color: colors.ink, backgroundColor: colors.surface, borderColor: colors.blueLine, borderWidth: 1,
    borderRadius: 12, fontSize: 16, minHeight: 54, paddingHorizontal: 14, paddingVertical: 14 },
  inputError: { borderColor: colors.danger, borderWidth: 2 },
  help: { color: colors.muted, fontSize: 13, lineHeight: 22 },
  error: { color: colors.danger, fontSize: 14, lineHeight: 23 },
  feedback: { color: colors.ink, fontSize: 14, lineHeight: 23 },
});
