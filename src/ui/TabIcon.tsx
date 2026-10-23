import { StyleSheet, View, type ColorValue } from "react-native";

import { colors } from "@/ui/theme";

export type IconKind = "chat" | "friends" | "open" | "settings";

interface TabIconProps {
  kind: IconKind;
  color?: ColorValue;
}

export function TabIcon({ kind, color }: TabIconProps) {
  const iconColor = color ?? colors.faint;
  const stroke = { borderColor: iconColor };

  // 네이티브 도형으로 아이콘을 그려 플랫폼별 문자 모양 차이를 피한다.
  return (
    <View style={styles.frame} accessible={false} importantForAccessibility="no-hide-descendants">
      {kind === "chat" && (
        <>
          <View style={[styles.bubble, stroke]} />
          <View style={[styles.bubbleTail, { backgroundColor: iconColor }]} />
          <View style={[styles.bubbleLine, { backgroundColor: iconColor }]} />
        </>
      )}
      {kind === "friends" && (
        <>
          <View style={[styles.friendHead, stroke]} />
          <View style={[styles.friendBody, stroke]} />
          <View style={[styles.secondHead, stroke]} />
          <View style={[styles.secondBody, stroke]} />
        </>
      )}
      {kind === "open" && (
        <>
          <View style={[styles.orbit, stroke]} />
          <View style={[styles.compass, { backgroundColor: iconColor }]} />
          <View style={[styles.compassCenter, { backgroundColor: iconColor }]} />
        </>
      )}
      {kind === "settings" && (
        <>
          {[6, 13, 20].map((top) => (
            <View key={top} style={[styles.settingLine, { top, backgroundColor: iconColor }]} />
          ))}
          <View style={[styles.settingKnob, stroke, { left: 7, top: 3 }]} />
          <View style={[styles.settingKnob, stroke, { left: 16, top: 10 }]} />
          <View style={[styles.settingKnob, stroke, { left: 9, top: 17 }]} />
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { width: 28, height: 28 },
  bubble: { position: "absolute", left: 3, top: 4, width: 23, height: 18, borderWidth: 2, borderRadius: 7 },
  bubbleTail: { position: "absolute", width: 3, height: 6, left: 7, top: 19, borderRadius: 1, transform: [{ rotate: "35deg" }] },
  bubbleLine: { position: "absolute", width: 11, height: 2, left: 9, top: 12, borderRadius: 1 },
  friendHead: { position: "absolute", left: 5, top: 3, width: 10, height: 10, borderWidth: 2, borderRadius: 5 },
  friendBody: { position: "absolute", left: 1, top: 16, width: 18, height: 9, borderWidth: 2, borderRadius: 8 },
  secondHead: { position: "absolute", left: 18, top: 6, width: 8, height: 8, borderWidth: 2, borderRadius: 4 },
  secondBody: { position: "absolute", left: 21, top: 17, width: 6, height: 8, borderTopWidth: 2, borderRightWidth: 2, borderTopRightRadius: 6 },
  orbit: { position: "absolute", left: 2, top: 2, width: 25, height: 25, borderWidth: 2, borderRadius: 13 },
  compass: { position: "absolute", left: 12, top: 7, width: 5, height: 14, borderRadius: 2, transform: [{ rotate: "40deg" }] },
  compassCenter: { position: "absolute", left: 12, top: 12, width: 5, height: 5, borderRadius: 3 },
  settingLine: { position: "absolute", left: 3, width: 23, height: 2, borderRadius: 1 },
  settingKnob: { position: "absolute", width: 8, height: 8, borderWidth: 2, borderRadius: 4, backgroundColor: "#FFFFFF" },
});
