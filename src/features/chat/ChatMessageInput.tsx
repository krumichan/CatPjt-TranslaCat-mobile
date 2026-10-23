import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import type { ChatRoom } from "@/domain/chat/types";
import { Button } from "@/ui/components";
import { colors } from "@/ui/theme";

interface ChatMessageInputProps {
  draft: string;
  onDraftChange: (value: string) => void;
  room: Pick<ChatRoom, "active" | "closed"> | null;
  authorityReady: boolean;
  sending: boolean;
  disabled: boolean;
  uncertain: boolean;
  aiNotice: string | null;
  notice: string | null;
  onClearUncertain: () => void;
  onPrepareFocus: () => void;
  onSend: () => void;
}

export function ChatMessageInput({ draft, onDraftChange, room, authorityReady, sending, disabled, uncertain,
  aiNotice, notice, onClearUncertain, onPrepareFocus, onSend }: ChatMessageInputProps) {
  const sendDisabled = disabled || !draft.trim();

  return (
    <View style={styles.composer}>
      {aiNotice && <Text accessibilityRole="alert" style={styles.notice}>{aiNotice}</Text>}
      {notice && <Text accessibilityRole="alert" style={styles.notice}>{notice}</Text>}
      {uncertain && <Button label="작성 내용 지우고 새로 작성" secondary onPress={onClearUncertain} />}
      {room && (!room.active || room.closed) && <Text style={styles.notice}>종료된 대화방에는 메시지를 보낼 수 없어요.</Text>}
      <View style={styles.inputRow}>
        <TextInput accessibilityLabel="메시지 입력" multiline maxLength={5000} value={draft} onChangeText={onDraftChange}
          onPressIn={onPrepareFocus} onFocus={onPrepareFocus}
          placeholder="메시지를 입력하세요" placeholderTextColor={colors.faint} editable={!sending && authorityReady && !!room?.active && !room.closed}
          style={styles.input} />
        <Pressable accessibilityRole="button" accessibilityLabel="메시지 보내기" accessibilityState={{ disabled: sendDisabled }}
          disabled={sendDisabled} onPress={onSend} style={[styles.send, sendDisabled && styles.disabled]}>
          <Text style={styles.sendLabel}>{sending ? "전송 중" : "보내기"}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  notice: { color: colors.muted, fontSize: 12, lineHeight: 21 },
  composer: { flexShrink: 0, backgroundColor: colors.surface, borderTopWidth: 1, borderColor: colors.line, padding: 12, gap: 10 },
  inputRow: { flexDirection: "row", alignItems: "flex-end", gap: 10 },
  input: { flex: 1, minHeight: 48, maxHeight: 140, borderRadius: 16, backgroundColor: colors.background, padding: 13, fontSize: 15, color: colors.ink, textAlignVertical: "top" },
  send: { borderRadius: 16, backgroundColor: colors.blue, minHeight: 48, paddingHorizontal: 15, justifyContent: "center" },
  sendLabel: { color: colors.surface, fontWeight: "700", fontSize: 13 },
  disabled: { opacity: 0.4 },
});
