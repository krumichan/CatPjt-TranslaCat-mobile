import { Pressable, StyleSheet, Text, View } from "react-native";

import { Button } from "@/ui/components";
import { colors } from "@/ui/theme";

import { useNotificationPreference } from "./useNotificationPreference";

export function NotificationPreferenceControl({ roomId, disabled = false }: { roomId?: string; disabled?: boolean }) {
  const preference = useNotificationPreference(roomId, !disabled);
  const { state } = preference;
  const title = roomId ? "이 방 무음" : "전체 푸시 알림";
  const locked = disabled || !preference.available || state.loading || state.saving || state.uncertain || state.value === null;
  const label = state.value === null ? "확인 전" : roomId ? state.value ? "무음" : "알림 받기" : state.value ? "켜짐" : "꺼짐";

  return <View style={styles.body}>
    <Pressable accessibilityRole="switch" accessibilityLabel={title}
      accessibilityState={{ checked: state.value === true, disabled: locked, busy: state.loading || state.saving }}
      disabled={locked} onPress={() => preference.setValue(!state.value)}
      style={({ pressed }) => [styles.toggle, locked && styles.locked, pressed && styles.pressed]}>
      <View style={styles.copy}>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.value}>{state.saving ? "저장 중…" : state.loading ? "확인 중…" : label}</Text>
      </View>
      <View accessible={false} style={[styles.track, state.value && styles.checkedTrack]}>
        <View style={[styles.thumb, state.value && styles.checkedThumb]} />
      </View>
    </Pressable>
    <Text style={styles.description}>{roomId
      ? "이 계정의 이 방 새 메시지 푸시만 무음으로 바꿔요. 오픈채팅 초대와 안읽음 수는 그대로예요. 전체 알림이 꺼져 있으면 이 방도 푸시를 받지 않아요."
      : "끄면 이 계정의 모든 기기에서 새 메시지와 오픈채팅 초대 푸시를 멈춰요. 대화와 초대함, 안읽음 수는 그대로예요."}</Text>
    {state.error && <Text accessibilityRole="alert" style={styles.error}>{state.error}</Text>}
    {state.notice && <Text accessibilityLiveRegion="polite" style={styles.notice}>{state.notice}</Text>}
    {state.error && <Button label="알림 설정 다시 불러오기" secondary disabled={!preference.available || state.loading || state.saving} onPress={preference.reload} />}
  </View>;
}

const styles = StyleSheet.create({
  body: { gap: 12 },
  toggle: { minHeight: 64, borderRadius: 16, padding: 14, borderWidth: 1, borderColor: colors.blueLine,
    backgroundColor: colors.background, flexDirection: "row", gap: 14, alignItems: "center" },
  copy: { flex: 1, minWidth: 0, gap: 4 },
  title: { color: colors.ink, fontSize: 15, lineHeight: 23, fontWeight: "700", flexShrink: 0 },
  value: { color: colors.blueDark, fontSize: 13, lineHeight: 21 },
  description: { color: colors.muted, fontSize: 13, lineHeight: 22 },
  track: { width: 48, height: 28, borderRadius: 14, padding: 3, backgroundColor: colors.line, flexShrink: 0 },
  checkedTrack: { backgroundColor: colors.blue },
  thumb: { width: 22, height: 22, borderRadius: 11, backgroundColor: colors.surface },
  checkedThumb: { alignSelf: "flex-end" },
  locked: { opacity: 0.6 },
  pressed: { opacity: 0.75 },
  error: { color: colors.danger, fontSize: 13, lineHeight: 22 },
  notice: { color: colors.blueDark, fontSize: 13, lineHeight: 22 },
});
