import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";

import { useAuth } from "@/auth/AuthProvider";
import { BackButton, Button, PageHeading, Screen } from "@/ui/components";
import { colors } from "@/ui/theme";

import { memberActions } from "./controller";
import {
  ConfirmationDialog, ManagementAction, ManagementCard, ManagementMessage, ParticipantIdentity,
  managementStyles as styles, type ManagementConfirmation,
} from "./RoomManagementComponents";
import { useRoomManagement } from "./useRoomManagement";

export default function RoomMembersScreen({ roomId }: { roomId: string }) {
  const auth = useAuth();
  const router = useRouter();
  const { state, controller, active, isActive, epoch } = useRoomManagement(roomId || null);
  const [confirmation, setConfirmation] = useState<ManagementConfirmation | null>(null);
  const [reason, setReason] = useState("");
  const [visibleCount, setVisibleCount] = useState(30);
  const exitIssued = useRef(false);
  const confirmationScope = `${auth.sessionKey ?? "signed-out"}:${roomId}:${epoch}:${state.revision}`;
  const [renderedScope, setRenderedScope] = useState(confirmationScope);
  const disabled = !active || !state.ready || state.loading || state.loadingBans || state.busy || state.uncertain;

  useFocusEffect(useCallback(() => () => {
    setConfirmation(null);
    setReason("");
  }, []));

  useEffect(() => {
    // 같은 계정의 활성 화면에서 확인된 퇴장만 채팅 목록으로 이동시킨다.
    if (state.exited && active && isActive() && !exitIssued.current) {
      exitIssued.current = true;
      router.replace("/");
    }
  }, [state.exited, active, isActive, router]);

  if (renderedScope !== confirmationScope) {
    // 새 화면·권한 세대의 첫 커밋 전에 이전 동의와 강퇴 사유를 폐기한다.
    setRenderedScope(confirmationScope);
    setConfirmation(null);
    setReason("");
  }

  const back = () => router.canGoBack() ? router.back() : router.replace({ pathname: "/chat/[roomId]", params: { roomId } });
  const ask = (value: Omit<ManagementConfirmation, "onConfirm">, work: (reason: string) => void) => {
    const owner = controller.current;
    if (!owner || disabled || !isActive()) return;
    const revision = owner.getState().revision;
    setReason("");
    setConfirmation({ ...value, onConfirm: text => {
      setConfirmation(null);
      setReason("");
      if (!isActive() || controller.current !== owner || owner.getState().revision !== revision
        || !owner.getState().ready) return;
      work(text);
    } });
  };

  return <Screen>
    <BackButton onPress={back} />
    <PageHeading title="참여자" description={state.room?.name || "이 방에 함께하는 사람들을 확인해요."} />
    {auth.status === "restoring" ? <ActivityIndicator color={colors.blue} accessibilityLabel="로그인 확인 중" />
      : auth.status !== "signedIn" ? <View style={styles.body}>
        <Text style={styles.copy}>로그인한 계정으로 참여자 목록을 확인할 수 있어요.</Text>
        <Button label="로그인" onPress={() => router.push("/sign-in")} />
      </View> : <View style={styles.body}>
        <ManagementMessage error={state.error} notice={state.notice} />
        {state.uncertain && <ManagementCard title="변경 결과를 확인해 주세요" description="요청이 이미 반영됐을 수 있어요. 새 목록을 확인하기 전에는 같은 요청을 다시 보내지 않아요.">
          <ManagementAction label="방 상태 다시 불러오기" secondary disabled={!active || state.busy || state.loading || state.loadingBans}
            onPress={() => { void controller.current?.load(); }} />
          {state.ready && !state.error && !state.bansError && <ManagementAction label="새 목록을 확인했어요" secondary disabled={!active || state.busy || state.loading}
            onPress={() => { controller.current?.acknowledge(); }} />}
        </ManagementCard>}
        <ManagementAction label={state.loading ? "참여자 확인 중…" : "참여자 새로고침"} secondary
          disabled={!active || state.busy || state.loading || state.loadingBans} onPress={() => { void controller.current?.load(); }} />
        {state.loading && <ActivityIndicator color={colors.blue} accessibilityLabel="참여자 불러오는 중" />}
        {state.ready && state.room && <>
          <ManagementCard title={`사람 참여자 ${state.members.length}명`}
            description={state.room.roomType === "OPEN" ? "오픈채팅에서는 이 방에서 사용하는 닉네임과 멤버 코드로 표시해요." : "현재 이 대화방에 참여 중인 사람들이에요."}>
            {state.room.closed && <Text style={styles.copy}>종료된 방이에요. 참여자와 기록을 확인할 수 있어요.</Text>}
            {state.members.slice(0, visibleCount).map(member => {
              const actions = memberActions(state.room, member, state.myMemberId);
              return <View key={member.id} style={styles.member}>
                <ParticipantIdentity name={member.displayName} detail={member.memberCode ? `멤버 코드 ${member.memberCode}` : member.publicId ? `@${member.publicId}` : null}
                  role={member.role} mine={member.id === state.myMemberId} active={member.active} imageUrl={member.profileImageUrl} />
                <View style={styles.actions}>
                  {member.id !== state.myMemberId && member.active && <View style={styles.actionSlot}><ManagementAction label="참여자 신고" secondary disabled={disabled}
                    onPress={() => { if (isActive()) router.push({ pathname: "/chat/[roomId]/report", params: { roomId,
                      ...(state.room?.roomType === "OPEN" ? { targetOpenChatMemberId: member.id } : { targetUserId: member.id }) } }); }} /></View>}
                  {actions.assignAdmin && <View style={styles.actionSlot}><ManagementAction label="관리자로 지정" secondary disabled={disabled}
                    onPress={() => ask({ title: "관리자로 지정할까요?", description: `${member.displayName}님에게 참여자 관리 권한을 부여해요.`, confirmLabel: "관리자로 지정" },
                      () => { void controller.current?.assignAdmin(member.id); })} /></View>}
                  {actions.revokeAdmin && <View style={styles.actionSlot}><ManagementAction label="관리자 해제" secondary disabled={disabled}
                    onPress={() => ask({ title: "관리자 권한을 해제할까요?", description: `${member.displayName}님은 일반 참여자로 남아요.`, confirmLabel: "관리자 해제" },
                      () => { void controller.current?.revokeAdmin(member.id); })} /></View>}
                  {actions.transfer && <View style={styles.actionSlot}><ManagementAction label="방장 위임" secondary disabled={disabled}
                    onPress={() => ask({ title: "방장을 위임할까요?", description: `${member.displayName}님이 새 방장이 되고, 나는 일반 참여자가 돼요. 방에서는 자동으로 나가지 않아요.`, confirmLabel: "방장 위임", danger: true },
                      () => { void controller.current?.transfer(member.id); })} /></View>}
                  {actions.ban && <View style={styles.actionSlot}><ManagementAction label="강퇴 · 재입장 차단" danger disabled={disabled}
                    onPress={() => ask({ title: "강퇴하고 재입장을 차단할까요?", description: `${member.displayName}님을 이 방에서 내보내고 다시 참여하지 못하게 해요. 차단을 해제해도 자동으로 돌아오지는 않아요.`,
                      confirmLabel: "강퇴 및 차단", danger: true, requireReason: true }, text => { void controller.current?.ban(member.id, text); })} /></View>}
                </View>
              </View>;
            })}
            {state.members.length > visibleCount && <ManagementAction label="참여자 더 보기" secondary onPress={() => setVisibleCount(value => value + 30)} />}
          </ManagementCard>
          <ManagementAction label="방 관리 · 초대" secondary disabled={!active || state.busy}
            onPress={() => { if (isActive()) router.push({ pathname: "/chat/[roomId]/manage", params: { roomId } }); }} />
          {state.room.roomType !== "DIRECT" && <ManagementCard title="AI 참여자와 설정" description="위 목록은 사람 참여자예요. AI 참여자는 기존 AI 설정에서 확인하고 관리할 수 있어요.">
            <ManagementAction label="AI와 대화 · 설정" secondary disabled={!active || state.busy}
              onPress={() => { if (isActive()) router.push({ pathname: "/chat/[roomId]/ai", params: { roomId } }); }} />
          </ManagementCard>}
        </>}
        {state.busy && <ActivityIndicator color={colors.blue} accessibilityLabel="방 관리 요청 처리 중" />}
      </View>}
    <ConfirmationDialog confirmation={active && state.ready && !state.exited ? confirmation : null} reason={reason} onReasonChange={setReason}
      onCancel={() => setConfirmation(null)} disabled={disabled} />
  </Screen>;
}
