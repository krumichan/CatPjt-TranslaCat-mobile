import { useRouter } from "expo-router";
import * as Crypto from "expo-crypto";
import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { useAuth } from "@/auth/AuthProvider";
import { useActivityGate } from "@/realtime/useActivity";
import { BackButton, Button, InfoCard, PageHeading, Screen } from "@/ui/components";
import { colors } from "@/ui/theme";

import { createReportController, emptyReportState } from "./controller";
import { createReportService, reportReasons, type ReportReason, type ReportTarget } from "./service";

export default function ReportScreen({ roomId, target }: { roomId: string; target: ReportTarget | null }) {
  const router = useRouter();
  const { api, status, sessionKey, isCurrentSession } = useAuth();
  const { active, isActive } = useActivityGate();
  const [reason, setReason] = useState<ReportReason>("SPAM");
  const [detail, setDetail] = useState("");
  const [state, setState] = useState(emptyReportState);
  const controller = useRef<ReturnType<typeof createReportController> | null>(null);
  useEffect(() => {
    let alive = true;
    const service = createReportService(api);
    const owned = createReportController({ roomId, create: service.create, requestId: Crypto.randomUUID,
      isCurrent: () => alive && isActive() && isCurrentSession(sessionKey), onChange: setState });
    controller.current = owned;
    return () => {
      alive = false;
      owned.dispose();
      if (controller.current === owned) controller.current = null;
    };
  }, [api, isCurrentSession, sessionKey, isActive, roomId]);
  useEffect(() => { if (active) controller.current?.resume(); else controller.current?.pause(); }, [active]);
  const locked = !active || status !== "signedIn" || state.pending || state.uncertain || !!state.confirmation || !!state.receipt;
  return <Screen>
    <BackButton onPress={() => router.canGoBack() ? router.back() : router.replace("/")} />
    <PageHeading title={target?.targetType === "MEMBER" ? "참여자 신고" : "메시지 신고"} description="운영자가 내용을 확인하고 처리 결과를 기록해요." />
    <InfoCard title="신고 내용은 운영자만 확인해요">검토를 위해 신고 대상의 메시지·방 프로필 일부를 증거로 보관해요. 증거는 신고 후 90일이 지나면 자동 삭제해요. 신고만으로 계정을 자동 제재하지 않아요. 원하지 않는 대화는 사용자 차단과 방별 무음도 이용할 수 있어요.</InfoCard>
    {!target || !roomId ? <InfoCard title="신고 대상을 확인해 주세요">참여 중인 방의 메시지 또는 참여자 목록에서 다시 열어 주세요.</InfoCard>
      : status !== "signedIn" ? <Button label="로그인" onPress={() => router.push("/sign-in")} />
        : state.receipt ? <InfoCard title="신고를 접수했어요">접수 번호 {state.receipt.id}. 운영자가 신고 내용을 확인해요. 같은 신고를 다시 보내지 않아도 돼요.</InfoCard>
          : <View style={styles.card}>
            <Text accessibilityRole="header" style={styles.title}>신고 사유</Text>
            <View style={styles.reasons}>
              {reportReasons.map(([value, label]) => <Pressable key={value} accessibilityRole="radio" accessibilityState={{ checked: reason === value, disabled: locked }}
                disabled={locked} onPress={() => setReason(value)} style={[styles.reason, reason === value && styles.selected]}><Text style={styles.label}>{label}</Text></Pressable>)}
            </View>
            <Text style={styles.label}>추가 설명 (선택, 2,000자 이내)</Text>
            <TextInput accessibilityLabel="신고 추가 설명" value={detail} onChangeText={setDetail} editable={!locked} multiline maxLength={2000} style={styles.input} />
            {state.confirmation ? <>
              <Text style={styles.description}>선택한 {target.targetType === "MESSAGE" ? "메시지" : "참여자"}를 {reportReasons.find(([value]) => value === state.confirmation?.reason)?.[1]} 사유로 신고할까요?</Text>
              {state.confirmation.detail.trim() !== "" && <Text style={styles.description}>{state.confirmation.detail}</Text>}
              <Button label={state.pending ? "접수 확인 중…" : state.uncertain ? "동일 신고 접수 확인" : "확인하고 신고 접수"} disabled={!active || state.pending} onPress={() => { void controller.current?.confirm(); }} />
              {!state.uncertain && <Button label="취소하고 수정" secondary disabled={state.pending} onPress={() => controller.current?.cancel()} />}
            </> : <Button label="신고 내용 확인" disabled={locked} onPress={() => controller.current?.prepare(target, reason, detail)} />}
            {state.error && <Text accessibilityRole="alert" style={styles.error}>{state.error}</Text>}
          </View>}
  </Screen>;
}

const styles = StyleSheet.create({
  card: { borderRadius: 22, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface, padding: 20, gap: 16, marginTop: 16 },
  title: { fontSize: 18, lineHeight: 27, fontWeight: "700", color: colors.ink },
  reasons: { gap: 10 },
  reason: { borderWidth: 1, borderColor: colors.line, padding: 14, borderRadius: 14 },
  selected: { borderColor: colors.blue, backgroundColor: colors.blueSoft },
  label: { color: colors.ink, fontSize: 14, lineHeight: 22 },
  description: { color: colors.muted, fontSize: 14, lineHeight: 24 },
  input: { minHeight: 120, maxHeight: 240, borderWidth: 1, borderColor: colors.line, borderRadius: 14, padding: 14, fontSize: 15, lineHeight: 24, textAlignVertical: "top", color: colors.ink },
  error: { color: colors.danger, fontSize: 14, lineHeight: 23 },
});
