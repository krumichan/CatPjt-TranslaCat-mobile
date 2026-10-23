import { Pressable, Text, TextInput, View } from "react-native";

import type { FriendEntry } from "@/features/friends/service";
import { colors } from "@/ui/theme";

import { ManagementAction, ManagementCard, ParticipantIdentity, managementStyles as styles } from "./RoomManagementComponents";

interface GroupInvitationSectionProps {
  friendsError: string | null;
  inviteFriends: FriendEntry[];
  selected: string[];
  selectedCount: number;
  visibleFriends: number;
  publicIds: string;
  enteredIdCount: number;
  disabled: boolean;
  busy: boolean;
  onPublicIdsChange: (value: string) => void;
  onToggleFriend: (userId: string) => void;
  onShowMore: () => void;
  onReset: () => void;
  onInvite: () => void;
}

export function GroupInvitationSection({
  friendsError, inviteFriends, selected, selectedCount, visibleFriends, publicIds, enteredIdCount,
  disabled, busy, onPublicIdsChange, onToggleFriend, onShowMore, onReset, onInvite,
}: GroupInvitationSectionProps) {
  // 현재 초대 대상의 표시와 입력만 맡고, 선택·권한 확인과 실제 초대는 상위 화면이 처리한다.
  return <ManagementCard title="그룹에 초대하기" description="친구를 선택하거나 TranslaCat ID를 입력해 초대하세요. 이미 참여 중인 사람은 제외돼요.">
    {friendsError && <Text accessibilityRole="alert" style={styles.copy}>{friendsError}</Text>}
    {inviteFriends.length > 0 && <>
      <Text style={styles.label}>친구 선택 · {selectedCount}명</Text>
      {inviteFriends.slice(0, visibleFriends).map(friend => <Pressable key={friend.relationId}
        accessibilityRole="checkbox" accessibilityLabel={`${friend.nickname} 초대 대상`} aria-checked={selected.includes(friend.userId)}
        accessibilityState={{ checked: selected.includes(friend.userId), disabled: disabled || !!friendsError }} disabled={disabled || !!friendsError}
        onPress={() => onToggleFriend(friend.userId)} style={styles.member}>
        <View style={styles.row}>
          <View style={styles.grow}><ParticipantIdentity name={friend.nickname} detail={`@${friend.publicId}`} /></View>
          <Text style={styles.label}>{selected.includes(friend.userId) ? "✓ 선택됨" : "선택"}</Text>
        </View>
      </Pressable>)}
      {inviteFriends.length > visibleFriends && <ManagementAction label="친구 더 보기" secondary onPress={onShowMore} />}
      <ManagementAction label="친구 선택 초기화" secondary disabled={disabled} onPress={onReset} />
    </>}
    {!friendsError && inviteFriends.length === 0 && <Text style={styles.copy}>초대할 친구가 없어요. TranslaCat ID를 직접 입력할 수 있어요.</Text>}
    <Text style={styles.label}>TranslaCat ID로 초대</Text>
    <Text style={styles.small}>친구 화면에서 확인할 수 있는 TranslaCat ID를 입력해 주세요.</Text>
    <TextInput accessibilityLabel="초대할 TranslaCat ID" value={publicIds} onChangeText={onPublicIdsChange} editable={!disabled}
      autoCapitalize="none" autoCorrect={false} multiline maxLength={1000} placeholder="ID를 쉼표나 줄바꿈으로 구분해 입력" placeholderTextColor={colors.faint} style={styles.input} />
    <Text style={styles.small}>친구 {selectedCount}명 · 입력한 ID {enteredIdCount}개</Text>
    <ManagementAction label={busy ? "초대 처리 중…" : "선택한 사람 초대"} disabled={disabled || selectedCount + enteredIdCount === 0}
      onPress={onInvite} />
  </ManagementCard>;
}
