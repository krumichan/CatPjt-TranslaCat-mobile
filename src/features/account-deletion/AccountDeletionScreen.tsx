import { useRouter } from "expo-router";
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import * as WebBrowser from "expo-web-browser";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Platform, StyleSheet, Text, View } from "react-native";

import { createApiClient } from "@/api/client";
import { useAuth } from "@/auth/AuthProvider";
import { createAuthBrowser } from "@/auth/auth-browser";
import { runtime } from "@/config/runtime";
import { useActivityGate } from "@/realtime/useActivity";
import { BackButton, Button, InfoCard, PageHeading, Screen } from "@/ui/components";
import { colors } from "@/ui/theme";

import { deletionBrowserUrl, parseDeletionReceipt, receiptSecret, validDeletionCallback } from "./contracts";
import { createDeletionController, emptyDeletionState } from "./controller";

function storage() {
  let preview: string | null = null;
  const key = "translacat.deletion.v1." + runtime.environment + "." + Array.from(runtime.apiBaseUrl ?? "none", character => character.codePointAt(0)!.toString(16)).join("_");
  const options = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
  return {
    read: () => Platform.OS === "web" ? Promise.resolve(preview) : SecureStore.getItemAsync(key, options),
    write: (value: string) => Platform.OS === "web" ? Promise.resolve().then(() => { preview = value; }) : SecureStore.setItemAsync(key, value, options),
    remove: () => Platform.OS === "web" ? Promise.resolve().then(() => { preview = null; }) : SecureStore.deleteItemAsync(key, options),
  };
}

export default function AccountDeletionScreen() {
  const router = useRouter();
  const auth = useAuth();
  const authRef = useRef(auth);
  useLayoutEffect(() => { authRef.current = auth; }, [auth]);
  const { active, isActive } = useActivityGate();
  const controller = useRef<ReturnType<typeof createDeletionController> | null>(null);
  const [state, setState] = useState(emptyDeletionState);
  const [confirmForget, setConfirmForget] = useState(false);
  useEffect(() => {
    let alive = true;
    const anonymous = createApiClient({ baseUrl: runtime.apiBaseUrl, accessToken: async () => null });
    const owned = createDeletionController({
      storage: storage(),
      current: () => alive,
      onChange: setState,
      createReceipt: async publicId => parseDeletionReceipt({ operationId: Crypto.randomUUID(), receiptSecret: receiptSecret(await Crypto.getRandomBytesAsync(32)),
        expectedPublicId: publicId, returnScheme: runtime.environment === "production" ? "translacat" : runtime.environment === "preview" ? "translacat-preview" : "translacat-dev" }),
      readStatus: (receipt, signal) => anonymous.request("/account-deletion/status", {
        authenticated: false, method: "POST", signal, body: { operationId: receipt.operationId, receiptSecret: receipt.receiptSecret },
      }),
      openBrowser: async receipt => {
        if (!isActive() || authRef.current.user?.publicId !== receipt.expectedPublicId) throw new Error("DELETION_SESSION_CHANGED");
        const callback = receipt.returnScheme + "://account-deletion";
        const result = await createAuthBrowser(Platform.OS, WebBrowser.openAuthSessionAsync)(deletionBrowserUrl(runtime.webBaseUrl, receipt), callback);
        if (result.type === "success" && !validDeletionCallback(result.url, receipt)) throw new Error("INVALID_DELETION_CALLBACK");
      },
      onAccepted: async publicId => {
        // 이전 영수증의 응답으로 새 계정을 로그아웃시키지 않는다. 서버가 접수를 확인한 계정만 정리한다.
        if (authRef.current.status === "signedIn" && authRef.current.user?.publicId === publicId) await authRef.current.signOut();
      },
    });
    controller.current = owned;
    void owned.restore();
    return () => {
      alive = false;
      owned.dispose();
      if (controller.current === owned) controller.current = null;
    };
  }, [isActive]);
  useEffect(() => {
    if (!active || !state.receipt || state.status?.status === "COMPLETED") return;
    const timer = setInterval(() => { if (isActive()) void controller.current?.check(); }, 15000);
    return () => clearInterval(timer);
  }, [active, state.receipt, state.status?.status, isActive]);

  const ready = active && state.pending === null;
  return <Screen>
    <BackButton onPress={() => router.replace("/(tabs)/settings")} />
    <PageHeading title="계정 탈퇴·데이터 삭제" description="삭제 범위를 확인하고 본인 계정으로 요청해요." />
    <InfoCard title="삭제되는 정보">프로필·친구·차단 관계·기기 연결·개인 문의·개인 학습 기록·개인 가계부와 저장된 개인 음성을 삭제해요.</InfoCard>
    <InfoCard title="함께 쓰던 기록">공유 채팅의 본문·번역은 남기고 작성자를 ‘탈퇴한 사용자’로 바꿔요. 공유 가계부는 다른 참여자에게 넘기고 공동 내역을 익명으로 유지해요.</InfoCard>
    <InfoCard title="신고 증거와 처리 상태">운영자 전용 신고 증거는 신고 후 90일 뒤 자동 삭제해요. 모든 서비스와 파일 정리가 끝날 때까지 삭제 처리 중으로 표시해요. 완료 후 7일 동안 영수증으로 상태를 확인할 수 있어요.</InfoCard>
    <View style={styles.card}>
      {state.status ? <>
        <Text accessibilityRole="header" style={styles.title}>{state.status.status === "COMPLETED" ? "데이터 삭제가 완료됐어요" : "삭제 처리 중이에요"}</Text>
        <Text style={styles.description}>{state.status.status === "COMPLETED" ? "안내한 범위의 삭제와 익명화를 마쳤어요." : "계정 접근을 종료했고 각 서비스와 파일을 정리하고 있어요. 완료 전까지 앱 데이터를 지우지 말아 주세요."}</Text>
      </> : <>
        <Text style={styles.description}>다음 화면은 TranslaCat 공식 웹이에요. 삭제할 계정과 같은 Google 계정 또는 비밀번호로 다시 확인하고, 마지막에 삭제를 확정해요. 접수하면 모든 기기의 로그인을 종료하며 되돌릴 수 없어요.</Text>
        {auth.status === "signedIn" && <Text style={styles.identity}>현재 ID: {auth.user?.publicId}</Text>}
        {auth.status === "signedIn" ? <Button label={state.pending === "browser" ? "본인 확인 화면을 열었어요…" : "삭제 내용 확인·본인 인증으로"}
          disabled={!ready || !auth.user?.publicId || (Platform.OS === "web")}
          onPress={() => { if (auth.user && isActive()) void controller.current?.begin(auth.user.publicId); }} />
          : <Button label="로그인하고 계속" secondary disabled={!ready} onPress={() => router.push("/sign-in")} />}
        {Platform.OS === "web" && <Text style={styles.description}>설치한 앱에서 열어 주세요. 웹에서는 TranslaCat 계정 설정의 탈퇴·데이터 삭제를 이용해 주세요.</Text>}
      </>}
      {state.receipt && <>
        <Text style={styles.receipt}>접수 번호: {state.receipt.operationId}</Text>
        <Button label={state.pending === "status" ? "확인 중…" : "접수·삭제 처리 상태 확인"} secondary disabled={!ready} onPress={() => { void controller.current?.check(); }} />
      </>}
      {(state.receipt || state.error) && <>
        {!confirmForget ? <Button label="이 기기의 영수증 지우기" secondary disabled={!ready}
          onPress={() => setConfirmForget(true)} /> : <View style={styles.card}>
          <Text style={styles.description}>이 기기에서 처리 상태를 확인할 정보만 지워요. 이미 접수한 탈퇴는 취소되지 않고 계속 진행돼요. 삭제 완료를 아직 확인하지 못했다면 영수증을 남겨 두세요.</Text>
          <Button label="영수증 남겨 두기" secondary disabled={!ready} onPress={() => setConfirmForget(false)} />
          <Button label="확인했어요 · 기기 영수증만 지우기" disabled={!ready}
            onPress={() => { setConfirmForget(false); void controller.current?.forget(); }} />
        </View>}
      </>}
      {state.notice && <Text accessibilityLiveRegion="polite" style={styles.description}>{state.notice}</Text>}
      {state.error && <>
        <Text accessibilityRole="alert" style={styles.error}>{state.error}</Text>
        <Button label="기기 확인 정보 다시 불러오기" secondary disabled={!ready} onPress={() => { void controller.current?.restore(); }} />
      </>}
    </View>
  </Screen>;
}

const styles = StyleSheet.create({
  card: { gap: 16, marginTop: 16, backgroundColor: colors.surface, borderRadius: 22, padding: 20, borderWidth: 1, borderColor: colors.line },
  title: { fontSize: 20, lineHeight: 30, color: colors.ink, fontWeight: "700" },
  description: { fontSize: 14, lineHeight: 24, color: colors.muted },
  identity: { fontSize: 15, lineHeight: 24, color: colors.ink, fontWeight: "700" },
  receipt: { fontSize: 12, lineHeight: 20, color: colors.muted },
  error: { fontSize: 14, lineHeight: 23, color: colors.danger },
});
