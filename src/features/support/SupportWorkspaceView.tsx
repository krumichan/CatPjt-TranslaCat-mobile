import { ActivityIndicator, Text, View } from "react-native";

import { Button } from "@/ui/components";
import { colors } from "@/ui/theme";

import { SupportInquiryComposer, SupportInquiryDetail, SupportInquiryList } from "./SupportInquirySections";
import { supportStyles as styles } from "./support-styles";
import type { SupportWorkspace } from "./useSupportWorkspace";

export function SupportWorkspaceView({ workspace }: { workspace: SupportWorkspace }) {
  const { state, busy, locked, writing, detail, confirmation, setWriting, setConfirmation, support, submit } = workspace;

  // 통신 결과 안내와 확인 버튼은 문의 작성·상세·목록 어느 화면에서도 같은 위치에 둔다.
  return <View style={styles.content}>
    {state.uncertain && state.pending !== "create" && state.pending !== "reply" && <View style={styles.warning}>
      <Text accessibilityRole="header" style={styles.title}>전송 결과를 확인해 주세요</Text>
      <Text style={styles.helper}>연결이 끊겨도 문의나 답글이 접수됐을 수 있어요. 자동으로 다시 보내지 않아요. 아래에서 목록이나 답변을 새로 확인한 뒤 같은 내용을 중복 전송하지 않도록 살펴봐 주세요.</Text>
      <Button label="전송 결과 새로 확인" secondary disabled={busy} onPress={() => {
        setWriting(false);
        if (state.uncertain?.inquiryId) support.open(state.uncertain.inquiryId);
        else support.list(0);
      }} />
      <Button label="확인했어요 · 중복 전송에 주의할게요" secondary disabled={busy || !state.uncertain.reviewed} onPress={support.acknowledgeUncertain} />
    </View>}
    {state.error && <Text accessibilityRole="alert" style={styles.error}>{state.error}</Text>}
    {state.notice && <Text accessibilityLiveRegion="polite" style={styles.helper}>{state.notice}</Text>}
    {state.pending && <ActivityIndicator color={colors.blue} accessibilityLabel="문의 처리 중" />}

    {writing ? <SupportInquiryComposer workspace={workspace} />
      : detail ? <SupportInquiryDetail workspace={workspace} />
        : <SupportInquiryList workspace={workspace} />}

    {confirmation && <View style={styles.confirmation}>
      <Text accessibilityRole="header" style={styles.title}>{confirmation === "create" ? "문의 내용을 보낼까요?" : "추가 답글을 보낼까요?"}</Text>
      <Text style={styles.helper}>위에 작성한 내용이 운영 담당자에게 전달돼요. 비밀번호나 인증 코드가 들어 있지 않은지 확인해 주세요.</Text>
      <Button label={confirmation === "create" ? "확인하고 문의 전송" : "확인하고 답글 전송"} disabled={locked} onPress={submit} />
      <Button label="취소하고 수정" secondary disabled={busy} onPress={() => setConfirmation(null)} />
    </View>}
  </View>;
}

