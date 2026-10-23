import { StyleSheet, Text, TextInput, View } from "react-native";

import { Button } from "@/ui/components";
import { colors } from "@/ui/theme";

import type { AiProfileInput } from "./contracts";

interface AiProfileEditorProps {
  editing: boolean;
  form: AiProfileInput;
  disabled: boolean;
  busy: boolean;
  onFieldChange: (key: keyof AiProfileInput, value: string) => void;
  onSave: () => void;
  onCancel: () => void;
}

// 초안과 권한 revision은 화면이 소유하고, 이 컴포넌트는 입력 필드와 동작만 표시한다.
export function AiProfileEditor({ editing, form, disabled, busy, onFieldChange, onSave, onCancel }: AiProfileEditorProps) {
  return <View style={styles.card}>
    <Text style={styles.sectionTitle}>{editing ? "AI 수정" : "새 AI 추가"}</Text>
    <Text style={styles.copy}>AI 성격과 행동 지침은 방 소유자와 관리자만 볼 수 있어요.</Text>
    <Text style={styles.label}>닉네임 · 1~50자</Text>
    <TextInput accessibilityLabel="AI 닉네임" maxLength={50} value={form.nickname} onChangeText={value => onFieldChange("nickname", value)}
      editable={!disabled} style={styles.input} placeholder="대화에서 부를 이름" placeholderTextColor={colors.faint} />
    <Text style={styles.label}>소개 · 최대 200자</Text>
    <TextInput accessibilityLabel="AI 소개" maxLength={200} value={form.bio ?? ""} onChangeText={value => onFieldChange("bio", value)}
      editable={!disabled} style={styles.input} multiline placeholder="AI를 간단히 소개해 주세요" placeholderTextColor={colors.faint} />
    <Text style={styles.label}>원문 언어 코드 · 1~10자</Text>
    <TextInput accessibilityLabel="AI 원문 언어 코드" maxLength={10} value={form.originalLanguageCode} onChangeText={value => onFieldChange("originalLanguageCode", value)}
      editable={!disabled} style={styles.input} autoCapitalize="none" placeholder="예: ko, ja, en" placeholderTextColor={colors.faint} />
    <Text style={styles.label}>AI 성격과 행동 지침 · 1~4000자</Text>
    <TextInput accessibilityLabel="AI 성격과 행동 지침" maxLength={4000} value={form.personaPrompt} onChangeText={value => onFieldChange("personaPrompt", value)}
      editable={!disabled} style={[styles.input, styles.persona]} multiline placeholder="AI가 어떤 성격으로 대화하면 좋을까요?" placeholderTextColor={colors.faint} />
    <Text style={styles.small}>{form.personaPrompt.length}/4000</Text>
    <Button label={busy ? "저장 중…" : "AI 저장"} disabled={disabled} onPress={onSave} />
    <Button label="편집 취소" secondary disabled={busy} onPress={onCancel} />
  </View>;
}

const styles = StyleSheet.create({
  card: { padding: 20, gap: 12, borderRadius: 22, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface },
  sectionTitle: { color: colors.ink, fontSize: 19, lineHeight: 28, fontWeight: "700" },
  copy: { color: colors.muted, fontSize: 14, lineHeight: 23 },
  small: { color: colors.muted, fontSize: 12, lineHeight: 20 },
  label: { color: colors.ink, fontSize: 14, lineHeight: 22, fontWeight: "600", marginTop: 10 },
  input: { borderRadius: 14, borderWidth: 1, borderColor: colors.line, padding: 13, minHeight: 48, color: colors.ink,
    backgroundColor: colors.background, fontSize: 15, lineHeight: 23, textAlignVertical: "top" },
  persona: { minHeight: 180 },
});
