import { StyleSheet } from "react-native";

import { colors } from "@/ui/theme";

export const styles = StyleSheet.create({
  content: { gap: 18, paddingBottom: 18 },
  searchCard: { backgroundColor: colors.surface, borderRadius: 22, padding: 20, borderWidth: 1, borderColor: colors.line, gap: 12 },
  section: { gap: 12 }, sectionTitle: { color: colors.ink, fontWeight: "800", fontSize: 18, lineHeight: 26 },
  helper: { color: colors.muted, fontSize: 13, lineHeight: 21 },
  input: { color: colors.ink, borderWidth: 1, borderColor: colors.line, borderRadius: 14, backgroundColor: colors.background, paddingHorizontal: 14, paddingVertical: 13, minHeight: 48 },
  result: { gap: 10, paddingTop: 10 }, name: { color: colors.ink, fontSize: 16, lineHeight: 23, fontWeight: "700" },
  error: { color: "#B33E4D", fontSize: 14, lineHeight: 22 },
  card: { backgroundColor: colors.surface, borderRadius: 18, padding: 16, gap: 10, borderWidth: 1, borderColor: colors.line },
  row: { flexDirection: "row", gap: 10 }, grow: { flex: 1, minWidth: 0 },
  friendRow: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: colors.surface, borderRadius: 18, padding: 15, borderWidth: 1, borderColor: colors.line },
  avatar: { width: 44, height: 44, borderRadius: 16, backgroundColor: colors.blueSoft, alignItems: "center", justifyContent: "center" },
  avatarText: { color: colors.blueDark, fontSize: 19, fontWeight: "700" },
  select: { minHeight: 44, minWidth: 58, borderRadius: 12, backgroundColor: colors.blueSoft, alignItems: "center", justifyContent: "center", padding: 10 },
  selected: { borderWidth: 2, borderColor: colors.blue },
  selectText: { color: colors.blueDark, fontWeight: "700", fontSize: 13, lineHeight: 21,
    alignSelf: "stretch", flexShrink: 0, textAlign: "center" },
});
