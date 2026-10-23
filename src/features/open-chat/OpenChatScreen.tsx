import { useRouter } from "expo-router";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { useAuth } from "@/auth/AuthProvider";
import { ChatContractError } from "@/domain/chat/contracts";
import type { OpenRoom } from "@/domain/chat/types";
import { chatErrorMessage, createChatService } from "@/features/chat/service";
import { useFocusedActive } from "@/realtime/useActivity";
import { AppHeader, Button, EmptyCard, InfoCard, PageHeading, Screen } from "@/ui/components";
import { colors } from "@/ui/theme";

const blockedReasons: Record<string, string> = {
  ROOM_CLOSED: "종료된 방이에요.", ROOM_FULL: "정원이 가득 찼어요.", BANNED: "이 방의 참여가 제한됐어요.",
};

export default function OpenChatScreen() {
  const auth = useAuth();
  const router = useRouter();
  const active = useFocusedActive();
  const service = useMemo(() => createChatService(auth.api), [auth.api]);
  const generation = useRef(0);
  const cancellation = useRef<AbortController | null>(null);
  const [query, setQuery] = useState("");
  const [searchText, setSearchText] = useState("");
  const [selected, setSelected] = useState<OpenRoom | null>(null);
  const [nickname, setNickname] = useState("");
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const listing = useInfiniteQuery({
    queryKey: ["open-chat-rooms", auth.sessionKey, query],
    queryFn: ({ pageParam, signal }) => service.openRooms(query, pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.hasNext ? lastPage.nextCursorId ?? undefined : undefined,
    enabled: active && auth.status === "signedIn" && !!auth.sessionKey,
    staleTime: 0,
    retry: false,
  });

  useEffect(() => {
    generation.current += 1;
    if (!active || auth.status !== "signedIn" || !auth.sessionKey) return;
    const controller = new AbortController();
    cancellation.current = controller;
    return () => {
      generation.current += 1;
      controller.abort();
      if (cancellation.current === controller) cancellation.current = null;
    };
  }, [active, auth.sessionKey, auth.status, query]);

  const openDetail = async (roomId: string, verifying = false) => {
    if (busy || !active) return;
    const version = generation.current;
    setBusy(true);
    setNotice(null);
    if (!verifying) { setSelected(null); setUncertain(false); setNickname(""); }
    try {
      const room = await service.openRoom(roomId, cancellation.current?.signal);
      if (generation.current !== version) return;
      setSelected(room);
      if (verifying) setNotice(room.joined ? "참여가 확인됐어요. 대화방을 열 수 있어요." : "현재 참여가 확인되지 않았어요. 잠시 후 다시 확인해 주세요.");
    } catch (error) {
      if (generation.current === version) setNotice(chatErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const join = async () => {
    if (!selected || busy || uncertain || !active || !selected.joinable) return;
    if (!selected.myOpenProfile && (!nickname.trim() || nickname.length > 50)) {
      setNotice("이 방에서 사용할 닉네임을 1~50자로 입력해 주세요.");
      return;
    }
    const version = generation.current;
    setBusy(true);
    setNotice(null);
    try {
      // 재참여는 서버에 남은 방별 프로필을 유지한다. 일반 계정 프로필은 가져오지 않는다.
      const room = await service.join(selected.id, selected.myOpenProfile ? null : nickname.trim(), cancellation.current?.signal);
      if (!room.joined) throw new ChatContractError();
      if (generation.current !== version) return;
      router.push({ pathname: "/chat/[roomId]", params: { roomId: room.id } });
    } catch (error) {
      if (generation.current !== version) return;
      const rejected = !!error && typeof error === "object" && "status" in error
        && typeof error.status === "number" && error.status >= 400 && error.status < 500;
      setUncertain(!rejected);
      setNotice(rejected ? chatErrorMessage(error) : "참여 결과를 확인하지 못했어요. 자동으로 다시 요청하지 않아요. 참여 상태를 먼저 확인해 주세요.");
    } finally {
      setBusy(false);
    }
  };

  const search = () => {
    setSelected(null);
    setNotice(null);
    setUncertain(false);
    const next = searchText.trim();
    if (next === query) { void listing.refetch(); }
    else setQuery(next);
  };

  const rooms = [...new Map((listing.data?.pages.flatMap((page) => page.rooms) ?? []).map((room) => [room.id, room])).values()];
  return (
    <Screen>
      <AppHeader />
      <PageHeading title="오픈채팅" description="관심사가 통하는 사람들과 새로운 이야기를." />
      {auth.status === "restoring" ? <ActivityIndicator color={colors.blue} accessibilityLabel="로그인 확인 중" />
        : auth.status === "signedOut" ? <EmptyCard kind="open" title="새로운 대화를 만나 보세요" description="로그인하고 공개방을 둘러보거나 방별 프로필로 참여해요." onSignIn={() => router.push("/sign-in")} /> : (
          <View style={styles.content}>
            <Button label="오픈방 만들기" onPress={() => router.push("/open/create")} />
            <TextInput accessibilityLabel="오픈채팅 검색" placeholder="방 이름이나 설명으로 검색" placeholderTextColor={colors.faint}
              value={searchText} onChangeText={setSearchText} returnKeyType="search" onSubmitEditing={search} style={styles.input} />
            <Button label="공개방 검색" onPress={search} />
            {listing.error && <Text accessibilityRole="alert" style={styles.notice}>{chatErrorMessage(listing.error)}</Text>}
            {notice && <Text accessibilityRole="alert" style={styles.notice}>{notice}</Text>}
            {busy && <ActivityIndicator color={colors.blue} accessibilityLabel="오픈채팅 확인 중" />}
            {selected && (
              <View style={styles.card}>
                <Text accessibilityRole="header" style={styles.roomTitle}>{selected.name}</Text>
                <Text style={styles.description}>{selected.description}</Text>
                <Text style={styles.description}>{selected.memberCount} / {selected.maxMemberCount}명</Text>
                {selected.joined ? <Button label="대화방 열기" onPress={() => router.push({ pathname: "/chat/[roomId]", params: { roomId: selected.id } })} />
                  : !selected.joinable ? <Text style={styles.notice}>{blockedReasons[selected.joinBlockedReason] ?? "현재 이 방에 참여할 수 없어요."}</Text> : (
                    <>
                      {selected.myOpenProfile ? <Text style={styles.description}>이전 방별 프로필 ‘{selected.myOpenProfile.nickname}’으로 다시 참여해요. 재참여 이전 대화는 볼 수 없어요.</Text>
                        : <TextInput accessibilityLabel="이 방에서 사용할 닉네임" placeholder="방별 닉네임 (최대 50자)" placeholderTextColor={colors.faint}
                          value={nickname} onChangeText={setNickname} maxLength={50} style={styles.input} />}
                      <Text style={styles.description}>일반 프로필과 TranslaCat ID는 다른 참여자에게 표시되지 않아요.</Text>
                      <Pressable accessibilityRole="button" accessibilityState={{ disabled: busy || uncertain }} disabled={busy || uncertain}
                        onPress={() => { void join(); }} style={[styles.join, (busy || uncertain) && styles.disabled]}>
                        <Text style={styles.joinLabel}>이 프로필로 참여</Text>
                      </Pressable>
                      {uncertain && <Button label="참여 상태 다시 확인" secondary onPress={() => { void openDetail(selected.id, true); }} />}
                    </>
                  )}
                <Button label="방 상세 닫기" secondary onPress={() => setSelected(null)} />
              </View>
            )}
            {listing.isFetching && <ActivityIndicator color={colors.blue} accessibilityLabel="공개방 불러오는 중" />}
            {!listing.isPending && !listing.error && rooms.length === 0 && <Text style={styles.description}>찾은 공개방이 없어요. 검색어를 바꿔 보세요.</Text>}
            {rooms.map((room) => (
              <Pressable key={room.id} accessibilityRole="button" onPress={() => { void openDetail(room.id); }} style={styles.card}>
                <Text style={styles.roomTitle}>{room.name}</Text>
                <Text numberOfLines={3} style={styles.description}>{room.description}</Text>
                <Text style={styles.roomMeta}>{room.memberCount} / {room.maxMemberCount}명 · {room.joined ? "참여 중" : room.joinable ? "참여 가능" : "참여 제한"}</Text>
              </Pressable>
            ))}
            {listing.hasNextPage && <Button label="공개방 더 보기" secondary onPress={() => {
              if (!listing.isFetching && !busy) void listing.fetchNextPage();
            }} />}
          </View>
        )}
      <InfoCard title="앱의 오픈채팅 기능을 차례로 넓혀가요">
        공개방을 만들거나 검색해 참여할 수 있어요. 프로필 이미지와 방장·관리자 기능은 준비 중이에요.
      </InfoCard>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { gap: 14 },
  input: { minHeight: 50, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line, borderRadius: 16, paddingHorizontal: 15, paddingVertical: 13, color: colors.ink, fontSize: 14 },
  card: { padding: 20, borderRadius: 22, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line, gap: 12 },
  roomTitle: { fontSize: 18, lineHeight: 27, fontWeight: "700", color: colors.ink },
  description: { color: colors.muted, fontSize: 14, lineHeight: 23 },
  roomMeta: { color: colors.blueDark, fontSize: 12, lineHeight: 20 },
  notice: { color: "#8E3442", fontSize: 13, lineHeight: 22 },
  join: { backgroundColor: colors.blue, borderRadius: 16, minHeight: 52, alignItems: "center", justifyContent: "center", padding: 14 },
  joinLabel: { color: colors.surface, fontSize: 15, lineHeight: 23, fontWeight: "700",
    alignSelf: "stretch", flexShrink: 0, textAlign: "center" },
  disabled: { opacity: 0.45 },
});
