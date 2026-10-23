import { useRouter } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Switch, Text, View } from "react-native";

import { useAuth } from "@/auth/AuthProvider";
import { wireId } from "@/domain/chat/contracts";
import { BackButton, Button, PageHeading, Screen, StatusBadge } from "@/ui/components";
import { colors } from "@/ui/theme";

import type { AiMember, AiProfileInput } from "./contracts";
import { AiProfileEditor } from "./AiProfileEditor";
import { manager } from "./controller";
import { useAiRoom } from "./useAiRoom";

const freshForm = (): AiProfileInput => ({ nickname: "", bio: "", originalLanguageCode: "ja", personaPrompt: "" });

function Choice({ label, description, selected, disabled, onPress }: {
  label: string; description: string; selected: boolean; disabled: boolean; onPress: () => void;
}) {
  return <Pressable accessibilityRole="radio" aria-checked={selected} accessibilityState={{ checked: selected, disabled }} disabled={disabled}
    onPress={onPress} style={[styles.choice, selected && styles.selected, disabled && styles.readonly]}>
    <Text style={styles.itemTitle}>{selected ? "● " : "○ "}{label}</Text>
    <Text style={styles.copy}>{description}</Text>
  </Pressable>;
}

function SettingToggle({ label, description, checked, disabled, onChange }: {
  label: string; description: string; checked: boolean; disabled: boolean; onChange: (value: boolean) => void;
}) {
  return <View style={styles.toggleRow}>
    <View style={styles.toggleCopy}><Text style={styles.itemTitle}>{label}</Text><Text style={styles.copy}>{description}</Text></View>
    <Switch accessibilityLabel={label} value={checked} disabled={disabled} onValueChange={onChange}
      trackColor={{ false: colors.line, true: colors.chat }} thumbColor={colors.surface} />
  </View>;
}

export default function AiRoomScreen({ roomId }: { roomId: string }) {
  const auth = useAuth();
  let valid = true;
  try { wireId(roomId); } catch { valid = false; }
  const ai = useAiRoom(valid ? roomId : null);

  // 권한 재확인·화면 비활성·계정 전환은 편집 화면을 교체해 persona 초안과 삭제 동의를 폐기한다.
  return <AiRoomContent key={`${auth.sessionKey ?? "signed-out"}:${roomId}:${ai.active}:${ai.state.revision}`}
    roomId={roomId} valid={valid} authStatus={auth.status} ai={ai} />;
}

function AiRoomContent({ roomId, valid, authStatus, ai }: {
  roomId: string; valid: boolean; authStatus: ReturnType<typeof useAuth>["status"]; ai: ReturnType<typeof useAiRoom>;
}) {
  const router = useRouter();
  const { state, controller, active, isActive } = ai;
  const [editor, setEditor] = useState<{ member: AiMember | null; revision: number } | null>(null);
  const [form, setForm] = useState<AiProfileInput>(freshForm);
  const [deleteTarget, setDeleteTarget] = useState<{ member: AiMember; revision: number } | null>(null);
  const settings = state.settings;
  const canManage = manager(state.room) && state.managementAvailable;
  const disabled = !active || state.loading || state.busy || state.uncertain || !canManage;
  const back = () => router.replace(valid ? `/chat/${roomId}` : "/");

  if (!valid || authStatus !== "signedIn") return <Screen>
    <BackButton onPress={back} />
    <PageHeading title={!valid ? "대화방 링크를 확인해 주세요" : "로그인이 필요해요"}
      description="참여한 대화방의 AI 설정을 확인하려면 올바른 방과 계정으로 열어 주세요." />
    {valid && <Button label="로그인" onPress={() => router.push("/sign-in")} />}
  </Screen>;

  const openEditor = (member: AiMember | null) => {
    // 현재 관리 권한을 다시 확인한 뒤 해당 revision의 초안만 편집한다.
    if (disabled || !isActive() || controller.current?.getState().revision !== state.revision) return;

    setEditor({ member, revision: state.revision });
    setForm(member ? { nickname: member.nickname, bio: member.bio ?? "", originalLanguageCode: member.originalLanguageCode,
      personaPrompt: member.personaPrompt } : freshForm());
    setDeleteTarget(null);
  };
  const save = async () => {
    // 편집 중 권한·활동 상태가 바뀐 초안은 저장 요청으로 이어지지 않는다.
    if (!editor || disabled || !isActive() || editor.revision !== controller.current?.getState().revision) return;

    const saved = editor.member ? await controller.current?.update(editor.member.aiMemberId, form)
      : await controller.current?.create(form);

    // 성공 응답을 확인했을 때만 편집 화면과 persona 초안을 비운다.
    if (saved) { setEditor(null); setForm(freshForm()); }
  };
  const field = (key: keyof AiProfileInput, value: string) => setForm(current => ({ ...current, [key]: value }));

  return <Screen>
    <BackButton onPress={back} />
    <StatusBadge label="AI와 함께하는 대화" />
    <PageHeading title="대화방 AI" description="AI의 성격을 정하고, 함께 대화하는 방식을 선택해 보세요." />
    <Button label="대화방으로 이동" onPress={back} secondary />
    <View style={styles.body}>
      {state.error && <Text accessibilityRole="alert" style={styles.error}>{state.error}</Text>}
      {state.notice && <Text accessibilityRole="alert" style={styles.notice}>{state.notice}</Text>}
      <Button label={state.loading ? "AI 설정 불러오는 중…" : "AI 설정 새로고침"} secondary
        disabled={state.loading || state.busy || !active} onPress={() => { void controller.current?.load(); }} />
      {state.uncertain && <View style={styles.warning}>
        <Text style={styles.copy}>목록을 새로고침해 방금 요청한 AI가 있는지 먼저 확인해 주세요. 확인을 마치면 이전 초안을 비우고 새로 시작해요.</Text>
        <Button label="목록 확인을 마쳤어요" disabled={state.loading || state.busy || !!state.error}
          onPress={() => { if (controller.current?.acknowledge()) { setEditor(null); setForm(freshForm()); setDeleteTarget(null); } }} />
      </View>}
      {state.loading && <ActivityIndicator accessibilityLabel="AI 설정 불러오는 중" color={colors.chat} />}
      {settings && <>
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>AI 대화 설정</Text>
          {!canManage && <Text style={styles.copy}>방 소유자와 관리자만 설정을 변경하고 AI를 추가할 수 있어요.</Text>}
          <Text style={styles.label}>AI 프로필 표시</Text>
          <Choice label="공개" description="방 참여자가 AI의 공개 프로필을 볼 수 있어요." selected={settings.disclosureType === "PUBLIC"}
            disabled={disabled} onPress={() => { void controller.current?.settings({ disclosureType: "PUBLIC" }); }} />
          <Choice label="비공개" description="일반 참여자에게 AI 프로필을 숨겨요." selected={settings.disclosureType === "PRIVATE"}
            disabled={disabled} onPress={() => { void controller.current?.settings({ disclosureType: "PRIVATE" }); }} />
          <Text style={styles.label}>AI를 @닉네임으로 부를 수 있는 사람</Text>
          <Choice label="모든 참여자" description="누구나 대화에서 AI를 부를 수 있어요." selected={settings.mentionPermission === "ALL_MEMBERS"}
            disabled={disabled} onPress={() => { void controller.current?.settings({ mentionPermission: "ALL_MEMBERS" }); }} />
          <Choice label="방 소유자와 관리자" description="AI를 부르는 권한을 관리자로 제한해요." selected={settings.mentionPermission === "OWNER_ADMIN_ONLY"}
            disabled={disabled} onPress={() => { void controller.current?.settings({ mentionPermission: "OWNER_ADMIN_ONLY" }); }} />
          <SettingToggle label="대화에 자동 참여" description="대화 흐름에 따라 AI가 응답할 수 있어요." checked={settings.conversationEnabled}
            disabled={disabled} onChange={value => { void controller.current?.settings({ conversationEnabled: value }); }} />
          <SettingToggle label="잠잠할 때 대화 이어가기" description="대화가 한동안 없으면 AI가 말을 걸 수 있어요." checked={settings.revivalEnabled}
            disabled={disabled} onChange={value => { void controller.current?.settings({ revivalEnabled: value }); }} />
        </View>
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>함께하는 AI · {settings.currentAiMemberCount}/{settings.maxAiMembersPerRoom}</Text>
          <Text style={styles.copy}>추가한 AI와의 대화는 이 채팅방에서 이어져요. @AI닉네임과 함께 메시지를 보내 보세요. 응답 여부는 방 설정과 대화 상황에 따라 달라요.</Text>
          {canManage && <Button label="새 AI 추가" disabled={disabled || settings.currentAiMemberCount >= settings.maxAiMembersPerRoom}
            onPress={() => openEditor(null)} />}
          {!canManage && <Text style={styles.copy}>{settings.disclosureType === "PRIVATE"
            ? "이 방의 AI 프로필은 비공개예요." : "AI가 보낸 메시지의 이름을 누르면 공개 프로필을 볼 수 있어요."}</Text>}
          {canManage && state.members.length === 0 && <Text style={styles.copy}>아직 함께하는 AI가 없어요. 첫 AI를 추가해 보세요.</Text>}
          {canManage && state.members.map(member => <View key={member.aiMemberId} style={styles.member}>
            <Text style={styles.itemTitle}>{member.nickname} · AI</Text>
            <Text style={styles.copy}>{member.bio || "아직 소개가 없어요."}</Text>
            <Text style={styles.small}>원문 언어 · {member.originalLanguageCode}</Text>
            <Button label={`${member.nickname}와 대화하기`} secondary disabled={state.busy || state.uncertain || !active}
              onPress={() => { if (isActive()) router.replace(`/chat/${roomId}?aiMention=${member.aiMemberId}`); }} />
            <View style={styles.actions}>
              <Pressable accessibilityRole="button" disabled={disabled} onPress={() => openEditor(member)} style={styles.textAction}>
                <Text style={styles.actionLabel}>AI 수정</Text>
              </Pressable>
              <Pressable accessibilityRole="button" disabled={disabled} onPress={() => {
                if (!isActive() || controller.current?.getState().revision !== state.revision) return;
                setEditor(null); setDeleteTarget({ member, revision: state.revision });
              }} style={styles.textAction}>
                <Text style={styles.danger}>AI 삭제</Text>
              </Pressable>
            </View>
          </View>)}
        </View>
      </>}
      {editor && editor.revision === state.revision && canManage && <AiProfileEditor editing={!!editor.member}
        form={form} disabled={disabled} busy={state.busy} onFieldChange={field} onSave={() => { void save(); }}
        onCancel={() => { setEditor(null); setForm(freshForm()); }} />}
      {deleteTarget && deleteTarget.revision === state.revision && canManage && <View style={styles.warning}>
        <Text style={styles.itemTitle}>{deleteTarget.member.nickname} AI를 이 방에서 삭제할까요?</Text>
        <Text style={styles.copy}>앞으로 이 AI와 대화할 수 없어요. 기존 메시지는 남아 있어요.</Text>
        <Button label={state.busy ? "삭제 중…" : "AI 삭제 확인"} disabled={disabled} onPress={() => {
          if (!isActive() || deleteTarget.revision !== controller.current?.getState().revision) return;
          void controller.current?.remove(deleteTarget.member.aiMemberId).then(saved => { if (saved) setDeleteTarget(null); });
        }} />
        <Button label="삭제 취소" secondary disabled={state.busy} onPress={() => setDeleteTarget(null)} />
      </View>}
    </View>
  </Screen>;
}

const styles = StyleSheet.create({
  body: { gap: 18, paddingVertical: 22 },
  card: { padding: 20, gap: 12, borderRadius: 22, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface },
  sectionTitle: { color: colors.ink, fontSize: 19, lineHeight: 28, fontWeight: "700" },
  itemTitle: { color: colors.ink, fontSize: 15, lineHeight: 23, fontWeight: "700" },
  copy: { color: colors.muted, fontSize: 14, lineHeight: 23 },
  small: { color: colors.muted, fontSize: 12, lineHeight: 20 },
  label: { color: colors.ink, fontSize: 14, lineHeight: 22, fontWeight: "600", marginTop: 10 },
  choice: { borderRadius: 14, borderWidth: 1, borderColor: colors.line, padding: 14, gap: 5 },
  selected: { borderColor: colors.chat, backgroundColor: colors.chatSoft },
  readonly: { opacity: 0.8 },
  toggleRow: { flexDirection: "row", gap: 14, alignItems: "center", paddingVertical: 10 },
  toggleCopy: { flex: 1, gap: 5 },
  member: { paddingTop: 18, gap: 9, borderTopWidth: 1, borderColor: colors.line },
  actions: { flexDirection: "row", gap: 24 },
  textAction: { minHeight: 44, justifyContent: "center" },
  actionLabel: { color: colors.blueDark, fontWeight: "700" },
  danger: { color: colors.danger, fontWeight: "700" },
  error: { color: colors.danger, lineHeight: 23 },
  notice: { color: colors.blueDark, lineHeight: 23 },
  warning: { backgroundColor: colors.warningSoft, borderRadius: 18, padding: 18, gap: 14 },
});
