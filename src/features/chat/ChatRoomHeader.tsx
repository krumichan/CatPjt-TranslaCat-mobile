import { useState } from "react";
import { ActivityIndicator, Keyboard, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { colors } from "@/ui/theme";

interface HeaderProps {
  title: string;
  refreshing: boolean;
  onBack: () => void;
  onRefresh: () => void;
  onLatest: () => void;
  onAiSettings?: () => void;
  onParticipants?: () => void;
  onRoomManagement?: () => void;
}

export function ChatRoomHeader({ title, refreshing, onBack, onRefresh, onLatest, onAiSettings, onParticipants, onRoomManagement }: HeaderProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const close = () => setMenuOpen(false);
  const select = (action: () => void) => { close(); action(); };

  // 평소 헤더는 한 줄만 차지하고 방별 기능은 키보드를 닫은 뒤 메뉴에서 선택한다.
  return (
    <>
      <View style={styles.header}>
        <Pressable accessibilityRole="button" accessibilityLabel="채팅 목록으로 돌아가기" onPress={onBack} style={styles.iconButton}>
          <Text style={styles.back} accessible={false} allowFontScaling={false}>‹</Text>
        </Pressable>
        <Text accessibilityRole="header" numberOfLines={1} style={styles.title}>{title}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="대화 새로고침" accessibilityState={{ disabled: refreshing, busy: refreshing }}
          disabled={refreshing} onPress={onRefresh} style={styles.iconButton}>
          {refreshing ? <ActivityIndicator size="small" color={colors.blue} /> : <Text style={styles.refresh} accessible={false} allowFontScaling={false}>↻</Text>}
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="대화방 메뉴" accessibilityState={{ expanded: menuOpen }}
          onPress={() => { Keyboard.dismiss(); setMenuOpen(true); }} style={styles.iconButton}>
          <Text style={styles.more} accessible={false} allowFontScaling={false}>⋮</Text>
        </Pressable>
      </View>
      <Modal visible={menuOpen} transparent animationType="fade" onRequestClose={close}>
        <View style={styles.overlay}>
          <Pressable accessibilityRole="button" accessibilityLabel="메뉴 닫기" style={StyleSheet.absoluteFill} onPress={close} />
          <SafeAreaView edges={["top", "left", "right"]} pointerEvents="box-none">
            <View style={styles.menu} accessibilityViewIsModal>
              <View style={styles.menuHeading}>
                <Text accessibilityRole="header" style={styles.menuTitle}>대화방 메뉴</Text>
                <Pressable accessibilityRole="button" accessibilityLabel="메뉴 닫기" onPress={close} style={styles.iconButton}>
                  <Text style={styles.close} accessible={false} allowFontScaling={false}>×</Text>
                </Pressable>
              </View>
              {onParticipants && <Pressable accessibilityRole="button" onPress={() => select(onParticipants)} style={styles.menuItem}>
                <Text style={styles.menuLabel}>참여자 보기</Text>
              </Pressable>}
              {onRoomManagement && <Pressable accessibilityRole="button" onPress={() => select(onRoomManagement)} style={styles.menuItem}>
                <Text style={styles.menuLabel}>방 관리 · 초대</Text>
              </Pressable>}
              {onAiSettings && <Pressable accessibilityRole="button" onPress={() => select(onAiSettings)} style={styles.menuItem}>
                <Text style={styles.menuLabel}>✦ AI와 대화 · 설정</Text>
              </Pressable>}
              <Pressable accessibilityRole="button" onPress={() => select(onLatest)} style={styles.menuItem}>
                <Text style={styles.menuLabel}>최신 메시지로 이동 ↓</Text>
              </Pressable>
            </View>
          </SafeAreaView>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 8, paddingVertical: 6,
    backgroundColor: colors.surface, borderBottomWidth: 1, borderBottomColor: colors.line, flexShrink: 0 },
  title: { flex: 1, minWidth: 0, color: colors.ink, fontSize: 18, lineHeight: 26, fontWeight: "700" },
  iconButton: { width: 44, height: 44, flexShrink: 0, alignItems: "center", justifyContent: "center", borderRadius: 14 },
  back: { fontSize: 34, lineHeight: 38, color: colors.ink },
  refresh: { fontSize: 28, lineHeight: 34, color: colors.blueDark },
  more: { fontSize: 28, lineHeight: 34, color: colors.ink },
  overlay: { flex: 1, backgroundColor: "rgba(12, 28, 45, 0.3)" },
  menu: { margin: 12, padding: 12, borderRadius: 20, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line },
  menuHeading: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingLeft: 12 },
  menuTitle: { flex: 1, minWidth: 0, color: colors.ink, fontSize: 17, lineHeight: 26, fontWeight: "700" },
  close: { fontSize: 26, color: colors.muted },
  menuItem: { minHeight: 52, paddingHorizontal: 14, paddingVertical: 12, justifyContent: "center", borderRadius: 12 },
  menuLabel: { color: colors.blueDark, fontSize: 15, lineHeight: 24, fontWeight: "600" },
});
