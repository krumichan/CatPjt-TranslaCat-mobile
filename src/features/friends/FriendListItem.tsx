import { Pressable, Text, View } from "react-native";

import type { FriendEntry } from "./service";
import { styles } from "./friends-styles";

interface Props {
  friend: FriendEntry;
  choosingGroup: boolean;
  selected: boolean;
  disabled: boolean;
  onToggle: () => void;
  onStartChat: () => void;
}

export function FriendListItem({ friend, choosingGroup, selected, disabled, onToggle, onStartChat }: Props) {
  return (
    <View style={styles.friendRow}>
      <View style={styles.avatar}>
        <Text style={styles.avatarText}>{friend.nickname.slice(0, 1) || "친"}</Text>
      </View>
      <View style={styles.grow}>
        <Text style={styles.name}>{friend.nickname}</Text>
        <Text style={styles.helper}>@{friend.publicId}</Text>
      </View>
      {choosingGroup ? (
        <Pressable
          accessibilityRole="checkbox"
          aria-checked={selected}
          accessibilityLabel={`${friend.nickname} 그룹에 선택`}
          accessibilityState={{ checked: selected, disabled }}
          disabled={disabled}
          onPress={onToggle}
          style={[styles.select, selected && styles.selected]}
        >
          <Text style={styles.selectText}>{selected ? "선택됨" : "선택"}</Text>
        </Pressable>
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${friend.nickname}와 대화 시작`}
          accessibilityState={{ disabled }}
          disabled={disabled}
          onPress={onStartChat}
          style={styles.select}
        >
          <Text style={styles.selectText}>대화</Text>
        </Pressable>
      )}
    </View>
  );
}
