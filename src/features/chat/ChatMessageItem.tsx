import { Pressable, StyleSheet, Text, View } from "react-native";

import type { ChatLanguageSettings, ChatMessage, ChatRoomType } from "@/domain/chat/types";
import { colors } from "@/ui/theme";

interface ChatMessageItemProps {
  message: ChatMessage;
  currentUserId: string | undefined;
  currentOpenMemberId: string | null;
  roomType: ChatRoomType | undefined;
  language: ChatLanguageSettings | null;
  firstUnreadMessageId: string | null;
  onOpenAiProfile: (aiMemberId: string) => void;
  onReport: (messageId: string) => void;
}

export function ChatMessageItem({ message, currentUserId, currentOpenMemberId, roomType, language,
  firstUnreadMessageId, onOpenAiProfile, onReport }: ChatMessageItemProps) {
  // 계정·오픈채팅 별칭을 구분하고, 가려진 메시지의 프로필 동작과 번역을 노출하지 않는다.
  const hidden = message.contentVisibility !== undefined && message.contentVisibility !== "VISIBLE";
  const mine = message.senderType === "USER" && (message.senderUserId === currentUserId
    || (currentOpenMemberId !== null && message.sender?.openChatMemberId === currentOpenMemberId));
  const system = message.senderType === "SYSTEM" || message.messageType === "SYSTEM";
  const aiMemberId = message.senderAiMemberId;
  const senderName = message.authorDeleted ? "탈퇴한 사용자" : hidden ? "숨겨진 메시지" : roomType === "OPEN" && message.senderType === "USER"
    ? message.sender?.nickname ?? "오픈채팅 참여자" : message.senderName ?? (message.senderType === "AI" ? "AI" : "참여자");

  // 사용자 언어 설정에 맞는 번역을 우선하고, 번역이 없으면 원문을 유지한다.
  const preferred = hidden ? undefined : message.translations.find((translation) => translation.languageCode === language?.translationLanguageCode)
    ?? message.translations[0];
  const translated = language?.showTranslation !== false && preferred?.status === "COMPLETED" ? preferred.translatedContent : null;
  const original = language?.showOriginal !== false || !translated;

  return (
    <View style={styles.messageItem}>
      {firstUnreadMessageId === message.id && <Text style={styles.unreadBoundary}>여기부터 읽지 않은 메시지</Text>}
      <View style={[styles.messageRow, mine && styles.mineRow, system && styles.systemRow]}>
        {!system && !hidden && (message.senderType === "AI" && aiMemberId ? (
          <Pressable accessibilityRole="button" accessibilityLabel={`${senderName} AI 공개 프로필 보기`}
            onPress={() => onOpenAiProfile(aiMemberId)}>
            <Text style={styles.sender}>{senderName} · AI ›</Text>
          </Pressable>
        ) : <Text style={styles.sender}>{senderName}{message.senderType === "AI" ? " · AI" : ""}</Text>)}
        <View style={[styles.bubble, mine && styles.mineBubble, system && styles.systemBubble]}>
          {message.status === "DELETED" ? <Text style={styles.deleted}>삭제된 메시지예요.</Text> : (
            <>
              {original && <Text selectable style={styles.messageText}>{message.content}</Text>}
              {translated && <Text selectable style={[styles.messageText, original && styles.translation]}>{translated}</Text>}
              {language?.showTranslation !== false && preferred?.status === "PENDING" && <Text style={styles.meta}>번역 중…</Text>}
              {language?.showTranslation !== false && preferred?.status === "FAILED" && <Text style={styles.meta}>번역하지 못했어요. 원문을 확인해 주세요.</Text>}
            </>
          )}
        </View>
        {!system && <Text style={styles.meta}>{new Date(message.createdAt).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}
          {message.unreadMemberCount !== null && message.unreadMemberCount > 0 ? ` · 안 읽음 ${message.unreadMemberCount}` : ""}</Text>}
        {!mine && !system && !hidden && !message.authorDeleted && message.status !== "DELETED" && <Pressable accessibilityRole="button" accessibilityLabel="이 메시지 신고"
          onPress={() => onReport(message.id)} style={styles.reportAction}>
          <Text style={styles.meta}>⋯</Text>
        </Pressable>}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  messageItem: { width: "100%" },
  unreadBoundary: { textAlign: "center", color: colors.blueDark, backgroundColor: colors.blueSoft, padding: 8, borderRadius: 10, marginBottom: 14, fontSize: 12 },
  messageRow: { alignSelf: "flex-start", maxWidth: "88%", gap: 5 },
  mineRow: { alignSelf: "flex-end", alignItems: "flex-end" },
  systemRow: { alignSelf: "center", maxWidth: "95%" },
  sender: { color: colors.muted, fontSize: 12, lineHeight: 19 },
  reportAction: { minWidth: 44, minHeight: 36, justifyContent: "center", alignItems: "center" },
  bubble: { backgroundColor: colors.surface, borderRadius: 18, padding: 14, borderWidth: 1, borderColor: colors.line, gap: 8 },
  mineBubble: { backgroundColor: colors.blueSoft, borderColor: colors.blueLine },
  systemBubble: { backgroundColor: "#ECF0F5", borderWidth: 0 },
  messageText: { color: colors.ink, fontSize: 15, lineHeight: 23 },
  translation: { borderTopWidth: 1, borderTopColor: colors.blueLine, paddingTop: 10 },
  meta: { color: colors.muted, fontSize: 11, lineHeight: 18 },
  deleted: { color: colors.muted, fontSize: 13, fontStyle: "italic" },
});
