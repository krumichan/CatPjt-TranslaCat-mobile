import { useRouter } from "expo-router";
import * as Clipboard from "expo-clipboard";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Share, StyleSheet, Text, View } from "react-native";

import { ActionRow, AppHeader, BrandMark, BrandWordmark, Button, InfoCard, PageHeading, Screen, StatusBadge } from "@/ui/components";
import { colors } from "@/ui/theme";
import { useAuth } from "@/auth/AuthProvider";
import { accountIdentity, createIdentityActions } from "@/domain/identity";
import { useNotifications } from "@/notifications/NotificationProvider";
import { useActivityGate } from "@/realtime/useActivity";
import { NotificationPreferenceControl } from "@/features/notification-preferences/NotificationPreferenceControl";
import { LegalLinks } from "@/features/auth/LegalLinks";

function AccountIdentity({ disabled }: { disabled: boolean }) {
  const auth = useAuth();
  const { active, isActive } = useActivityGate();
  const { sessionKey, isCurrentSession } = auth;
  const identity = accountIdentity(auth);
  const [actions] = useState(() => createIdentityActions({
    publicId: identity.publicId,
    sessionKey,
    isCurrent: key => isCurrentSession(key) && isActive(),
    copy: value => Clipboard.setStringAsync(value),
    share: async value => {
      const result = await Share.share({ message: value, title: "나의 TranslaCat ID" });
      return result.action === Share.sharedAction ? "shared" : "dismissed";
    },
  }));
  const actionState = useSyncExternalStore(actions.subscribe, actions.getSnapshot, actions.getSnapshot);
  useEffect(() => { actions.attach(); return actions.detach; }, [actions]);
  useEffect(() => { actions.updateIdentity(identity.publicId, sessionKey); }, [actions, identity.publicId, sessionKey]);
  useEffect(() => { if (!active) actions.cancel(); }, [active, actions]);
  const locked = disabled || !active || actionState.pending !== null;

  return (
    <View style={styles.identityCard}>
      <Text accessibilityRole="header" style={styles.identityLabel}>나의 TranslaCat ID</Text>
      {identity.publicId !== null && <Text selectable accessibilityLabel={`나의 TranslaCat ID, ${identity.publicId}`} style={styles.publicId}>{identity.publicId}</Text>}
      <Text style={styles.identityHelp}>{identity.message}</Text>
      {identity.status === "ready" && (
        <View style={styles.identityActions}>
          <Button label={actionState.pending === "copy" ? "복사 중…" : "TranslaCat ID 복사"} disabled={locked} onPress={() => { void actions.copy(); }} />
          <Button label={actionState.pending === "share" ? "공유 중…" : "ID 공유"} secondary disabled={locked} onPress={() => { void actions.share(); }} />
        </View>
      )}
      {identity.status === "unavailable" && <Button label="계정 정보 다시 확인" secondary disabled={disabled || !active} onPress={() => { void auth.retryRestore(); }} />}
      {actionState.message && <Text accessibilityRole={actionState.error ? "alert" : undefined} accessibilityLiveRegion="polite" style={actionState.error ? styles.error : styles.identityFeedback}>{actionState.message}</Text>}
    </View>
  );
}

export default function SettingsScreen() {
  const router = useRouter();
  const auth = useAuth();
  const notifications = useNotifications();
  const [busy, setBusy] = useState(false);
  const signOut = async () => {
    // 기존 기기 등록 해제·세션 정리 흐름을 기다리는 동안 중복 동작을 막는다.
    setBusy(true);
    try {
      await auth.signOut();
    } finally {
      setBusy(false);
    }
  };

  // 등록 상태만 표시하며 실제 알림 수신 여부로 확대해 표현하지 않는다.
  const notificationDescription = notifications.status === "connected"
    ? "이 기기의 알림 등록이 연결됐어요. 아래 전체 푸시 알림과 방별 무음, 휴대폰의 알림·절전 설정에 따라 실제 수신이 달라요."
    : notifications.status === "syncing" ? "휴대폰의 알림 연결을 확인하고 있어요."
      : notifications.status === "permission-blocked" ? "휴대폰 설정에서 TranslaCat 알림을 허용한 뒤 다시 연결해 주세요."
        : notifications.status === "permission-required" ? "알림을 허용하면 참여한 대화방의 새 메시지를 받을 수 있어요."
          : notifications.status === "retry" ? "알림을 연결하지 못했어요. 인터넷 연결을 확인한 뒤 다시 시도해 주세요."
            : notifications.status === "unavailable" ? "설치한 Android 또는 iPhone 앱에서 알림을 연결할 수 있어요."
              : "로그인하면 이 계정의 알림을 연결할 수 있어요.";

  return (
    <Screen>
      <AppHeader />
      <PageHeading title="설정" description="나의 계정과 대화를 관리해요." />
      <View style={styles.accountCard}>
        <View style={styles.accountIdentity}>
          <BrandMark />
          <View style={styles.accountCopy}>
            <StatusBadge label={auth.status === "signedIn" ? "내 계정" : auth.status === "restoring" ? "계정 확인 중" : "함께 시작해요"} />
            <Text style={styles.welcome}>{auth.user ? auth.user.name + "님" : "반가워요!"}</Text>
          </View>
        </View>
        {!auth.user && <Text style={styles.description}>{auth.status === "restoring" ? "로그인 상태를 확인하고 있어요." : "로그인하고 친구와 대화를 이어가세요."}</Text>}
        <AccountIdentity disabled={busy} />
        <View style={styles.accountActions}>
          {auth.status === "signedIn" ? (
            <Button label={busy ? "로그아웃 중…" : "이 기기에서 로그아웃"} onPress={() => void signOut()} secondary disabled={busy} />
          ) : auth.status === "signedOut" && (
            <Button label="로그인" onPress={() => router.push("/sign-in")} disabled={busy} />
          )}
          {auth.canRetryRestore && (
            <Button label="로그인 상태 다시 확인" secondary onPress={() => void auth.retryRestore()} disabled={busy} />
          )}
          {auth.error === "SESSION_EXPIRED" && <Text accessibilityRole="alert" style={styles.error}>로그인이 만료됐어요. 다시 로그인해 주세요.</Text>}
          {auth.error === "SESSION_RESTORE_UNAVAILABLE" && <Text accessibilityRole="alert" style={styles.error}>연결을 확인한 뒤 로그인 상태를 다시 확인해 주세요.</Text>}
          {auth.error === "SIGN_OUT_INCOMPLETE" && (
            <>
              <Text accessibilityRole="alert" style={styles.error}>로그아웃을 마무리하지 못했어요. 연결을 확인하고 다시 시도해 주세요.</Text>
              <Button label="로그아웃 다시 시도" secondary onPress={() => void signOut()} disabled={busy} />
            </>
          )}
        </View>
      </View>
      {auth.status === "signedIn" && <View style={styles.notificationCard}>
        <ActionRow title="사용자 차단 관리" description="TranslaCat ID로 차단하고 차단한 사용자 확인·해제" onPress={() => router.push("/blocks")} />
      </View>}
      <View style={styles.notificationCard}>
        <ActionRow title="문의함" description="문의 작성·내 문의 목록·운영 답변 확인" onPress={() => router.push("/support")} />
      </View>
      <View style={styles.notificationCard}>
        <ActionRow title="계정 탈퇴·데이터 삭제" description="삭제 범위 확인·본인 재인증·처리 상태 조회" onPress={() => router.push("/account-deletion")} />
      </View>
      <View style={styles.notificationCard}>
        <View style={styles.sectionHeading}>
          <Text accessibilityRole="header" style={styles.cardTitle}>알림</Text>
          <StatusBadge
            label={notifications.status === "connected" ? "기기 연결됨"
              : notifications.status === "syncing" ? "확인 중"
                : notifications.status === "permission-blocked" || notifications.status === "retry" ? "확인 필요" : "연결 전"}
            tone={notifications.status === "connected" ? "success"
              : notifications.status === "permission-blocked" || notifications.status === "retry" ? "warning" : "neutral"}
          />
        </View>
        {auth.status === "signedIn" && <View style={styles.preferenceSection}><NotificationPreferenceControl disabled={busy} /></View>}
        <Text style={styles.description}>{notificationDescription}</Text>
        {auth.status === "signedIn" && notifications.status !== "unavailable" && (
          <View style={styles.notificationActions}>
            {notifications.status === "permission-required" && <Button label="새 메시지 알림 켜기" onPress={() => void notifications.enable()} />}
            {notifications.status === "permission-blocked" && <Button label="휴대폰 알림 설정 열기" onPress={() => void notifications.openSettings()} />}
            <Button label="알림 연결 다시 확인" secondary disabled={notifications.status === "syncing"} onPress={() => void notifications.retry()} />
          </View>
        )}
      </View>
      {notifications.tapState === "login-required" && <InfoCard title="알림 열기">로그인 후 알림의 대화방 참여 상태를 확인해요.</InfoCard>}
      {notifications.tapState === "waiting" && <InfoCard title="알림 열기">알림 계정 연결을 확인하고 있어요. 연결되지 않으면 알림 연결을 다시 확인해 주세요.</InfoCard>}
      {notifications.tapState === "wrong-account" && <InfoCard title="알림 열기">현재 계정에 해당하는 알림이 아니에요. 대화방을 열지 않았어요.</InfoCard>}
      {notifications.tapState === "retry" && <InfoCard title="알림 열기">연결이 원활하지 않아 대화방을 열지 못했어요. 인터넷 연결을 확인한 뒤 위의 알림 연결 다시 확인을 눌러 주세요.</InfoCard>}
      {notifications.tapState === "unavailable" && <InfoCard title="알림 열기">대화방에 접근할 수 없거나 연결을 확인하지 못했어요. 내 채팅에서 참여 상태를 확인해 주세요.</InfoCard>}
      {__DEV__ && (
        <View style={styles.devSection}>
          <Text style={styles.sectionTitle}>개발 도구</Text>
          <ActionRow title="개발 점검" description="앱 설정과 알림 연결 준비 상태 확인" onPress={() => router.push("/dev/setup")} />
        </View>
      )}
      <LegalLinks />
      <View style={styles.footer}>
        <BrandWordmark width={130} />
        <Text style={styles.footerTagline}>언어를 넘어, 대화를 잇다</Text>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  accountCard: { padding: 20, borderRadius: 24, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line },
  accountIdentity: { flexDirection: "row", alignItems: "center", gap: 16 },
  accountCopy: { flex: 1, gap: 7 },
  welcome: { fontSize: 20, fontWeight: "700", lineHeight: 29, letterSpacing: -0.6, color: colors.ink },
  identityCard: { marginTop: 20, padding: 16, borderRadius: 18, backgroundColor: colors.background, gap: 12 },
  identityLabel: { fontSize: 13, lineHeight: 20, color: colors.muted, fontWeight: "700" },
  publicId: { fontSize: 20, lineHeight: 28, fontWeight: "700", color: colors.ink },
  identityHelp: { fontSize: 13, lineHeight: 21, color: colors.muted },
  identityActions: { gap: 10 },
  identityFeedback: { fontSize: 13, lineHeight: 21, color: colors.blue },
  description: { fontSize: 14, lineHeight: 23, color: colors.muted, marginTop: 12 },
  accountActions: { gap: 12, marginTop: 20 },
  error: { fontSize: 13, lineHeight: 22, color: colors.danger },
  notificationCard: { marginTop: 18, padding: 20, borderRadius: 24, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line },
  sectionHeading: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 10, justifyContent: "space-between" },
  cardTitle: { color: colors.ink, fontSize: 17, lineHeight: 25, fontWeight: "700" },
  notificationActions: { gap: 12, marginTop: 20 },
  preferenceSection: { marginTop: 16 },
  devSection: { marginTop: 28, gap: 12 },
  sectionTitle: { fontSize: 13, fontWeight: "700", color: colors.muted, paddingLeft: 3 },
  footer: { alignItems: "center", paddingTop: 36, gap: 10 },
  footerTagline: { fontSize: 12, lineHeight: 20, color: colors.muted },
});

