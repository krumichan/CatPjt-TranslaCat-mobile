import { Tabs } from "expo-router";
import { StyleSheet, View, useWindowDimensions, type ColorValue } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { TabIcon, type IconKind } from "@/ui/TabIcon";
import { colors } from "@/ui/theme";
import { useNotifications } from "@/notifications/NotificationProvider";

function NavigationIcon({ kind, color, focused }: { kind: IconKind; color: ColorValue | null; focused: boolean }) {
  const iconColor = typeof color === "string" ? color : focused ? colors.chat : colors.muted;
  return (
    <View style={[styles.icon, focused && styles.activeIcon]}>
      <TabIcon kind={kind} color={iconColor} />
    </View>
  );
}

export default function TabsLayout() {
  const { attentionCount } = useNotifications();
  const insets = useSafeAreaInsets();
  const { fontScale } = useWindowDimensions();
  const labelExtraHeight = Math.ceil(16 * Math.max(0, fontScale - 1));

  // 시스템 글자 확대분을 라벨 높이에 더하고 홈 표시줄 여백을 별도로 확보한다.
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.chat,
        tabBarInactiveTintColor: colors.muted,
        tabBarStyle: {
          backgroundColor: colors.surface,
          borderTopColor: colors.line,
          height: 74 + labelExtraHeight + insets.bottom,
          paddingTop: 8,
          paddingBottom: Math.max(insets.bottom, 8),
        },
        tabBarLabelPosition: "below-icon",
        tabBarLabelStyle: {
          fontSize: 11,
          lineHeight: 16,
          fontWeight: "600",
          marginTop: 5,
          flexShrink: 0,
        },
        tabBarItemStyle: { paddingBottom: 0 },
        sceneStyle: { backgroundColor: colors.background },
      }}
    >
      <Tabs.Screen name="index" options={{ title: "채팅", tabBarBadge: attentionCount ? (attentionCount > 99 ? "99+" : attentionCount) : undefined,
        tabBarIcon: ({ color, focused }) => <NavigationIcon kind="chat" color={color} focused={focused} /> }} />
      <Tabs.Screen name="friends" options={{ title: "친구", tabBarIcon: ({ color, focused }) => <NavigationIcon kind="friends" color={color} focused={focused} /> }} />
      <Tabs.Screen name="open" options={{ title: "오픈채팅", tabBarIcon: ({ color, focused }) => <NavigationIcon kind="open" color={color} focused={focused} /> }} />
      <Tabs.Screen name="settings" options={{ title: "설정", tabBarIcon: ({ color, focused }) => <NavigationIcon kind="settings" color={color} focused={focused} /> }} />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  icon: { minWidth: 54, height: 34, borderRadius: 18, alignItems: "center", justifyContent: "center" },
  activeIcon: { backgroundColor: colors.chatSoft },
});
