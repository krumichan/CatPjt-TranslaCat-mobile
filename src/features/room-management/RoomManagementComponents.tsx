import type { ReactNode } from "react";
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { colors } from "@/ui/theme";
import { ProfileAvatar } from "@/ui/ProfileAvatar";

export function ManagementCard({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return <View style={styles.card}>
    <Text accessibilityRole="header" style={styles.sectionTitle}>{title}</Text>
    {description && <Text style={styles.copy}>{description}</Text>}
    {children}
  </View>;
}

export function ManagementAction({ label, onPress, disabled = false, danger = false, secondary = false }: {
  label: string; onPress: () => void; disabled?: boolean; danger?: boolean; secondary?: boolean;
}) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [styles.action, secondary && styles.secondary, danger && styles.dangerAction,
      disabled && styles.disabled, pressed && styles.pressed]}>
    <Text style={[styles.actionText, secondary && styles.secondaryText, danger && styles.dangerText]}>{label}</Text>
  </Pressable>;
}

export function ManagementMessage({ error, notice }: { error?: string | null; notice?: string | null }) {
  return <>
    {error && <View style={styles.errorBox}><Text accessibilityRole="alert" style={styles.errorText}>{error}</Text></View>}
    {notice && <View style={styles.noticeBox}><Text accessibilityRole="alert" style={styles.noticeText}>{notice}</Text></View>}
  </>;
}

export function ParticipantIdentity({ name, detail, role, mine = false, active = true, imageUrl }: {
  name: string; detail?: string | null; role?: string; mine?: boolean; active?: boolean; imageUrl?: string | null;
}) {
  const roleLabel = role === "OWNER" ? "방장" : role === "ADMIN" ? "관리자" : "참여자";
  return <View style={styles.identity}>
    <ProfileAvatar name={name} imageUrl={imageUrl} />
    <View style={styles.identityCopy}>
      <View style={styles.nameRow}>
        <Text style={styles.name}>{name}{mine ? " (나)" : ""}</Text>
        {role && <View style={styles.badge}><Text style={styles.badgeText}>{roleLabel}</Text></View>}
      </View>
      {detail && <Text style={styles.detail}>{detail}</Text>}
      {!active && <Text style={styles.detail}>현재 참여하지 않는 멤버예요.</Text>}
    </View>
  </View>;
}

export interface ManagementConfirmation {
  title: string;
  description: string;
  confirmLabel: string;
  danger?: boolean;
  requireReason?: boolean;
  onConfirm: (reason: string) => void;
}

export function ConfirmationDialog({ confirmation, reason, onReasonChange, onCancel, disabled = false }: {
  confirmation: ManagementConfirmation | null; reason: string; onReasonChange: (value: string) => void;
  onCancel: () => void; disabled?: boolean;
}) {
  const reasonMissing = !!confirmation?.requireReason && !reason.trim();

  // 확인 화면을 닫아도 서버 요청은 새로 만들지 않는다. 실행은 명시적인 확인 버튼에서만 시작한다.
  return <Modal visible={confirmation !== null} transparent animationType="fade" onRequestClose={onCancel}>
    <SafeAreaView style={styles.overlay}>
      <KeyboardAvoidingView style={styles.dialogOuter} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View style={styles.dialog} accessibilityViewIsModal>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.dialogContent}>
            <Text accessibilityRole="header" style={styles.dialogTitle}>{confirmation?.title}</Text>
            <Text style={styles.copy}>{confirmation?.description}</Text>
            {confirmation?.requireReason && <View style={styles.reasonField}>
              <Text style={styles.label}>강퇴 및 재입장 차단 사유</Text>
              <TextInput accessibilityLabel="강퇴 및 재입장 차단 사유" value={reason} onChangeText={onReasonChange}
                placeholder="사유를 입력해 주세요" placeholderTextColor={colors.faint} maxLength={500} multiline
                editable={!disabled} style={[managementStyles.input, styles.reasonInput]} />
              <Text style={styles.detail}>{reason.length}/500 · 사유를 입력해야 진행할 수 있어요.</Text>
            </View>}
            <ManagementAction label={confirmation?.confirmLabel ?? "확인"} danger={confirmation?.danger}
              disabled={disabled || reasonMissing || !confirmation} onPress={() => confirmation?.onConfirm(reason.trim())} />
            <ManagementAction label="취소" secondary onPress={onCancel} />
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  </Modal>;
}

export const managementStyles = StyleSheet.create({
  body: { gap: 18, paddingBottom: 26 },
  copy: { color: colors.muted, fontSize: 14, lineHeight: 23 },
  small: { color: colors.muted, fontSize: 12, lineHeight: 20 },
  label: { color: colors.ink, fontSize: 14, lineHeight: 22, fontWeight: "700" },
  input: { borderWidth: 1, borderColor: colors.line, borderRadius: 14, backgroundColor: colors.background,
    color: colors.ink, minHeight: 48, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15, lineHeight: 23 },
  row: { flexDirection: "row", alignItems: "center", gap: 10 },
  grow: { flex: 1, minWidth: 0 },
  member: { borderTopWidth: 1, borderColor: colors.line, paddingTop: 16, gap: 12 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  actionSlot: { flexGrow: 1, flexBasis: 130 },
});

const styles = StyleSheet.create({
  card: { padding: 20, gap: 14, borderRadius: 22, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface },
  sectionTitle: { color: colors.ink, fontSize: 19, lineHeight: 28, fontWeight: "700" },
  copy: { color: colors.muted, fontSize: 14, lineHeight: 23 },
  action: { minHeight: 48, borderWidth: 1, borderColor: colors.blue, borderRadius: 14,
    paddingHorizontal: 16, paddingVertical: 12, justifyContent: "center", alignItems: "center", backgroundColor: colors.blue },
  secondary: { backgroundColor: colors.surface, borderColor: colors.blueLine },
  dangerAction: { backgroundColor: colors.dangerSoft, borderColor: colors.danger },
  // 버튼의 최종 폭으로 줄을 계산하고, 여러 줄이 된 글자의 높이를 줄이지 않는다.
  actionText: { color: colors.surface, fontSize: 14, lineHeight: 22, fontWeight: "700", textAlign: "center",
    alignSelf: "stretch", flexShrink: 0 },
  secondaryText: { color: colors.blueDark },
  dangerText: { color: colors.danger },
  disabled: { opacity: 0.5 },
  pressed: { opacity: 0.72 },
  errorBox: { padding: 16, borderRadius: 16, backgroundColor: colors.dangerSoft },
  errorText: { color: colors.danger, fontSize: 14, lineHeight: 23 },
  noticeBox: { padding: 16, borderRadius: 16, backgroundColor: colors.blueSoft },
  noticeText: { color: colors.blueDark, fontSize: 14, lineHeight: 23 },
  identity: { flexDirection: "row", gap: 12, alignItems: "center" },
  identityCopy: { flex: 1, minWidth: 0, gap: 3 },
  avatar: { width: 44, height: 44, flexShrink: 0, borderRadius: 16, backgroundColor: colors.blueSoft, justifyContent: "center", alignItems: "center" },
  avatarText: { color: colors.blueDark, fontSize: 19, fontWeight: "700" },
  nameRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 7 },
  name: { color: colors.ink, fontSize: 16, lineHeight: 24, fontWeight: "700", flexShrink: 1, minWidth: 0 },
  badge: { backgroundColor: colors.blueSoft, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 12, maxWidth: "100%", flexShrink: 0 },
  badgeText: { color: colors.blueDark, fontSize: 11, lineHeight: 17, fontWeight: "700", flexShrink: 0 },
  detail: { color: colors.muted, fontSize: 12, lineHeight: 20 },
  overlay: { flex: 1, backgroundColor: "rgba(12, 28, 45, 0.4)" },
  dialogOuter: { flex: 1, padding: 20, justifyContent: "center", alignItems: "center" },
  dialog: { width: "100%", maxWidth: 480, maxHeight: "100%", borderRadius: 24, backgroundColor: colors.surface },
  dialogContent: { padding: 24, gap: 16 },
  dialogTitle: { color: colors.ink, fontSize: 21, lineHeight: 30, fontWeight: "800" },
  reasonField: { gap: 8 },
  label: { color: colors.ink, fontSize: 14, lineHeight: 22, fontWeight: "700" },
  reasonInput: { minHeight: 96, maxHeight: 180, textAlignVertical: "top" },
});
