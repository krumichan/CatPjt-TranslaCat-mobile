import { useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";

import { useAuth } from "@/auth/AuthProvider";
import type { ChatRoom } from "@/domain/chat/types";
import { useFocusedActive } from "@/realtime/useActivity";
import { createOpenInvitationService } from "@/features/open-invitations/service";
import { invitationKeys } from "@/features/open-invitations/queries";
import { AppHeader, Button, EmptyCard, PageHeading, Screen } from "@/ui/components";
import { TabIcon } from "@/ui/TabIcon";
import { colors } from "@/ui/theme";

import { chatErrorMessage, createChatService } from "./service";

export function roomTitle(room: ChatRoom): string {
  return room.roomType === "DIRECT" && room.partner ? room.partner.displayName : room.name || "이름 없는 대화방";
}

export default function RoomListScreen() {
  const auth = useAuth();
  const router = useRouter();
  const active = useFocusedActive();
  const service = useMemo(() => createChatService(auth.api), [auth.api]);
  const invitations = useMemo(() => createOpenInvitationService(auth.api), [auth.api]);
  const invitationSummary = useQuery({ queryKey: invitationKeys.summary(auth.sessionKey),
    queryFn: ({ signal }) => invitations.summary(signal), enabled: active && auth.status === "signedIn" && !!auth.sessionKey,
    staleTime: 0, retry: false, refetchInterval: active ? 30000 : false });
  const query = useQuery({
    queryKey: ["chat-rooms", auth.sessionKey],
    queryFn: async ({ signal }) => (await service.rooms(signal)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    enabled: active && auth.status === "signedIn" && !!auth.sessionKey,
    staleTime: 0,
    retry: false,
  });
  const rooms = query.data ?? [];
  return (
    <Screen>
      <AppHeader />
      <PageHeading title="채팅" description="언어를 넘어, 소중한 대화를 이어가요." />
      {auth.status === "restoring" ? <ActivityIndicator accessibilityLabel="로그인 확인 중" color={colors.blue} />
        : auth.status === "signedOut" ? (
          <EmptyCard kind="chat" title="반가운 대화의 시작" description="기존 TranslaCat 계정으로 로그인하고 대화를 이어가세요." onSignIn={() => router.push("/sign-in")} />
        ) : (
          <View style={styles.list}>
            <View style={styles.actions}>
              <View style={styles.action}><Button label="새 대화" onPress={() => router.push("/friends")} /></View>
              <View style={styles.action}><Button label="오픈채팅" secondary onPress={() => router.push("/open")} /></View>
            </View>
            <Button label={query.isFetching ? "대화 목록 확인 중…" : "대화 목록 새로고침"} secondary onPress={() => { void query.refetch(); }} />
            <Pressable accessibilityRole="button" accessibilityLabel={`오픈채팅 초대, 읽지 않은 초대 ${invitationSummary.data?.unreadCount ?? 0}개`}
              onPress={() => router.push("/invitations")} style={styles.room}>
              <View style={styles.icon}><TabIcon kind="open" color={colors.blue} /></View>
              <View style={styles.roomCopy}>
                <Text style={styles.title}>오픈채팅 초대</Text>
                <Text style={styles.subtitle}>{invitationSummary.error ? "초대를 불러오지 못했어요. 눌러서 다시 확인해 주세요."
                  : invitationSummary.data?.latestInvitation ? `${invitationSummary.data.latestInvitation.inviterNickname}님이 ${invitationSummary.data.latestInvitation.roomName || "오픈채팅"}에 초대했어요.`
                    : "받은 초대를 확인하고 직접 참여하세요."}</Text>
              </View>
              {!!invitationSummary.data?.unreadCount && <View style={styles.badge}><Text style={styles.badgeLabel}>{invitationSummary.data.unreadCount > 99 ? "99+" : invitationSummary.data.unreadCount}</Text></View>}
            </Pressable>
            {query.error && <Text accessibilityRole="alert" style={styles.error}>{chatErrorMessage(query.error)}</Text>}
            {!query.isPending && !query.error && rooms.length === 0 && (
              <View style={styles.empty}>
                <Text style={styles.emptyTitle}>아직 참여한 대화방이 없어요</Text>
                <Text style={styles.subtitle}>친구에게 대화를 걸거나 새 오픈채팅을 만들어 보세요.</Text>
                <Button label="친구와 대화 시작" onPress={() => router.push("/friends")} />
                <Button label="오픈채팅 둘러보기" secondary onPress={() => router.push("/open")} />
              </View>
            )}
            {rooms.map((room) => (
              <Pressable key={room.id} accessibilityRole="button" accessibilityLabel={`${roomTitle(room)}, 안 읽은 메시지 ${room.unreadCount}개`}
                onPress={() => router.push({ pathname: "/chat/[roomId]", params: { roomId: room.id } })} style={styles.room}>
                <View style={styles.icon}><TabIcon kind={room.roomType === "OPEN" ? "open" : "chat"} color={colors.blue} /></View>
                <View style={styles.roomCopy}>
                  <Text style={styles.title}>{roomTitle(room)}</Text>
                  <Text style={styles.subtitle}>{room.roomType === "DIRECT" ? "1:1 대화" : room.roomType === "GROUP" ? "그룹 대화" : "오픈채팅"} · {room.memberCount}명</Text>
                </View>
                {room.unreadCount > 0 && <View style={styles.badge}><Text style={styles.badgeLabel}>{room.unreadCount > 99 ? "99+" : room.unreadCount}</Text></View>}
              </Pressable>
            ))}
            <Text style={styles.footnote}>친구 탭에서 새 1:1·그룹 대화를 시작할 수 있어요. 오픈채팅은 방별 닉네임으로 참여해요.</Text>
          </View>
        )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: { gap: 12 },
  actions: { flexDirection: "row", gap: 10 },
  action: { flex: 1 },
  room: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line, borderRadius: 20, padding: 16, flexDirection: "row", gap: 14, alignItems: "center" },
  icon: { width: 48, height: 48, flexShrink: 0, borderRadius: 16, backgroundColor: colors.blueSoft, alignItems: "center", justifyContent: "center" },
  roomCopy: { flex: 1, minWidth: 0, gap: 6 },
  title: { fontSize: 16, lineHeight: 23, fontWeight: "700", color: colors.ink },
  subtitle: { fontSize: 13, lineHeight: 21, color: colors.muted },
  badge: { backgroundColor: colors.blue, borderRadius: 14, paddingHorizontal: 8, paddingVertical: 4, flexShrink: 0 },
  badgeLabel: { color: colors.surface, fontWeight: "700", fontSize: 12, lineHeight: 18, alignSelf: "stretch", flexShrink: 0, textAlign: "center" },
  error: { color: "#9E3542", lineHeight: 22 },
  empty: { gap: 16, padding: 22, backgroundColor: colors.surface, borderRadius: 20 },
  emptyTitle: { color: colors.ink, fontSize: 18, fontWeight: "700" },
  footnote: { color: colors.muted, fontSize: 12, lineHeight: 20, marginTop: 8 },
});
