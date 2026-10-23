import { useRouter } from "expo-router";
import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, FlatList, Keyboard, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useAuth } from "@/auth/AuthProvider";
import { wireId } from "@/domain/chat/contracts";
import type { ChatMessage } from "@/domain/chat/types";
import { useAiMention } from "@/features/ai-chat/useAiMention";
import { BackButton, Button, PageHeading, Screen } from "@/ui/components";
import { colors } from "@/ui/theme";

import { roomTitle } from "./RoomListScreen";
import { ChatMessageInput } from "./ChatMessageInput";
import { ChatMessageItem } from "./ChatMessageItem";
import { ChatRoomHeader } from "./ChatRoomHeader";
import { useChatScroll } from "./useChatScroll";
import { useRoomChat } from "./useRoomChat";

// 네이티브 Keyboard의 현재 상태를 구독해 화면 진입 당시 열린 키보드도 반영한다.
function subscribeKeyboardVisibility(notify: () => void) {
  const show = Keyboard.addListener("keyboardDidShow", notify);
  const hide = Keyboard.addListener("keyboardDidHide", notify);
  return () => { show.remove(); hide.remove(); };
}
const keyboardVisible = () => Keyboard.isVisible();
const keyboardHiddenOnServer = () => false;

export default function ChatRoomScreen({ roomId }: { roomId: string }) {
  const keyboardOpen = useSyncExternalStore(subscribeKeyboardVisibility, keyboardVisible, keyboardHiddenOnServer);
  const auth = useAuth();
  const router = useRouter();

  // 방 번호와 계정 경계는 화면에서 확인하고, 대화 상태는 기존 controller에 위임한다.
  let valid = true;
  try { wireId(roomId); } catch { valid = false; }
  const chat = useRoomChat(valid ? roomId : null);
  const { state } = chat;
  const [draft, setDraft] = useState("");
  const aiNotice = useAiMention(roomId, setDraft);

  // 목록 배치와 읽음 판정은 같은 ref를 공유해 입력 포커스·키보드 전환에도 유지한다.
  const list = useRef<FlatList<ChatMessage>>(null);
  const scroll = useChatScroll({ messages: state.messages, loading: state.loading, entryTarget: state.entryTarget,
    active: chat.active, markVisible: chat.markVisible, setReadingReady: chat.setReadingReady }, list);
  const viewabilityConfig = useMemo(() => ({ viewAreaCoveragePercentThreshold: 25, minimumViewTime: 450 }), []);

  if (!valid || auth.status !== "signedIn") return (
    <Screen>
      <BackButton onPress={() => router.replace("/")} />
      <PageHeading title={!valid ? "대화방 링크를 확인해 주세요" : "로그인이 필요해요"}
        description={!valid ? "대화방 번호를 안전하게 확인할 수 없어요. 올바른 링크로 다시 열어 주세요." : "참여한 대화방에 접근하려면 먼저 기존 계정으로 로그인해 주세요."} />
      {valid && <Button label="로그인" onPress={() => router.push("/sign-in")} />}
    </Screen>
  );

  const goToLatest = () => { chat.chooseLatest(); scroll.jumpToLatest(); };
  const send = async () => {
    // 서버 전송 성공을 확인한 뒤에만 초안을 지우고 최신 대화로 이동한다.
    if (await chat.send(draft)) {
      setDraft("");
      goToLatest();
    }
  };
  const verifyingAuthority = !!state.room && !state.authorityReady;
  const disabled = !state.authorityReady || !state.room?.active || state.room.closed || state.loading || state.sending || state.uncertain || !chat.active;

  const renderMessage = ({ item }: { item: ChatMessage }) => (
    <ChatMessageItem message={item} currentUserId={auth.user?.id}
      currentOpenMemberId={state.profile?.openChatMemberId ?? null} roomType={state.room?.roomType} language={state.language}
      firstUnreadMessageId={state.entryTarget?.unread ? state.entryTarget.messageId : null}
      onOpenAiProfile={aiMemberId => router.push(`/chat/${roomId}/ai-member/${aiMemberId}`)}
      onReport={messageId => router.push({ pathname: "/chat/[roomId]/report", params: { roomId, messageId } })} />
  );

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === "ios" ? "padding" : "height"} keyboardVerticalOffset={0}>
      {/* 키보드가 내비게이션 영역을 덮을 때 provider의 bottom inset을 다시 더하지 않는다. */}
      <SafeAreaView style={styles.screen} edges={keyboardOpen ? ["top", "left", "right"] : ["top", "left", "right", "bottom"]}>
        <ChatRoomHeader title={state.room ? roomTitle(state.room) : "대화방"} refreshing={state.syncing}
          onBack={() => router.replace("/")} onRefresh={() => { void chat.refresh(); }} onLatest={goToLatest}
          onParticipants={state.authorityReady && state.room ? () => router.push(`/chat/${roomId}/members`) : undefined}
          onRoomManagement={state.authorityReady && state.room ? () => router.push(`/chat/${roomId}/manage`) : undefined}
          onAiSettings={state.authorityReady && state.room?.active && !state.room.closed && state.room.roomType !== "DIRECT" ? () => router.push(`/chat/${roomId}/ai`) : undefined} />
        {state.error && <Text accessibilityRole="alert" style={styles.error}>{state.error}</Text>}
        {state.loading ? <ActivityIndicator style={styles.loading} accessibilityLabel="대화 불러오는 중" color={colors.blue} /> : (
          <View style={styles.timeline}>
          <FlatList
            ref={list}
            style={[styles.list, (!scroll.placed || verifyingAuthority) && styles.positioning]}
            scrollEnabled={scroll.placed && !verifyingAuthority}
            pointerEvents={scroll.placed && !verifyingAuthority ? "auto" : "none"}
            accessibilityElementsHidden={!scroll.placed || verifyingAuthority}
            importantForAccessibility={scroll.placed && !verifyingAuthority ? "auto" : "no-hide-descendants"}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
            data={state.messages}
            keyExtractor={(message) => message.id}
            renderItem={renderMessage}
            contentContainerStyle={styles.messages}
            maintainVisibleContentPosition={scroll.placed ? { minIndexForVisible: 0 } : undefined}
            onViewableItemsChanged={scroll.onViewableItemsChanged}
            viewabilityConfig={viewabilityConfig}
            onLayout={scroll.onLayout}
            onContentSizeChange={scroll.onContentSizeChange}
            onScroll={scroll.onScroll}
            onScrollBeginDrag={scroll.onScrollBeginDrag}
            onScrollEndDrag={scroll.onScrollEndDrag}
            onTouchMove={scroll.onScrollBeginDrag}
            onTouchEnd={scroll.onTouchEnd}
            onTouchCancel={scroll.onTouchCancel}
            onMomentumScrollBegin={scroll.onMomentumScrollBegin}
            onMomentumScrollEnd={scroll.onMomentumScrollEnd}
            {...(Platform.OS === "web" ? { onWheel: scroll.onWheel } : {})}
            onScrollToIndexFailed={scroll.onScrollToIndexFailed}
            scrollEventThrottle={16}
            ListHeaderComponent={state.hasMore ? <Button label={state.loadingMore ? "이전 대화 불러오는 중…" : "이전 대화 보기"} secondary onPress={() => { void chat.loadOlder(); }} /> : undefined}
            ListEmptyComponent={<Text style={styles.empty}>{state.room ? "첫 메시지를 보내 보세요." : "대화방 참여 상태를 확인해 주세요."}</Text>}
          />
          {(!scroll.placed || verifyingAuthority) && <View style={styles.positionStatus} pointerEvents="none">
            {(verifyingAuthority || (state.entryTarget && !scroll.positionError)) && <ActivityIndicator color={colors.blue} />}
            <Text style={styles.notice}>{verifyingAuthority ? "방 참여 상태를 확인하고 있어요…"
              : scroll.positionError ?? (state.entryTarget ? "읽던 위치로 이동하고 있어요…" : "읽던 위치를 다시 확인하거나 최신 메시지로 이동해 주세요.")}</Text>
          </View>}
          </View>
        )}
        {state.authorityReady && (!scroll.atLatest || !scroll.placed) && <Pressable accessibilityRole="button" onPress={goToLatest} style={styles.latest}>
          <Text style={styles.refreshLabel}>최신 메시지로 이동 ↓</Text>
        </Pressable>}
        <ChatMessageInput draft={draft} onDraftChange={setDraft} room={state.room} authorityReady={state.authorityReady}
          sending={state.sending} disabled={disabled} uncertain={state.uncertain} aiNotice={aiNotice} notice={state.notice}
          onClearUncertain={() => { setDraft(""); chat.clearUncertain(); }} onPrepareFocus={scroll.prepareComposerFocus}
          onSend={() => { void send(); }} />
      </SafeAreaView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  timeline: { flex: 1, minHeight: 0 },
  list: { flex: 1, minHeight: 0 },
  positioning: { opacity: 0 },
  positionStatus: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center", padding: 24, gap: 12 },
  refreshLabel: { color: colors.blueDark, fontSize: 13, fontWeight: "600", lineHeight: 20 },
  loading: { flex: 1 },
  messages: { padding: 16, gap: 16, flexGrow: 1 },
  empty: { color: colors.muted, textAlign: "center", paddingVertical: 36, lineHeight: 24 },
  error: { color: "#9E3542", padding: 16, lineHeight: 22 },
  notice: { color: colors.muted, fontSize: 12, lineHeight: 21 },
  latest: { alignSelf: "center", minHeight: 38, justifyContent: "center", paddingHorizontal: 16 },
});
