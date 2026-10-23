import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Text, TextInput, View } from "react-native";

import { useAuth } from "@/auth/AuthProvider";
import { useActivityGate } from "@/realtime/useActivity";
import { AppHeader, Button, EmptyCard, InfoCard, PageHeading, Screen } from "@/ui/components";
import { colors } from "@/ui/theme";
import { chatErrorMessage } from "@/features/chat/service";

import { createFriendActionSession } from "./action-session";
import { FriendListItem } from "./FriendListItem";
import { FriendRequestSection } from "./FriendRequestSection";
import { styles } from "./friends-styles";
import { createFriendService, groupRequest, type FriendSearch, type FriendStatus } from "./service";

const statusLabels: Record<FriendStatus, string> = {
  NONE: "친구 요청을 보내 보세요", FRIEND: "이미 친구예요", REQUEST_SENT: "친구 요청을 보냈어요",
  REQUEST_RECEIVED: "받은 요청에서 수락해 주세요", BLOCKED: "이 계정과 연결할 수 없어요", SELF: "내 계정이에요",
};

export default function FriendsScreen() {
  const auth = useAuth();
  const router = useRouter();
  return (
    <Screen>
      <AppHeader />
      <PageHeading title="친구" description="친구를 찾고, 새로운 대화를 시작해요." />
      {auth.status === "restoring" ? <ActivityIndicator color={colors.blue} accessibilityLabel="로그인 확인 중" />
        : auth.status === "signedIn" && auth.sessionKey
          ? <FriendWorkspace key={auth.sessionKey} sessionKey={auth.sessionKey} />
          : <EmptyCard kind="friends" title="친구와 더 가까이" description="TranslaCat ID로 친구를 찾고 대화를 시작하세요." onSignIn={() => router.push("/sign-in")} />}
    </Screen>
  );
}

function FriendWorkspace({ sessionKey }: { sessionKey: string }) {
  const auth = useAuth();
  const isCurrentSession = auth.isCurrentSession;
  const router = useRouter();
  const cache = useQueryClient();
  const { active, isActive } = useActivityGate();
  const service = useMemo(() => createFriendService(auth.api), [auth.api]);
  const actions = useRef<ReturnType<typeof createFriendActionSession> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [publicId, setPublicId] = useState("");
  const [searching, setSearching] = useState(false);
  const [found, setFound] = useState<FriendSearch | null>(null);
  const [showGroup, setShowGroup] = useState(false);
  const [groupName, setGroupName] = useState("");
  const [description, setDescription] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [visibleFriends, setVisibleFriends] = useState(30);
  const searchOwner = useRef<{ sequence: number; cancel: AbortController | null }>({ sequence: 0, cancel: null });
  const current = () => auth.isCurrentSession(sessionKey);

  const friends = useQuery({ queryKey: ["friends", sessionKey], queryFn: ({ signal }) => service.friends(signal), enabled: active && current(), retry: false });
  const received = useQuery({ queryKey: ["friend-requests", sessionKey, "received"], queryFn: ({ signal }) => service.received(signal), enabled: active && current(), retry: false });
  const sent = useQuery({ queryKey: ["friend-requests", sessionKey, "sent"], queryFn: ({ signal }) => service.sent(signal), enabled: active && current(), retry: false });

  const selectedFriends = selected.filter(id => friends.data?.some(friend => friend.userId === id));

  useEffect(() => {
    // effect 재실행마다 새 소유자를 만들고 StrictMode 정리 뒤에도 요청을 다시 시작할 수 있게 한다.
    const owner = createFriendActionSession(() => isCurrentSession(sessionKey));
    const search = searchOwner.current;
    actions.current = owner;
    return () => {
      search.sequence += 1;
      search.cancel?.abort();
      owner.dispose();
      if (actions.current === owner) actions.current = null;
    };
  }, [isCurrentSession, sessionKey]);

  const refresh = async () => {
    await Promise.allSettled([friends.refetch(), received.refetch(), sent.refetch()]);
  };

  const run = async <T,>(request: (signal: AbortSignal) => Promise<T>, success: (value: T) => void, createsRoom = false) => {
    const owner = actions.current;
    if (!current() || !isActive() || !owner || owner.busy || owner.uncertainRoom) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const result = await owner.run(request, createsRoom);
    if (!current() || actions.current !== owner) return;
    setBusy(false);
    if (result.kind === "ignored") return;
    if (result.kind === "success") {
      // 응답을 받은 같은 세션만 캐시를 갱신하고 새 대화방으로 이동한다.
      void cache.invalidateQueries({ queryKey: ["chat-rooms", sessionKey] });
      if (isActive()) success(result.value);
      else setNotice("요청을 처리했어요. 목록을 새로고침해 결과를 확인해 주세요.");
    } else if (result.kind === "failure") {
      setUncertain(result.uncertainRoom);
      setError(result.uncertainRoom
        ? "대화방 생성 결과를 확인하지 못했어요. 이미 만들어졌을 수 있으니 내 채팅에서 확인해 주세요. 자동으로 다시 만들지 않아요."
        : "요청을 처리하지 못했어요. 친구 관계와 연결 상태를 새로 확인해 주세요.");
    }
  };

  const search = async () => {
    if (!publicId.trim() || busy || uncertain || !current()) return;
    // 더 늦게 도착한 이전 검색 결과가 새 ID의 검색 결과를 덮지 않게 한다.
    searchOwner.current.cancel?.abort();
    const sequence = ++searchOwner.current.sequence;
    const cancellation = new AbortController();
    searchOwner.current.cancel = cancellation;
    setSearching(true);
    setFound(null);
    setError(null);
    try {
      const person = await service.search(publicId, cancellation.signal);
      if (current() && searchOwner.current.sequence === sequence) setFound(person);
    } catch {
      if (current() && searchOwner.current.sequence === sequence && !cancellation.signal.aborted) {
        setError("해당 TranslaCat ID를 찾지 못했어요. ID와 연결 상태를 확인해 주세요.");
      }
    } finally {
      if (current() && searchOwner.current.sequence === sequence) setSearching(false);
    }
  };

  const openRoom = (id: string) => router.push({ pathname: "/chat/[roomId]", params: { roomId: id } });
  const respondToRequest = (requestId: string, action: "accept" | "reject" | "cancel") => {
    void run(signal => service.respond(requestId, action, signal), () => {
      if (action === "accept") setNotice("친구가 됐어요. 이제 대화를 시작할 수 있어요.");
      void refresh();
    });
  };

  const startGroup = () => {
    try {
      const request = groupRequest(groupName, description, selectedFriends, friends.data ?? [], auth.user!.id);
      void run(signal => service.group(request, signal), room => openRoom(room.id), true);
    } catch { setError("그룹 이름과 참여할 친구를 확인해 주세요. 친구는 한 명 이상 선택해 주세요."); }
  };

  return (
    <View style={styles.content}>
      <View style={styles.searchCard}>
        <Text style={styles.sectionTitle}>TranslaCat ID로 친구 찾기</Text>
        <Text style={styles.helper}>내 ID: {auth.user?.publicId}</Text>
        <TextInput accessibilityLabel="친구 TranslaCat ID" value={publicId} onChangeText={value => {
          setPublicId(value); setFound(null); searchOwner.current.sequence += 1; searchOwner.current.cancel?.abort(); setSearching(false);
        }} autoCapitalize="none" autoCorrect={false} placeholder="친구의 TranslaCat ID" placeholderTextColor={colors.faint} style={styles.input} editable={!busy && !uncertain} onSubmitEditing={() => { void search(); }} />
        <Button label={searching ? "친구 찾는 중…" : "친구 찾기"} disabled={!publicId.trim() || busy || searching || uncertain} onPress={() => { void search(); }} />
        {found && <View style={styles.result}>
          <Text style={styles.name}>{found.nickname}</Text>
          <Text style={styles.helper}>@{found.publicId} · {statusLabels[found.friendStatus]}</Text>
          {found.friendStatus === "NONE" && <Button label="친구 요청 보내기" disabled={busy || uncertain} onPress={() => { void run(signal => service.request(found.publicId, signal), () => {
            setFound({ ...found, friendStatus: "REQUEST_SENT" }); setNotice("친구 요청을 보냈어요."); void refresh();
          }); }} />}
          {found.friendStatus === "FRIEND" && <Button label="1:1 대화 시작" disabled={busy || uncertain} onPress={() => { void run(signal => service.direct(found.userId, signal), room => openRoom(room.id), true); }} />}
        </View>}
      </View>

      {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
      {notice && <Text accessibilityRole="alert" style={styles.helper}>{notice}</Text>}
      {uncertain && <Button label="내 채팅에서 확인하기" onPress={() => router.push("/")} />}
      <Button label="사용자 차단 관리" secondary disabled={busy} onPress={() => router.push("/blocks")} />
      <Button label="친구·요청 새로고침" secondary disabled={busy} onPress={() => { void refresh(); }} />

      <FriendRequestSection
        direction="received"
        requests={received.data}
        pending={received.isPending}
        error={received.error}
        disabled={busy || uncertain}
        onRespond={respondToRequest}
      />

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>내 친구 {friends.data?.length ?? ""}</Text>
        {friends.isPending && <ActivityIndicator color={colors.blue} accessibilityLabel="친구 목록 확인 중" />}
        {friends.error && <Text style={styles.error}>{chatErrorMessage(friends.error)}</Text>}
        {friends.data?.length === 0 && <Text style={styles.helper}>친구의 ID를 검색해 첫 친구를 추가해 보세요.</Text>}
        {!!friends.data?.length && <Button label={showGroup ? "그룹 만들기 닫기" : "친구들과 그룹 만들기"} secondary disabled={busy || uncertain} onPress={() => setShowGroup(!showGroup)} />}
        {showGroup && <View style={styles.card}>
          <Text style={styles.sectionTitle}>새 그룹 대화</Text>
          <TextInput accessibilityLabel="그룹 이름" value={groupName} onChangeText={setGroupName} maxLength={100} placeholder="그룹 이름" placeholderTextColor={colors.faint} style={styles.input} editable={!busy && !uncertain} />
          <TextInput accessibilityLabel="그룹 설명" value={description} onChangeText={setDescription} maxLength={500} placeholder="그룹 설명 (선택)" placeholderTextColor={colors.faint} style={styles.input} editable={!busy && !uncertain} />
          <Text style={styles.helper}>아래에서 함께할 친구를 선택하세요. {selectedFriends.length}명 선택</Text>
          <Button label="친구 선택 초기화" secondary disabled={busy || uncertain} onPress={() => setSelected([])} />
          <Button label={busy ? "만드는 중…" : "그룹 대화 시작"} disabled={busy || uncertain || !groupName.trim() || selectedFriends.length === 0 || friends.isFetching} onPress={startGroup} />
        </View>}
        {friends.data?.slice(0, visibleFriends).map(friend => (
          <FriendListItem
            key={friend.relationId}
            friend={friend}
            choosingGroup={showGroup}
            selected={selected.includes(friend.userId)}
            disabled={busy || uncertain}
            onToggle={() => setSelected(value => value.includes(friend.userId)
              ? value.filter(id => id !== friend.userId)
              : [...value, friend.userId])}
            onStartChat={() => {
              void run(signal => service.direct(friend.userId, signal), room => openRoom(room.id), true);
            }}
          />
        ))}
        {(friends.data?.length ?? 0) > visibleFriends && <Button label="친구 더 보기" secondary onPress={() => setVisibleFriends(value => value + 30)} />}
      </View>

      <FriendRequestSection
        direction="sent"
        requests={sent.data}
        error={sent.error}
        disabled={busy || uncertain}
        onRespond={respondToRequest}
      />
      <InfoCard title="내 친구와 연결돼요">친구 요청을 수락하면 1:1 또는 그룹 대화를 시작할 수 있어요. 오픈채팅에서는 방별 닉네임으로 만나요.</InfoCard>
    </View>
  );
}
