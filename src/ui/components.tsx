import type { ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";

import { BrandWordmark } from "@/ui/Brand";
import { TabIcon, type IconKind } from "@/ui/TabIcon";
import { colors } from "@/ui/theme";

export { BrandMark, BrandWordmark } from "@/ui/Brand";

export function Screen({ children }: { children: ReactNode }) {
  const insets = useSafeAreaInsets();

  return (
    <SafeAreaView style={styles.screen} edges={["top", "left", "right"]}>
      <ScrollView
        contentContainerStyle={[
          styles.scrollContent,
          { paddingBottom: Math.max(insets.bottom + 16, 32) },
        ]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.content}>{children}</View>
      </ScrollView>
    </SafeAreaView>
  );
}

export function AppHeader() {
  return (
    <View style={styles.appHeader}>
      <BrandWordmark />
      <View style={styles.serviceBadge}>
        <View style={styles.serviceDot} />
        <Text style={styles.serviceLabel}>채팅</Text>
      </View>
    </View>
  );
}

export function StatusBadge({
  label,
  tone = "neutral",
}: {
  label: string;
  tone?: "neutral" | "success" | "warning";
}) {
  return (
    <View style={[styles.statusBadge, tone === "success" && styles.successBadge, tone === "warning" && styles.warningBadge]}>
      <Text style={[styles.statusLabel, tone === "success" && styles.successLabel, tone === "warning" && styles.warningLabel]}>{label}</Text>
    </View>
  );
}

export function PageHeading({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <View style={styles.heading}>
      <Text accessibilityRole="header" style={styles.pageTitle}>
        {title}
      </Text>
      <Text style={styles.pageDescription}>{description}</Text>
    </View>
  );
}

export function Button({
  label,
  onPress,
  secondary = false,
  disabled = false,
  leading,
}: {
  label: string;
  onPress: () => void;
  secondary?: boolean;
  disabled?: boolean;
  leading?: ReactNode;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        secondary && styles.secondaryButton,
        disabled && styles.disabled,
        pressed && styles.pressed,
      ]}
    >
      {leading && <View accessible={false} importantForAccessibility="no-hide-descendants">{leading}</View>}
      <Text style={[styles.buttonLabel, secondary && styles.secondaryButtonLabel]}>{label}</Text>
    </Pressable>
  );
}

export function EmptyCard({
  kind,
  title,
  description,
  onSignIn,
}: {
  kind: IconKind;
  title: string;
  description: string;
  onSignIn: () => void;
}) {
  return (
    <View style={styles.emptyCard}>
      <View style={styles.emptyArt} accessible={false}>
        <View style={styles.artHalo} />
        <View style={styles.artTile}>
          <View style={styles.artIcon}><TabIcon kind={kind} color={colors.blue} /></View>
        </View>
        <View style={styles.artDotOne} />
        <View style={styles.artDotTwo} />
      </View>
      <Text style={styles.cardTitle}>{title}</Text>
      <Text style={styles.cardDescription}>{description}</Text>
      <View style={styles.cardButton}>
        <Button label="로그인하고 시작하기" onPress={onSignIn} />
      </View>
    </View>
  );
}

export function InfoCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={styles.infoCard}>
      <Text style={styles.infoTitle}>{title}</Text>
      <Text style={styles.infoDescription}>{children}</Text>
    </View>
  );
}

export function BackButton({ onPress }: { onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="이전 화면으로"
      onPress={onPress}
      style={styles.backButton}
    >
      <Text style={styles.backArrow} accessible={false}>‹</Text>
      <Text style={styles.backLabel}>돌아가기</Text>
    </Pressable>
  );
}

export function ActionRow({
  title,
  description,
  onPress,
}: {
  title: string;
  description: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.actionRow, pressed && styles.pressed]}
    >
      <View style={styles.actionCopy}>
        <Text style={styles.actionTitle}>{title}</Text>
        <Text style={styles.actionDescription}>{description}</Text>
      </View>
      <Text style={styles.actionArrow} accessible={false}>›</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  scrollContent: { flexGrow: 1 },
  content: {
    width: "100%",
    maxWidth: 680,
    alignSelf: "center",
    paddingHorizontal: 20,
  },
  appHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    paddingTop: 16,
    paddingBottom: 20,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  serviceBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    borderRadius: 20,
    backgroundColor: colors.chatSoft,
    paddingVertical: 6,
    paddingHorizontal: 9,
    flexShrink: 1,
  },
  serviceDot: { width: 5, height: 5, flexShrink: 0, borderRadius: 3, backgroundColor: colors.chat },
  serviceLabel: { fontSize: 12, lineHeight: 18, fontWeight: "700", color: colors.chat, flexShrink: 1, minWidth: 0 },
  statusBadge: { alignSelf: "flex-start", borderRadius: 20, paddingVertical: 5, paddingHorizontal: 10, backgroundColor: colors.blueSoft, maxWidth: "100%", flexShrink: 0 },
  statusLabel: { color: colors.blueDark, fontSize: 12, lineHeight: 18, fontWeight: "700", flexShrink: 0 },
  successBadge: { backgroundColor: colors.successSoft },
  successLabel: { color: colors.success },
  warningBadge: { backgroundColor: colors.warningSoft },
  warningLabel: { color: colors.warning },
  heading: { marginTop: 26, marginBottom: 24, gap: 8 },
  pageTitle: { fontSize: 30, lineHeight: 42, fontWeight: "800", letterSpacing: -1.1, color: colors.ink },
  pageDescription: { fontSize: 15, lineHeight: 23, color: colors.muted },
  button: {
    minHeight: 52,
    borderRadius: 14,
    backgroundColor: colors.blue,
    borderWidth: 1,
    borderColor: colors.blue,
    flexDirection: "row",
    gap: 10,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 14,
    paddingHorizontal: 20,
  },
  secondaryButton: { backgroundColor: colors.surface, borderColor: colors.blueLine },
  buttonLabel: { color: colors.surface, fontSize: 15, lineHeight: 22, fontWeight: "700", textAlign: "center", flexShrink: 1 },
  secondaryButtonLabel: { color: colors.blueDark },
  pressed: { opacity: 0.72 },
  disabled: { opacity: 0.5 },
  emptyCard: {
    paddingHorizontal: 22,
    paddingTop: 32,
    paddingBottom: 26,
    borderRadius: 26,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
    alignItems: "center",
  },
  emptyArt: {
    width: 140,
    height: 120,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 16,
  },
  artHalo: {
    width: 112,
    height: 112,
    borderRadius: 56,
    position: "absolute",
    backgroundColor: colors.blueSoft,
  },
  artTile: {
    width: 80,
    height: 74,
    borderRadius: 24,
    backgroundColor: colors.blueSoft,
    borderWidth: 1,
    borderColor: colors.blueLine,
    alignItems: "center",
    justifyContent: "center",
    transform: [{ rotate: "-7deg" }],
  },
  artIcon: { transform: [{ scale: 1.4 }, { rotate: "7deg" }] },
  artDotOne: {
    position: "absolute",
    top: 16,
    right: 15,
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: colors.blueLine,
  },
  artDotTwo: {
    position: "absolute",
    bottom: 13,
    left: 13,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.chat,
  },
  cardTitle: {
    fontSize: 21,
    fontWeight: "700",
    letterSpacing: -0.6,
    lineHeight: 30,
    color: colors.ink,
    textAlign: "center",
  },
  cardDescription: {
    fontSize: 14,
    lineHeight: 23,
    textAlign: "center",
    color: colors.muted,
    marginTop: 10,
  },
  cardButton: { alignSelf: "stretch", marginTop: 26 },
  infoCard: {
    marginTop: 18,
    borderRadius: 20,
    backgroundColor: colors.blueSoft,
    padding: 20,
    gap: 8,
  },
  infoTitle: { color: colors.ink, fontSize: 14, fontWeight: "700", lineHeight: 21 },
  infoDescription: { color: colors.muted, fontSize: 13, lineHeight: 22 },
  backButton: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 7,
    paddingVertical: 14,
    minHeight: 48,
    paddingRight: 16,
  },
  backArrow: { color: colors.ink, fontSize: 32, lineHeight: 32 },
  backLabel: { color: colors.muted, fontSize: 14, fontWeight: "600" },
  actionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
    borderRadius: 18,
    padding: 18,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
    minHeight: 72,
  },
  actionCopy: { flex: 1, gap: 5 },
  actionTitle: { color: colors.ink, fontSize: 15, fontWeight: "600" },
  actionDescription: { color: colors.muted, fontSize: 13, lineHeight: 20 },
  actionArrow: { color: colors.faint, fontSize: 25 },
});
