import { Pressable, Text, TextInput, View } from "react-native";

import { Button, InfoCard, StatusBadge } from "@/ui/components";
import { colors } from "@/ui/theme";

import { SUPPORT_CATEGORIES, SUPPORT_CATEGORY_LABELS, SUPPORT_STATUS_LABELS } from "./service";
import { supportStyles as styles } from "./support-styles";
import type { SupportWorkspace } from "./useSupportWorkspace";

// 서버 시각에는 시간대가 없다. 임의로 UTC로 변환하지 않고 원문 날짜·시각만 표시한다.
function displayTime(value: string) { return value.replace("T", " ").slice(0, 16); }

export function SupportInquiryComposer({ workspace }: { workspace: SupportWorkspace }) {
  const { draft, locked, confirmation, busy, setDraft, setConfirmation, leave } = workspace;
  return <View style={styles.card}>
    <Text accessibilityRole="header" style={styles.title}>새 문의 작성</Text>
    <Text style={styles.helper}>비밀번호나 인증 코드, 결제 정보는 적지 마세요. 문의 내용은 운영 담당자가 확인해요.</Text>
    <Text style={styles.label}>문의 종류</Text>
    <View style={styles.categories}>
      {SUPPORT_CATEGORIES.map(category => <Pressable key={category} accessibilityRole="radio"
        accessibilityState={{ checked: draft.category === category, disabled: locked || confirmation !== null }}
        disabled={locked || confirmation !== null} onPress={() => setDraft(value => ({ ...value, category }))}
        style={[styles.category, draft.category === category && styles.selected]}>
        <Text style={[styles.categoryLabel, draft.category === category && styles.selectedLabel]}>{draft.category === category ? "● " : "○ "}{SUPPORT_CATEGORY_LABELS[category]}</Text>
      </Pressable>)}
    </View>
    <Text style={styles.label}>제목</Text>
    <TextInput accessibilityLabel="문의 제목" value={draft.title} onChangeText={title => setDraft(value => ({ ...value, title }))}
      maxLength={200} editable={!locked && !confirmation} placeholder="무엇을 도와드릴까요?" placeholderTextColor={colors.faint} style={styles.input} />
    <Text style={styles.counter}>{draft.title.length}/200</Text>
    <Text style={styles.label}>내용</Text>
    <TextInput accessibilityLabel="문의 내용" value={draft.content} onChangeText={content => setDraft(value => ({ ...value, content }))}
      maxLength={10000} multiline textAlignVertical="top" editable={!locked && !confirmation} placeholder="문제 상황과 확인한 내용을 적어 주세요" placeholderTextColor={colors.faint} style={[styles.input, styles.editor]} />
    <Text style={styles.counter}>{draft.content.length}/10,000</Text>
    <Button label="문의 보내기" disabled={locked || !!confirmation || !draft.title.trim() || !draft.content.trim()}
      onPress={() => setConfirmation("create")} />
    <Button label="목록으로 돌아가기" secondary disabled={busy} onPress={leave} />
  </View>;
}

export function SupportInquiryDetail({ workspace }: { workspace: SupportWorkspace }) {
  const { detail, reply, locked, confirmation, busy, setReply, setConfirmation, support, leave } = workspace;
  if (!detail) return null;

  return <>
    <Button label="내 문의 목록" secondary disabled={busy} onPress={leave} />
    <View style={styles.card}>
      <View style={styles.badges}>
        <StatusBadge label={SUPPORT_STATUS_LABELS[detail.status]} tone={detail.status === "ANSWERED" ? "success" : "neutral"} />
        <Text style={styles.helper}>{SUPPORT_CATEGORY_LABELS[detail.category]}</Text>
      </View>
      <Text selectable accessibilityRole="header" style={styles.title}>{detail.title}</Text>
      <Text style={styles.meta}>문의 #{detail.id} · {displayTime(detail.createdAt)}</Text>
      <Text selectable style={styles.body}>{detail.content}</Text>
    </View>
    <Text accessibilityRole="header" style={styles.title}>답변 {detail.replyCount}</Text>
    {detail.replies.length === 0 && <InfoCard title="아직 답변이 없어요">운영 답변이 등록되면 이곳에서 확인할 수 있어요.</InfoCard>}
    {detail.replies.map(item => <View key={item.id} style={[styles.card, item.authorRole === "ADMIN" && styles.staffCard]}>
      <View style={styles.badges}>
        <StatusBadge label={item.authorRole === "ADMIN" ? "운영 답변" : "내 답글"} tone={item.authorRole === "ADMIN" ? "success" : "neutral"} />
        <Text style={styles.meta}>{displayTime(item.createdAt)}</Text>
      </View>
      <Text selectable style={styles.body}>{item.content}</Text>
    </View>)}
    <Button label="답변 새로고침" secondary disabled={busy || !!confirmation} onPress={() => support.open(detail.id)} />
    {detail.status === "CLOSED" ? <InfoCard title="종료된 문의예요">이 문의에는 답글을 더 보낼 수 없어요. 추가 도움이 필요하면 내 문의 목록에서 새 문의를 작성해 주세요.</InfoCard>
      : <View style={styles.card}>
        <Text accessibilityRole="header" style={styles.title}>추가로 전달할 내용</Text>
        <TextInput accessibilityLabel="문의 답글" value={reply} onChangeText={setReply} maxLength={10000}
          multiline textAlignVertical="top" editable={!locked && !confirmation} placeholder="운영 담당자에게 보낼 내용을 적어 주세요" placeholderTextColor={colors.faint} style={[styles.input, styles.editor]} />
        <Text style={styles.counter}>{reply.length}/10,000</Text>
        <Button label="답글 보내기" disabled={locked || !!confirmation || !reply.trim()} onPress={() => setConfirmation("reply")} />
      </View>}
  </>;
}

export function SupportInquiryList({ workspace }: { workspace: SupportWorkspace }) {
  const { state, busy, locked, support, setConfirmation, setWriting } = workspace;
  return <>
    <Button label="새 문의 작성" disabled={locked} onPress={() => { setConfirmation(null); setWriting(true); }} />
    <Button label="내 문의 새로고침" secondary disabled={busy} onPress={() => support.list(state.pageNumber)} />
    {state.page && <Text accessibilityRole="header" style={styles.title}>내 문의 {state.page.totalElements}</Text>}
    {state.page?.items.length === 0 && <InfoCard title="아직 보낸 문의가 없어요">궁금한 점이나 이용 중 겪은 문제를 새 문의로 보내 주세요.</InfoCard>}
    {state.page?.items.map(item => <Pressable key={item.id} accessibilityRole="button"
      accessibilityLabel={`${item.title}, ${SUPPORT_STATUS_LABELS[item.status]}, ${item.unread ? "새 답변 있음" : "답변 " + item.replyCount + "개"}`}
      accessibilityState={{ disabled: busy }} disabled={busy} onPress={() => support.open(item.id)} style={styles.card}>
      <View style={styles.badges}>
        <StatusBadge label={SUPPORT_STATUS_LABELS[item.status]} tone={item.status === "ANSWERED" ? "success" : "neutral"} />
        {item.unread && <StatusBadge label="새 답변" tone="warning" />}
      </View>
      <Text style={styles.title}>{item.title}</Text>
      <Text style={styles.meta}>{SUPPORT_CATEGORY_LABELS[item.category]} · 답변 {item.replyCount} · {displayTime(item.updatedAt)}</Text>
    </Pressable>)}
    {state.page && state.page.totalPages > 1 && <View style={styles.pagination}>
      <Button label="이전 문의" secondary disabled={busy || state.pageNumber <= 0} onPress={() => support.list(state.pageNumber - 1)} />
      <Text style={styles.helper}>{state.pageNumber + 1} / {state.page.totalPages}</Text>
      <Button label="다음 문의" secondary disabled={busy || state.pageNumber + 1 >= state.page.totalPages} onPress={() => support.list(state.pageNumber + 1)} />
    </View>}
    <Text style={styles.helper}>문의 상세에서 운영 답변을 확인할 수 있어요. 운영자 계정의 전체 문의 관리는 기존 웹에서 이용해 주세요.</Text>
  </>;
}
