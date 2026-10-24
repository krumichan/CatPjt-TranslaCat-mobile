import { useRouter } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";

import { useAuth } from "@/auth/AuthProvider";
import { BackButton, Button, PageHeading, Screen } from "@/ui/components";
import { ProfileAvatar } from "@/ui/ProfileAvatar";
import { colors } from "@/ui/theme";
import { ConfirmationDialog, type ManagementConfirmation } from "@/features/room-management/RoomManagementComponents";

import { useOpenProfile } from "./useOpenProfile";

export default function OpenProfileScreen({ roomId }: { roomId: string }) {
  const auth = useAuth();
  const router = useRouter();
  const profile = useOpenProfile(roomId);
  const { state } = profile;
  const [confirmation, setConfirmation] = useState<ManagementConfirmation | null>(null);
  const busy = state.pending !== null;
  const disabled = !profile.available || !state.ready || busy || !!state.uncertain;
  const back = () => router.canGoBack() ? router.back() : router.replace({ pathname: "/chat/[roomId]", params: { roomId } });
  const confirmationScope = profile.available
    ? `${state.profile?.openChatMemberId}:${state.profile?.profileImageUrl ?? "default"}` : "inactive";
  const [renderedScope, setRenderedScope] = useState(confirmationScope);
  if (renderedScope !== confirmationScope) {
    // 비활성화·계정/사진 변경의 첫 렌더에서 예전 삭제 동의를 폐기한다.
    setRenderedScope(confirmationScope);
    setConfirmation(null);
  }

  return <Screen>
    <BackButton onPress={back} />
    <PageHeading title="내 방별 프로필" description="이 오픈채팅방에서만 사용할 사진을 정해요." />
    {auth.status !== "signedIn" ? <View style={styles.card}>
      <Text style={styles.copy}>로그인한 계정으로 방별 프로필을 확인할 수 있어요.</Text>
      <Button label="로그인" onPress={() => router.push("/sign-in")} />
    </View> : <View style={styles.body}>
      {!profile.valid && <Text accessibilityRole="alert" style={styles.error}>대화방 링크를 확인해 주세요.</Text>}
      {state.error && <Text accessibilityRole="alert" style={styles.error}>{state.error}</Text>}
      {state.notice && <Text accessibilityLiveRegion="polite" style={styles.copy}>{state.notice}</Text>}
      {busy && <ActivityIndicator color={colors.blue} accessibilityLabel={state.pending === "pick" ? "사진 선택 중" : "프로필 처리 중"} />}
      {state.profile && <View style={styles.card}>
        <View style={styles.identity}>
          <ProfileAvatar name={state.profile.nickname} imageUrl={state.profile.profileImageUrl} localUri={state.draft?.uri} size={88} />
          <Text style={styles.name}>{state.profile.nickname}</Text>
          <Text style={styles.copy}>멤버 코드 {state.profile.memberCode}</Text>
        </View>
        <Text style={styles.copy}>일반 계정의 사진과 TranslaCat ID는 다른 참여자에게 표시되지 않아요. 이 방의 프로필 사진만 바뀌어요.</Text>
        <Text style={styles.help}>JPG · PNG · WEBP, 최대 5MB. 사진을 선택한 뒤 저장해 주세요.</Text>
        <Button label={state.draft || state.profile.profileImageUrl ? "다른 사진 선택" : "사진 선택"} secondary disabled={disabled} onPress={profile.choose} />
        {state.draft && <>
          <Button label="이 사진 저장" disabled={disabled} onPress={profile.save} />
          <Button label="선택 취소" secondary disabled={disabled} onPress={profile.clearDraft} />
        </>}
        {state.profile.profileImageUrl && <Button label="프로필 사진 삭제" secondary disabled={disabled} onPress={() => {
          const expected = state.profile!;
          setConfirmation({ title: "프로필 사진을 삭제할까요?", description: "이 방의 사진을 지우고 기본 아이콘으로 표시해요. 일반 계정 사진과 다른 방의 사진은 바뀌지 않아요.",
            confirmLabel: "사진 삭제", danger: true, onConfirm: () => {
              setConfirmation(null);
              profile.remove(expected.openChatMemberId, expected.profileImageUrl ?? null);
            } });
        }} />}
      </View>}
      {state.uncertain && <View style={styles.card}>
        <Text style={styles.name}>변경 결과를 확인해 주세요</Text>
        <Text style={styles.copy}>사진이 이미 반영됐거나 늦게 반영될 수 있어요. 현재 사진을 다시 확인하기 전에는 같은 변경을 다시 보내지 않아요.</Text>
        <Button label="현재 프로필 다시 확인" secondary disabled={!profile.available || busy} onPress={profile.reload} />
        {state.uncertain.reviewed && <Button label="현재 사진을 확인했어요" secondary disabled={!profile.available || busy || !state.ready || !!state.error} onPress={profile.acknowledge} />}
      </View>}
      {!state.uncertain && <Button label="프로필 새로고침" secondary disabled={!profile.available || busy} onPress={profile.reload} />}
    </View>}
    <ConfirmationDialog confirmation={profile.available && !disabled ? confirmation : null} reason="" onReasonChange={() => {}}
      onCancel={() => setConfirmation(null)} disabled={disabled} />
  </Screen>;
}

const styles = StyleSheet.create({
  body: { gap: 16, paddingBottom: 24 },
  card: { gap: 14, padding: 20, borderRadius: 22, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line },
  identity: { gap: 10, alignItems: "center", paddingVertical: 8 },
  name: { color: colors.ink, fontSize: 18, lineHeight: 27, fontWeight: "700" },
  copy: { color: colors.muted, fontSize: 14, lineHeight: 23 },
  help: { color: colors.muted, fontSize: 12, lineHeight: 20 },
  error: { color: colors.danger, fontSize: 14, lineHeight: 23 },
});
