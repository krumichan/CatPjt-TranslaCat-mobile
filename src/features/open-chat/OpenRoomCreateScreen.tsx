import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { useAuth } from "@/auth/AuthProvider";
import { useActivityGate } from "@/realtime/useActivity";
import { AppHeader, BackButton, Button, EmptyCard, InfoCard, PageHeading, Screen } from "@/ui/components";
import { colors } from "@/ui/theme";
import { createOpenRoomService, type OpenRoomCreateField, type OpenRoomCreateInput, type OpenRoomVisibility } from "./create-service";
import { createOpenRoomSubmission } from "./create-session";

const initialInput: OpenRoomCreateInput = { name: "", description: "", visibility: "PUBLIC", maxMemberCount: "50", nickname: "" };

export default function OpenRoomCreateScreen() {
  const auth = useAuth();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { active, isActive } = useActivityGate();
  const [input, setInput] = useState(initialInput);
  const { api, isCurrentSession, sessionKey } = auth;
  const service = useMemo(() => createOpenRoomService(api), [api]);
  const submission = useMemo(() => createOpenRoomSubmission(service,
    () => isCurrentSession(sessionKey) && isActive()), [service, isCurrentSession, sessionKey, isActive]);
  const state = useSyncExternalStore(submission.subscribe, submission.getSnapshot, submission.getSnapshot);
  const locked = ["submitting", "uncertain", "created"].includes(state.status);

  useEffect(() => {
    submission.attach();
    return () => { submission.detach(); };
  }, [submission]);
  useEffect(() => { if (!active) submission.cancel(); }, [active, submission]);

  const change = (field: OpenRoomCreateField, value: string) => {
    if (locked) return;
    submission.clearValidation();
    setInput(current => ({ ...current, [field]: value }));
  };
  const changeVisibility = (visibility: OpenRoomVisibility) => {
    if (locked) return;
    submission.clearValidation();
    setInput(current => ({ ...current, visibility }));
  };
  const enterRoom = (roomId: string) => {
    if (!isCurrentSession(sessionKey) || !isActive()) return;
    // 생성한 방과 공개 탐색 목록을 새로 조회한다. 캐시에 일반 계정 프로필을 복사하지 않는다.
    void queryClient.invalidateQueries({ queryKey: ["chat-rooms", sessionKey] });
    void queryClient.invalidateQueries({ queryKey: ["open-chat-rooms", sessionKey] });
    router.replace({ pathname: "/chat/[roomId]", params: { roomId } });
  };
  const submit = async () => {
    const room = await submission.submit(input);
    if (room) enterRoom(room.id);
  };

  return (
    <Screen>
      <AppHeader />
      <BackButton onPress={() => { submission.cancel(); router.back(); }} />
      <PageHeading title="오픈방 만들기" description="함께 나눌 이야기와 이 방에서 쓸 프로필을 정해요." />
      {auth.status === "restoring" ? <ActivityIndicator color={colors.blue} accessibilityLabel="로그인 확인 중" />
        : auth.status !== "signedIn" ? <EmptyCard kind="open" title="로그인하고 방을 만들어 보세요" description="방별 프로필로 새로운 대화를 시작할 수 있어요." onSignIn={() => router.push("/sign-in")} /> : (
          <View style={styles.form}>
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>어떤 이야기를 나눌까요?</Text>
              <Text style={styles.label}>방 이름</Text>
              <TextInput accessibilityLabel="방 이름" placeholder="방 이름을 입력해 주세요" placeholderTextColor={colors.faint}
                value={input.name} onChangeText={value => change("name", value)} maxLength={100} editable={!locked} style={styles.input} />
              <Text style={styles.help}>{input.name.length}/100</Text>
              {state.fields.name && <Text accessibilityRole="alert" style={styles.error}>{state.fields.name}</Text>}
              <Text style={styles.label}>방 설명</Text>
              <TextInput accessibilityLabel="방 설명" placeholder="대화 주제와 참여 안내를 적어 주세요" placeholderTextColor={colors.faint}
                value={input.description} onChangeText={value => change("description", value)} maxLength={500} editable={!locked}
                multiline textAlignVertical="top" style={[styles.input, styles.description]} />
              <Text style={styles.help}>{input.description.length}/500</Text>
              {state.fields.description && <Text accessibilityRole="alert" style={styles.error}>{state.fields.description}</Text>}
            </View>
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>공개 범위</Text>
              {([
                { value: "PUBLIC", title: "전체 공개", description: "오픈채팅 목록과 검색에 표시돼요." },
                { value: "UNLISTED", title: "링크 공개", description: "목록과 검색에 표시되지 않아요. 방 주소를 아는 사람이 접근할 수 있어요." },
              ] as const).map(option => (
                <Pressable key={option.value} accessibilityRole="radio" aria-checked={input.visibility === option.value} accessibilityState={{ checked: input.visibility === option.value, disabled: locked }}
                  disabled={locked} onPress={() => changeVisibility(option.value)} style={[styles.option, input.visibility === option.value && styles.selected]}>
                  <Text style={styles.optionTitle}>{input.visibility === option.value ? "● " : "○ "}{option.title}</Text>
                  <Text style={styles.help}>{option.description}</Text>
                </Pressable>
              ))}
              {state.fields.visibility && <Text accessibilityRole="alert" style={styles.error}>{state.fields.visibility}</Text>}
              <Text style={styles.label}>최대 인원</Text>
              <TextInput accessibilityLabel="최대 인원" value={input.maxMemberCount} onChangeText={value => change("maxMemberCount", value)}
                keyboardType="number-pad" maxLength={3} editable={!locked} style={styles.input} />
              <Text style={styles.help}>방장을 포함해 2~100명까지 참여할 수 있어요.</Text>
              {state.fields.maxMemberCount && <Text accessibilityRole="alert" style={styles.error}>{state.fields.maxMemberCount}</Text>}
            </View>
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>이 방에서 사용할 프로필</Text>
              <Text style={styles.label}>방별 닉네임</Text>
              <TextInput accessibilityLabel="방별 닉네임" placeholder="이 방에서 사용할 이름" placeholderTextColor={colors.faint}
                value={input.nickname} onChangeText={value => change("nickname", value)} maxLength={50} editable={!locked} style={styles.input} />
              <Text style={styles.help}>일반 프로필과 TranslaCat ID는 다른 참여자에게 표시되지 않아요. 방을 만들면 이 프로필로 방장이 돼요.</Text>
              {state.fields.nickname && <Text accessibilityRole="alert" style={styles.error}>{state.fields.nickname}</Text>}
            </View>
            {state.message && <Text accessibilityRole="alert" style={styles.error}>{state.message}</Text>}
            {state.status === "submitting" && <ActivityIndicator color={colors.blue} accessibilityLabel="오픈방 만드는 중" />}
            {state.status === "uncertain" ? <Button label="내 채팅에서 생성 결과 확인" onPress={() => router.replace("/")} />
              : state.status === "created" && state.roomId ? <Button label="만든 방 열기" disabled={!active} onPress={() => { if (state.roomId) enterRoom(state.roomId); }} />
                : <Button label={state.status === "submitting" ? "오픈방 만드는 중…" : "오픈방 만들기"} disabled={locked || !active} onPress={() => { void submit(); }} />}
            <Button label="취소" secondary disabled={state.status === "submitting"} onPress={() => router.back()} />
          </View>
        )}
      <InfoCard title="방별 프로필로 대화해요">공개 범위를 확인한 뒤 방을 만들어 주세요. 프로필 이미지와 방장 관리 기능은 차례로 연결할 예정이에요.</InfoCard>
    </Screen>
  );
}

const styles = StyleSheet.create({
  form: { gap: 18 },
  section: { gap: 12, padding: 20, borderRadius: 22, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line },
  sectionTitle: { fontSize: 17, fontWeight: "700", color: colors.ink, lineHeight: 26 },
  label: { color: colors.ink, fontSize: 14, fontWeight: "600", marginTop: 4 },
  input: { minHeight: 50, paddingHorizontal: 15, paddingVertical: 13, borderWidth: 1, borderColor: colors.line, borderRadius: 14, color: colors.ink, backgroundColor: colors.background, fontSize: 15 },
  description: { minHeight: 112 },
  help: { color: colors.muted, fontSize: 13, lineHeight: 21 },
  option: { gap: 6, borderWidth: 1, borderColor: colors.line, borderRadius: 16, padding: 15 },
  selected: { borderColor: colors.blue, backgroundColor: colors.blueSoft },
  optionTitle: { fontSize: 15, lineHeight: 23, fontWeight: "700", color: colors.ink },
  error: { color: "#8E3442", fontSize: 13, lineHeight: 22 },
});
