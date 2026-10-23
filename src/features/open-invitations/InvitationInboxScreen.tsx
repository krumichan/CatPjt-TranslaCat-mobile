import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { useAuth } from "@/auth/AuthProvider";
import { createChatService } from "@/features/chat/service";
import { useActivityGate } from "@/realtime/useActivity";
import { publishAttentionChange } from "@/notifications/attention-changes";
import { BackButton, Button, PageHeading, Screen } from "@/ui/components";
import { colors } from "@/ui/theme";

import { blockedInvitationReason, createInvitationPreviewController, emptyInvitationPreview, invitationError } from "./preview-controller";
import { invitationKeys } from "./queries";
import { createOpenInvitationService } from "./service";

export default function InvitationInboxScreen({ notificationId }: { notificationId: string | null }) {
  const auth = useAuth();
  const router = useRouter();
  const { active, isActive } = useActivityGate();
  const service = useMemo(() => createOpenInvitationService(auth.api), [auth.api]);
  const enabled = active && auth.status === "signedIn" && !!auth.sessionKey;
  const listing = useInfiniteQuery({
    queryKey: invitationKeys.list(auth.sessionKey), queryFn: ({ pageParam, signal }) => service.list(pageParam, signal),
    initialPageParam: null as string | null, getNextPageParam: page => page.hasNext ? page.nextCursorId ?? undefined : undefined,
    enabled: enabled && !notificationId, staleTime: 0, retry: false, refetchInterval: enabled ? 30000 : false,
  });
  const summary = useQuery({ queryKey: invitationKeys.summary(auth.sessionKey), queryFn: ({ signal }) => service.summary(signal),
    enabled: enabled && !notificationId, staleTime: 0, retry: false, refetchInterval: enabled ? 30000 : false });
  const items = [...new Map((listing.data?.pages.flatMap(page => page.items) ?? []).map(item => [item.id, item])).values()];
  const back = () => router.canGoBack() ? router.back() : router.replace("/");

  return <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}><Screen>
    <BackButton onPress={back} />
    <PageHeading title="오픈채팅 초대" description="받은 초대를 확인하고, 원하는 방에 직접 참여하세요." />
    {auth.status === "restoring" ? <ActivityIndicator color={colors.blue} accessibilityLabel="로그인 확인 중" />
      : auth.status !== "signedIn" ? <Button label="로그인하고 초대 확인" onPress={() => router.push("/sign-in")} />
        : !active ? null : notificationId ? <InvitationPreview key={`${auth.sessionKey}:${notificationId}`} notificationId={notificationId} isActive={isActive} />
          : <View style={styles.body}>
            <Text style={styles.copy}>읽지 않은 초대 {summary.data?.unreadCount ?? 0}개</Text>
            <Button label={listing.isFetching ? "초대 확인 중…" : "초대 새로고침"} secondary disabled={listing.isFetching}
              onPress={() => { void listing.refetch(); void summary.refetch(); }} />
            {(listing.error || summary.error) && <Text accessibilityRole="alert" style={styles.error}>{invitationError(listing.error || summary.error)}</Text>}
            {listing.isPending && <ActivityIndicator color={colors.blue} accessibilityLabel="초대 불러오는 중" />}
            {!listing.isPending && !listing.error && items.length === 0 && <View style={styles.card}>
              <Text style={styles.title}>받은 오픈채팅 초대가 없어요</Text>
              <Text style={styles.copy}>상대방에게 설정 화면의 TranslaCat ID를 알려주면 초대를 받을 수 있어요.</Text>
            </View>}
            {items.map(item => <Pressable key={item.id} accessibilityRole="button"
              accessibilityLabel={`${item.isRead ? "읽은" : "새"} 초대, ${item.roomName || "오픈채팅"}, ${item.inviterNickname}`}
              onPress={() => { if (isActive()) router.push({ pathname: "/invitations", params: { notificationId: item.id } }); }} style={styles.card}>
              <Text style={styles.meta}>{item.isRead ? "읽은 초대" : "새 초대"}</Text>
              <Text style={styles.title}>{item.roomName || "오픈채팅"}</Text>
              <Text style={styles.copy}>{item.inviterNickname}님이 초대했어요.</Text>
              <Text style={styles.small}>멤버 코드 {item.inviterMemberCode} · {new Date(item.createdAt).toLocaleDateString()}</Text>
              <Text style={styles.link}>초대와 방 정보 확인 →</Text>
            </Pressable>)}
            {listing.hasNextPage && <Button label={listing.isFetchingNextPage ? "불러오는 중…" : "이전 초대 더 보기"} secondary
              disabled={listing.isFetching} onPress={() => { if (isActive()) void listing.fetchNextPage(); }} />}
          </View>}
  </Screen></KeyboardAvoidingView>;
}

function InvitationPreview({ notificationId, isActive }: { notificationId: string; isActive: () => boolean }) {
  const { api, sessionKey, isCurrentSession } = useAuth();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [state, setState] = useState(emptyInvitationPreview);
  const [nickname, setNickname] = useState("");
  const owner = useRef<ReturnType<typeof createInvitationPreviewController> | null>(null);
  useEffect(() => {
    if (!sessionKey) return;
    const controller = createInvitationPreviewController(createOpenInvitationService(api), createChatService(api),
      notificationId, `${sessionKey}:${notificationId}`, () => isActive() && isCurrentSession(sessionKey), setState,
      roomId => router.replace({ pathname: "/chat/[roomId]", params: { roomId } }),
      () => {
        publishAttentionChange({ sessionKey, readInvitationId: notificationId });
        void queryClient.invalidateQueries({ queryKey: invitationKeys.root(sessionKey) });
      });
    owner.current = controller;
    void controller.load();
    return () => { controller.dispose(); if (owner.current === controller) owner.current = null; };
  }, [api, isCurrentSession, sessionKey, isActive, notificationId, queryClient, router]);
  const room = state.room;
  const disabled = state.loading || state.busy;
  return <View style={styles.body}>
    {state.error && <Text accessibilityRole="alert" style={styles.error}>{state.error}</Text>}
    {state.notice && <Text accessibilityRole="alert" style={styles.copy}>{state.notice}</Text>}
    <Button label={state.loading ? "초대 확인 중…" : "초대와 참여 상태 새로고침"} secondary disabled={disabled}
      onPress={() => { if (isActive()) void owner.current?.load(); }} />
    {state.loading && <ActivityIndicator color={colors.blue} accessibilityLabel="초대와 방 정보 확인 중" />}
    {state.invitation && room && <View style={styles.card}>
      <Text style={styles.meta}>{state.invitation.inviterNickname}님의 오픈채팅 초대</Text>
      <Text style={styles.title}>{room.name}</Text>
      <Text style={styles.copy}>{room.description}</Text>
      <Text style={styles.copy}>{room.memberCount} / {room.maxMemberCount}명</Text>
      {room.joined ? <Button label="대화방 열기" disabled={disabled} onPress={() => owner.current?.openJoined()} />
        : !room.joinable ? <Text style={styles.error}>{blockedInvitationReason(room.joinBlockedReason)}</Text> : <>
          {room.myOpenProfile ? <Text style={styles.copy}>이전 방별 프로필 ‘{room.myOpenProfile.nickname}’으로 다시 참여해요. 재참여 이전 대화는 볼 수 없어요.</Text>
            : <TextInput accessibilityLabel="초대받은 방에서 사용할 닉네임" value={nickname} onChangeText={setNickname} editable={!disabled}
              maxLength={50} placeholder="이 방에서 사용할 닉네임" placeholderTextColor={colors.faint} style={styles.input} />}
          <Text style={styles.small}>참여를 누르기 전에는 방에 추가되지 않아요. 일반 프로필과 TranslaCat ID는 다른 참여자에게 표시되지 않아요.</Text>
          <Button label={state.busy ? "참여 확인 중…" : "이 프로필로 참여"} disabled={disabled || state.uncertain}
            onPress={() => { if (isActive()) void owner.current?.join(nickname); }} />
        </>}
      {state.uncertain && <>
        <Text style={styles.copy}>먼저 참여 상태를 새로고침해 주세요. 이미 참여했다면 대화방을 열 수 있어요.</Text>
        {!state.loading && !state.error && !room.joined && <Button label="확인했어요. 직접 다시 참여할게요" secondary disabled={disabled}
          onPress={() => owner.current?.acknowledge()} />}
      </>}
    </View>}
    <Button label="받은 초대 목록" secondary onPress={() => router.replace("/invitations")} />
  </View>;
}

const styles = StyleSheet.create({
  body: { gap: 14 },
  card: { gap: 12, padding: 20, borderRadius: 22, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line },
  title: { fontSize: 18, lineHeight: 27, fontWeight: "700", color: colors.ink },
  copy: { color: colors.muted, fontSize: 14, lineHeight: 23 },
  small: { color: colors.muted, fontSize: 12, lineHeight: 20 },
  meta: { color: colors.blueDark, fontSize: 13, lineHeight: 21, fontWeight: "700" },
  link: { color: colors.blueDark, fontSize: 14, lineHeight: 22, fontWeight: "700" },
  error: { color: "#9E3542", fontSize: 13, lineHeight: 22 },
  input: { minHeight: 50, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line, borderRadius: 16,
    paddingHorizontal: 15, paddingVertical: 13, color: colors.ink, fontSize: 14, lineHeight: 22 },
});
