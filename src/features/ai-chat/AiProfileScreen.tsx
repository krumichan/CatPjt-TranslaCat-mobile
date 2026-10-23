import { useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";

import { ApiError } from "@/api/client";
import { useAuth } from "@/auth/AuthProvider";
import { wireId } from "@/domain/chat/contracts";
import { useActivityGate } from "@/realtime/useActivity";
import { BackButton, Button, PageHeading, Screen, StatusBadge } from "@/ui/components";
import { colors } from "@/ui/theme";

import { visibleAiProfile } from "./access";
import { aiErrorMessage } from "./controller";
import { createAiService, type AiService } from "./service";

export default function AiProfileScreen({ roomId, memberId }: { roomId: string; memberId: string }) {
  const auth = useAuth();
  const router = useRouter();
  const { active, isActive } = useActivityGate();
  const service = useMemo(() => createAiService(auth.api), [auth.api]);
  const [revision, setRevision] = useState(0);
  let valid = true;
  try { wireId(roomId); wireId(memberId); } catch { valid = false; }

  const back = () => router.replace(valid ? `/chat/${roomId}` : "/");
  return <Screen>
    <BackButton onPress={back} />
    <StatusBadge label="AI 공개 프로필" />
    <PageHeading title="대화방 AI" description="이 방에서 함께 대화하는 AI를 만나 보세요." />
    {!valid || auth.status !== "signedIn" || !auth.sessionKey ? <Text style={styles.copy}>방 링크와 로그인 상태를 확인해 주세요.</Text>
      : active ? <AiProfileBody key={`${auth.sessionKey}:${roomId}:${memberId}:${revision}`} service={service}
        roomId={roomId} memberId={memberId} sessionKey={auth.sessionKey} isActive={isActive} onRefresh={() => setRevision(value => value + 1)} />
        : <Text style={styles.copy}>앱으로 돌아오면 프로필과 공개 설정을 다시 확인해요.</Text>}
  </Screen>;
}

function AiProfileBody({ service, roomId, memberId, sessionKey, isActive, onRefresh }: {
  service: AiService; roomId: string; memberId: string; sessionKey: string; isActive: () => boolean; onRefresh: () => void;
}) {
  const { isCurrentSession } = useAuth();
  const router = useRouter();
  const [value, setValue] = useState<Awaited<ReturnType<typeof visibleAiProfile>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // 부모가 활성화한 수명을 이어받아 첫 요청도 차단되지 않도록 한다.
    // 비활성 전환과 계정 교체는 렌더 시점보다 현재 수명으로 먼저 확인한다.
    if (!isActive() || !isCurrentSession(sessionKey)) return;
    const abort = new AbortController();
    let alive = true;
    const current = () => alive && isActive() && isCurrentSession(sessionKey);
    void visibleAiProfile(service, roomId, memberId, abort.signal).then(result => {
      if (current()) setValue(result);
    }).catch((failure: unknown) => {
      if (!current()) return;
      setError(failure instanceof ApiError && failure.code === "AI_PROFILE_PRIVATE"
        ? "이 방의 AI 프로필은 비공개예요." : aiErrorMessage(failure));
    }).finally(() => { if (current()) setLoading(false); });
    return () => { alive = false; abort.abort(); };
  }, [isActive, isCurrentSession, memberId, roomId, service, sessionKey]);

  return <>
    {loading && <ActivityIndicator accessibilityLabel="AI 프로필 불러오는 중" color={colors.chat} />}
    {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
    {value && <View style={styles.card}>
        <View style={styles.avatar}><Text style={styles.avatarLabel}>AI</Text></View>
        <Text style={styles.name}>{value.profile.nickname}</Text>
        <Text style={styles.copy}>{value.profile.bio || "아직 소개가 없어요."}</Text>
        <Text style={styles.copy}>원문 언어 · {value.profile.originalLanguageCode}</Text>
        {value.canMention ? <Button label={`${value.profile.nickname}와 대화하기`}
          onPress={() => { if (isActive()) router.replace(`/chat/${roomId}?aiMention=${memberId}`); }} />
          : <Text style={styles.copy}>이 방에서는 소유자와 관리자만 AI를 부를 수 있어요.</Text>}
    </View>}
    {!loading && <Button label="프로필 새로고침" secondary onPress={() => { if (isActive()) onRefresh(); }} />}
  </>;
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderColor: colors.line, borderRadius: 24, backgroundColor: colors.surface, padding: 24, gap: 16, marginBottom: 20 },
  avatar: { backgroundColor: colors.chatSoft, width: 70, height: 70, borderRadius: 24, alignItems: "center", justifyContent: "center" },
  avatarLabel: { color: colors.chat, fontSize: 24, fontWeight: "800" },
  name: { color: colors.ink, fontSize: 23, lineHeight: 32, fontWeight: "700" },
  copy: { color: colors.muted, fontSize: 15, lineHeight: 25 },
  error: { color: colors.danger, fontSize: 14, lineHeight: 23, marginBottom: 20 },
});
