import { useFocusEffect, useRouter } from "expo-router";
import * as Crypto from "expo-crypto";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Platform, Share, Text, TextInput, View } from "react-native";

import { useAuth } from "@/auth/AuthProvider";
import { runtime } from "@/config/runtime";
import { BackButton, Button, PageHeading, Screen } from "@/ui/components";
import { colors } from "@/ui/theme";
import { NotificationPreferenceControl } from "@/features/notification-preferences/NotificationPreferenceControl";

import { capabilities } from "./controller";
import { GroupInvitationSection } from "./GroupInvitationSection";
import {
  ConfirmationDialog, ManagementAction, ManagementCard, ManagementMessage, ParticipantIdentity,
  managementStyles as styles, type ManagementConfirmation,
} from "./RoomManagementComponents";
import { useRoomManagement } from "./useRoomManagement";

export default function RoomManagementScreen({ roomId }: { roomId: string }) {
  const auth = useAuth();
  const router = useRouter();
  const { state, controller, active, isActive, epoch } = useRoomManagement(roomId || null);
  const [confirmation, setConfirmation] = useState<ManagementConfirmation | null>(null);
  const [reason, setReason] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [publicIds, setPublicIds] = useState("");
  const [openPublicId, setOpenPublicId] = useState("");
  const [visibleFriends, setVisibleFriends] = useState(20);
  const [shareError, setShareError] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const sharePending = useRef(false);
  const exitIssued = useRef(false);
  const confirmationScope = `${auth.sessionKey ?? "signed-out"}:${roomId}:${epoch}:${state.revision}`;
  const [renderedScope, setRenderedScope] = useState(confirmationScope);
  const inputScope = `${auth.sessionKey ?? "signed-out"}:${roomId}:${epoch}`;
  const [renderedInputScope, setRenderedInputScope] = useState(inputScope);
  const allowed = capabilities(state.room);
  const disabled = !active || !state.ready || state.loading || state.loadingBans || state.busy || state.uncertain;
  const inviteFriends = state.friends.filter(friend => !state.members.some(member => member.id === friend.userId));
  const selectedFriends = inviteFriends.filter(friend => selected.includes(friend.userId));
  const enteredIds = [...new Set(publicIds.split(/[\s,]+/).filter(Boolean))];
  const shareUrl = `${runtime.webBaseUrl}/ko/chat/open/${encodeURIComponent(roomId)}`;

  useFocusEffect(useCallback(() => () => {
    setConfirmation(null);
    setReason("");
    setOpenPublicId("");
  }, []));

  useEffect(() => {
    // 퇴장·종료 응답 뒤에도 현재 계정과 활성 화면일 때만 목록으로 돌아간다.
    if (state.exited && active && isActive() && !exitIssued.current) {
      exitIssued.current = true;
      router.replace("/");
    }
  }, [state.exited, active, isActive, router]);

  if (renderedScope !== confirmationScope) {
    // 화면 수명과 권한이 바뀔 때만 동의를 지우고 진행 중인 OS 공유 잠금은 유지한다.
    setRenderedScope(confirmationScope);
    setConfirmation(null);
    setReason("");
  }
  if (renderedInputScope !== inputScope) {
    // 다른 계정·방·활성 수명으로 이동하면 이전에 입력한 초대 대상 ID를 남기지 않는다.
    setRenderedInputScope(inputScope);
    setOpenPublicId("");
  }

  const back = () => router.canGoBack() ? router.back() : router.replace({ pathname: "/chat/[roomId]", params: { roomId } });
  const ask = (value: Omit<ManagementConfirmation, "onConfirm">, work: () => void) => {
    const owner = controller.current;
    if (!owner || disabled || !isActive()) return;
    const revision = owner.getState().revision;
    setReason("");
    setConfirmation({ ...value, onConfirm: () => {
      setConfirmation(null);
      if (!isActive() || controller.current !== owner || owner.getState().revision !== revision
        || !owner.getState().ready) return;
      work();
    } });
  };

  const invite = async () => {
    if (disabled || !allowed.invite || !isActive()) return;
    // 현재 친구 목록과 방 참여자를 다시 대조한 선택만 보내고, 불확실한 응답은 자동 재전송하지 않는다.
    const succeeded = await controller.current?.invite({ userIds: selectedFriends.map(friend => friend.userId), publicIds: enteredIds });
    if (succeeded && isActive()) { setSelected([]); setPublicIds(""); }
  };

  const share = async () => {
    if (disabled || sharePending.current || !allowed.share || !isActive()) return;
    sharePending.current = true;
    setSharing(true);
    setShareError(null);
    try {
      await Share.share({ title: "TranslaCat 오픈채팅 초대", message: `${state.room?.name || "TranslaCat 오픈채팅"}\n${shareUrl}` });
    } catch {
      if (isActive()) setShareError("공유 창을 열지 못했어요. 아래 초대 주소를 길게 눌러 복사해 주세요.");
    } finally {
      sharePending.current = false;
      setSharing(false);
    }
  };

  const sendOpenInvitation = async () => {
    if (disabled || !allowed.share || !openPublicId.trim() || !isActive()) return;
    const owner = controller.current;
    // 새 버튼 동작은 새 키를 만들고, 기존 불확실 시도의 키 보존은 controller가 담당한다.
    const succeeded = await owner?.sendOpenInvitation(openPublicId, Crypto.randomUUID());
    if (succeeded && isActive() && controller.current === owner) setOpenPublicId("");
  };

  // iOS는 폼의 키보드 공간을 확보하고, Android는 기존 adjustResize와 중복 보정하지 않는다.
  return <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}><Screen>
    <BackButton onPress={back} />
    <PageHeading title="방 관리" description={state.room?.name || "참여자를 초대하고 이 방의 설정을 확인해요."} />
    {auth.status === "restoring" ? <ActivityIndicator color={colors.blue} accessibilityLabel="로그인 확인 중" />
      : auth.status !== "signedIn" ? <View style={styles.body}>
        <Text style={styles.copy}>로그인한 계정으로 참여 중인 방을 관리할 수 있어요.</Text>
        <Button label="로그인" onPress={() => router.push("/sign-in")} />
      </View> : <View style={styles.body}>
        <ManagementMessage error={state.error || shareError} notice={state.notice} />
        <ManagementAction label={state.loading ? "방 정보 확인 중…" : "방 정보 새로고침"} secondary
          disabled={!active || state.busy || state.loading || state.loadingBans} onPress={() => { void controller.current?.load(); }} />
        {state.loading && <ActivityIndicator color={colors.blue} accessibilityLabel="방 정보 불러오는 중" />}
        {state.uncertain && <ManagementCard title="변경 결과를 확인해 주세요" description="요청이 이미 반영됐을 수 있어요. 방 정보를 새로 불러오고 실제 결과를 확인한 뒤 진행해 주세요. 같은 요청을 자동으로 다시 보내지 않아요.">
          <ManagementAction label="방 상태 다시 불러오기" secondary disabled={!active || state.busy || state.loading || state.loadingBans}
            onPress={() => { void controller.current?.load(); }} />
          {state.ready && !state.error && !state.bansError && <ManagementAction label="새 목록을 확인했어요" secondary disabled={!active || state.busy || state.loading}
            onPress={() => { controller.current?.acknowledge(); }} />}
        </ManagementCard>}
        {state.ready && state.room && <>
          <ManagementCard title="방 정보">
            <Text style={styles.copy}>{state.room.roomType === "OPEN" ? "오픈채팅" : state.room.roomType === "GROUP" ? "그룹 대화" : "1:1 대화"}
              {state.room.myRole === "OWNER" ? " · 나는 방장" : state.room.myRole === "ADMIN" ? " · 나는 관리자" : " · 나는 참여자"}</Text>
            {state.room.closed && <Text style={styles.copy}>종료된 방이에요. 남아 있는 대화 기록과 참여자 정보를 확인할 수 있어요.</Text>}
            <ManagementAction label={`사람 참여자 ${state.members.length}명 보기`} secondary disabled={!active || state.busy}
              onPress={() => { if (isActive()) router.push({ pathname: "/chat/[roomId]/members", params: { roomId } }); }} />
          </ManagementCard>

          {state.room.active && !state.room.closed && <ManagementCard title="이 방의 알림">
            <NotificationPreferenceControl roomId={roomId} disabled={disabled} />
          </ManagementCard>}

          {allowed.share && <ManagementCard title="오픈채팅 초대" description="초대 주소를 공유하면 상대방이 방 정보를 확인하고 직접 참여할 수 있어요. 참여 가능 여부는 방 상태에 따라 달라요.">
            <Text style={styles.label}>TranslaCat ID로 초대 보내기</Text>
            <Text style={styles.small}>상대방의 채팅 목록에 있는 ‘오픈채팅 초대’로 전달돼요. 방별 닉네임과 멤버 코드만 표시되고, 상대가 직접 참여를 결정해요.</Text>
            <TextInput accessibilityLabel="오픈채팅에 초대할 TranslaCat ID" value={openPublicId} onChangeText={setOpenPublicId}
              editable={!disabled} autoCapitalize="none" autoCorrect={false} maxLength={255}
              placeholder="상대방 TranslaCat ID 한 개" placeholderTextColor={colors.faint} style={styles.input} />
            <ManagementAction label={state.busy ? "초대 보내는 중…" : "초대 보내기"} disabled={disabled || !openPublicId.trim()}
              onPress={() => { void sendOpenInvitation(); }} />
            <ManagementAction label={sharing ? "공유 창 여는 중…" : "초대 링크 공유"} disabled={disabled || sharing} onPress={() => { void share(); }} />
            <Text selectable accessibilityLabel="오픈채팅 초대 주소" style={styles.small}>{shareUrl}</Text>
          </ManagementCard>}

          {allowed.invite && <GroupInvitationSection friendsError={state.friendsError} inviteFriends={inviteFriends}
            selected={selected} selectedCount={selectedFriends.length} visibleFriends={visibleFriends}
            publicIds={publicIds} enteredIdCount={enteredIds.length} disabled={disabled} busy={state.busy}
            onPublicIdsChange={setPublicIds}
            onToggleFriend={userId => setSelected(value => value.includes(userId) ? value.filter(id => id !== userId) : [...value, userId])}
            onShowMore={() => setVisibleFriends(value => value + 20)} onReset={() => setSelected([])}
            onInvite={() => { void invite(); }} />}
          {state.room.roomType === "GROUP" && !allowed.invite && state.room.active && <ManagementCard title="그룹 초대 권한">
            <Text style={styles.copy}>방 상태와 내 역할에 따라 이 방에서는 초대를 사용할 수 없어요. 일반 그룹에서는 방장과 관리자가 사람을 초대할 수 있어요.</Text>
          </ManagementCard>}

          {allowed.bans && <ManagementCard title="재입장 차단 목록" description="차단을 해제해도 상대방이 자동으로 방에 다시 참여하지는 않아요.">
            {state.bansError && <ManagementMessage error={state.bansError} />}
            {state.loadingBans && <ActivityIndicator color={colors.blue} accessibilityLabel="재입장 차단 목록 확인 중" />}
            {!state.bansError && !state.loadingBans && state.bans.length === 0 && <Text style={styles.copy}>재입장을 차단한 사람이 없어요.</Text>}
            {state.bans.map(ban => <View key={ban.id} style={styles.member}>
              <ParticipantIdentity name={ban.displayName} detail={`멤버 코드 ${ban.memberCode}`} />
              <Text style={styles.copy}>사유: {ban.reason}</Text>
              {ban.releasable && state.room?.active && !state.room.closed ? <ManagementAction label={`${ban.displayName} 차단 해제`} secondary disabled={disabled}
                onPress={() => ask({ title: "재입장 차단을 해제할까요?", description: `${ban.displayName}님이 방 상태에 따라 직접 다시 참여할 수 있어요. 자동으로 참여자가 되지는 않아요.`, confirmLabel: "차단 해제" },
                  () => { void controller.current?.releaseBan(ban.id); })} />
                : <Text style={styles.small}>{state.room?.closed ? "종료된 방에서는 차단을 해제할 수 없어요." : "이 차단은 해제 권한이 있는 관리자 또는 방장이 관리할 수 있어요."}</Text>}
            </View>)}
            {state.hasMoreBans && <ManagementAction label={state.loadingBans ? "불러오는 중…" : "차단 목록 더 보기"} secondary
              disabled={!active || state.busy || state.loading || state.loadingBans} onPress={() => { void controller.current?.loadMoreBans(); }} />}
            {state.bansError && <ManagementAction label="목록 다시 불러오기" secondary disabled={!active || state.busy || state.loading || state.loadingBans}
              onPress={() => { void controller.current?.load(); }} />}
          </ManagementCard>}

          <ManagementCard title="나가기와 방 종료">
            {allowed.leave && <ManagementAction label="이 방에서 나가기" danger disabled={disabled}
              onPress={() => ask({ title: "이 방에서 나갈까요?", description: "참여자 목록에서 나가게 돼요. 다시 참여할 수 있는지는 방 상태에 따라 달라요.", confirmLabel: "방에서 나가기", danger: true },
                () => { void controller.current?.leave(); })} />}
            {allowed.close && <>
              <Text style={styles.copy}>방에서 나가려면 참여자 화면에서 다른 사람에게 방장을 먼저 위임해 주세요. 대화를 마치려면 방을 종료할 수 있어요.</Text>
              <ManagementAction label="방 종료" danger disabled={disabled}
                onPress={() => ask({ title: "이 방을 종료할까요?", description: "종료한 방은 새로운 참여자를 받을 수 없어요. 대화 기록과 참여 이력은 유지되고, 참여자가 자동으로 나가지는 않아요.", confirmLabel: "방 종료", danger: true },
                  () => { void controller.current?.close(); })} />
            </>}
            {!allowed.leave && !allowed.close && <Text style={styles.copy}>{state.room.roomType === "OPEN" && state.room.closed
              ? "이 방은 이미 종료됐어요."
              : "이 방에서는 나가기를 아직 지원하지 않아요. 참여자 목록과 대화는 계속 확인할 수 있어요."}</Text>}
          </ManagementCard>
        </>}
        {state.busy && <ActivityIndicator color={colors.blue} accessibilityLabel="방 관리 요청 처리 중" />}
      </View>}
    <ConfirmationDialog confirmation={active && state.ready && !state.exited ? confirmation : null} reason={reason} onReasonChange={setReason}
      onCancel={() => setConfirmation(null)} disabled={disabled} />
  </Screen></KeyboardAvoidingView>;
}
