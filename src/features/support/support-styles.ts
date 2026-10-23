import { StyleSheet } from "react-native";

import { colors } from "@/ui/theme";

export const supportStyles = StyleSheet.create({
  fill: { flex: 1 },
  content: { gap: 16, paddingBottom: 20 },
  card: { padding: 18, borderRadius: 20, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface, gap: 12 },
  title: { color: colors.ink, fontSize: 18, lineHeight: 28, fontWeight: "700", flexShrink: 1 },
  helper: { color: colors.muted, fontSize: 14, lineHeight: 23 },
  meta: { color: colors.muted, fontSize: 12, lineHeight: 20 },
  body: { color: colors.ink, fontSize: 15, lineHeight: 25 },
  error: { color: colors.danger, fontSize: 14, lineHeight: 23 },
  label: { color: colors.ink, fontSize: 14, lineHeight: 23, fontWeight: "700" },
  input: { minHeight: 50, borderRadius: 14, borderWidth: 1, borderColor: colors.line, padding: 14, backgroundColor: colors.background, color: colors.ink, fontSize: 15, lineHeight: 24 },
  editor: { minHeight: 150 },
  counter: { color: colors.muted, fontSize: 12, lineHeight: 20, textAlign: "right" },
  categories: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  category: { paddingHorizontal: 12, paddingVertical: 10, minHeight: 44, borderWidth: 1, borderColor: colors.line, borderRadius: 14, maxWidth: "100%" },
  categoryLabel: { color: colors.muted, fontSize: 14, lineHeight: 23, flexShrink: 0 },
  selected: { borderColor: colors.blue, backgroundColor: colors.blueSoft },
  selectedLabel: { color: colors.blueDark, fontWeight: "700" },
  badges: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
  staffCard: { borderColor: colors.blueLine, backgroundColor: colors.blueSoft },
  warning: { padding: 18, borderRadius: 20, borderWidth: 1, borderColor: colors.warning, backgroundColor: colors.warningSoft, gap: 12 },
  confirmation: { padding: 18, borderRadius: 20, borderWidth: 1, borderColor: colors.blue, backgroundColor: colors.blueSoft, gap: 12 },
  pagination: { gap: 12, alignItems: "stretch" },
});
