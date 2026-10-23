import { useRouter } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { useAuth } from "@/auth/AuthProvider";
import { AppHeader, BackButton, Button, EmptyCard, InfoCard, PageHeading, Screen } from "@/ui/components";
import { colors } from "@/ui/theme";

import { useUserBlocks } from "./useUserBlocks";

export default function UserBlocksScreen() {
  const auth = useAuth();
  const router = useRouter();
  return <Screen>
    <AppHeader />
    <BackButton onPress={() => router.canGoBack() ? router.back() : router.replace("/settings")} />
    <PageHeading title="사용자 차단 관리" description="TranslaCat ID로 사용자를 확인하고 차단 목록을 관리해요." />
    {auth.status === "restoring" ? <ActivityIndicator color={colors.blue} accessibilityLabel="로그인 확인 중" />
      : auth.status === "signedIn" && auth.sessionKey ? <BlockWorkspace key={auth.sessionKey} />
        : <EmptyCard kind="friends" title="내 차단 목록" description="로그인 후 내 계정의 차단 목록을 확인하세요." onSignIn={() => router.push("/sign-in")} />}
  </Screen>;
}

function BlockWorkspace() {
  const blocks = useUserBlocks();
  const { state } = blocks;
  const [publicId, setPublicId] = useState("");
  const [visibleCount, setVisibleCount] = useState(30);
  const busy = !blocks.available || state.pending !== null;
  const locked = busy || !state.loaded || state.needsRefresh;
  const candidateBlocked = state.candidate && state.blocks.some(block => block.user.userId === state.candidate?.userId);

  return <View style={styles.content}>
    <InfoCard title="차단 범위를 확인해 주세요">
      차단하면 친구 관계가 해제되고 새 친구 요청과 대화 연결을 제한해요. 기존 방에서는 차단한 사용자의 메시지와 번역을 숨기고 해당 사용자의 메시지 알림·배지 집계에서 제외해요. 차단을 해제하면 대화를 다시 조회할 수 있고 친구는 자동으로 복원되지 않아요. 방 전체 알림은 방별 무음으로 설정해 주세요.
    </InfoCard>
    <View style={styles.card}>
      <Text accessibilityRole="header" style={styles.title}>TranslaCat ID로 찾기</Text>
      <TextInput accessibilityLabel="차단할 사용자의 TranslaCat ID" value={publicId} editable={!locked}
        onChangeText={value => { setPublicId(value); blocks.clearCandidate(); }} autoCapitalize="none" autoCorrect={false}
        maxLength={128} placeholder="TranslaCat ID" placeholderTextColor={colors.faint} style={styles.input}
        onSubmitEditing={() => { if (!locked && publicId.trim()) blocks.search(publicId); }} returnKeyType="search" />
      <Button label={state.pending === "search" ? "사용자 확인 중…" : "사용자 확인"} secondary disabled={locked || !publicId.trim()}
        onPress={() => blocks.search(publicId)} />
      {state.candidate && <View style={styles.result}>
        <Text style={styles.name}>{state.candidate.nickname}</Text>
        <Text selectable style={styles.helper}>@{state.candidate.publicId}</Text>
        <Text style={styles.helper}>{candidateBlocked ? "내가 차단한 사용자예요." : state.candidate.friendStatus === "BLOCKED" ? "연결이 제한된 계정이에요. 내 차단 여부는 아래 목록에서 확인할 수 있어요." : "닉네임과 ID가 맞는지 확인한 뒤 차단해 주세요."}</Text>
        {!candidateBlocked && <DangerButton label="이 사용자 차단" disabled={locked || !!state.confirmation} onPress={blocks.prepareBlock} />}
      </View>}
    </View>
    {state.confirmation && <View style={styles.confirmation}>
      <Text accessibilityRole="header" style={styles.title}>{state.confirmation.target.nickname}님을 {state.confirmation.kind === "block" ? "차단" : "차단 해제"}할까요?</Text>
      <Text selectable style={styles.helper}>@{state.confirmation.target.publicId}</Text>
      <Text style={styles.helper}>{state.confirmation.kind === "block" ? "기존 친구 관계가 해제돼요. 기존 대화 내용은 삭제되지 않아요." : "차단만 해제해요. 다시 친구가 되려면 친구 요청을 보내야 해요."}</Text>
      <DangerButton label={state.confirmation.kind === "block" ? "확인하고 차단" : "확인하고 차단 해제"} disabled={locked} onPress={blocks.confirm} />
      <Button label="취소" secondary disabled={busy} onPress={blocks.cancel} />
    </View>}
    {state.error && <Text accessibilityRole="alert" style={styles.error}>{state.error}</Text>}
    {state.notice && <Text accessibilityLiveRegion="polite" style={styles.helper}>{state.notice}</Text>}
    {state.pending && <ActivityIndicator color={colors.blue} accessibilityLabel={state.pending === "load" ? "차단 목록 확인 중" : "차단 요청 처리 중"} />}
    <Button label={state.pending === "load" ? "목록 확인 중…" : "차단 목록 새로고침"} secondary disabled={busy} onPress={blocks.reload} />
    <Text accessibilityRole="header" style={styles.title}>차단한 사용자 {state.loaded ? state.blocks.length : ""}</Text>
    {state.loaded && !state.needsRefresh && state.blocks.length === 0 && <InfoCard title="차단한 사용자가 없어요">차단한 계정은 이 목록에서 확인하고 해제할 수 있어요.</InfoCard>}
    {state.blocks.slice(0, visibleCount).map(block => <View key={block.id} style={styles.card}>
      <Text style={styles.name}>{block.user.nickname}</Text>
      <Text selectable style={styles.helper}>@{block.user.publicId}</Text>
      <Button label="차단 해제" secondary disabled={locked || !!state.confirmation} onPress={() => blocks.prepareUnblock(block.user.userId)} />
    </View>)}
    {state.blocks.length > visibleCount && <Button label="차단한 사용자 더 보기" secondary disabled={busy} onPress={() => setVisibleCount(value => value + 30)} />}
  </View>;
}

function DangerButton({ label, onPress, disabled }: { label: string; onPress: () => void; disabled: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [styles.dangerButton, disabled && styles.disabled, pressed && styles.pressed]}>
    <Text style={styles.dangerLabel}>{label}</Text>
  </Pressable>;
}

const styles = StyleSheet.create({
  content: { gap: 16, paddingBottom: 20 },
  card: { padding: 18, borderRadius: 20, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface, gap: 12 },
  title: { color: colors.ink, fontSize: 18, lineHeight: 28, fontWeight: "700", flexShrink: 1 },
  name: { color: colors.ink, fontSize: 16, lineHeight: 25, fontWeight: "700" },
  helper: { color: colors.muted, fontSize: 14, lineHeight: 23 },
  error: { color: colors.danger, fontSize: 14, lineHeight: 23 },
  input: { minHeight: 50, borderRadius: 14, borderWidth: 1, borderColor: colors.line, padding: 14, backgroundColor: colors.background, color: colors.ink, fontSize: 15, lineHeight: 24 },
  result: { gap: 10, paddingTop: 8 },
  confirmation: { padding: 18, borderRadius: 20, borderWidth: 1, borderColor: colors.danger, backgroundColor: colors.dangerSoft, gap: 12 },
  dangerButton: { minHeight: 52, borderRadius: 16, borderWidth: 1, borderColor: colors.danger, backgroundColor: colors.dangerSoft, paddingHorizontal: 16, paddingVertical: 14, alignItems: "stretch", justifyContent: "center" },
  dangerLabel: { color: colors.danger, fontSize: 15, lineHeight: 24, fontWeight: "700", textAlign: "center", alignSelf: "stretch", flexShrink: 0 },
  disabled: { opacity: 0.55 }, pressed: { opacity: 0.8 },
});

