import { useState } from "react";

import type { SupportCreateInput } from "./service";
import { useSupport } from "./useSupport";

const newDraft = (): SupportCreateInput => ({ title: "", content: "", category: "GENERAL" });

export function useSupportWorkspace() {
  const support = useSupport();
  const { state } = support;
  const [writing, setWriting] = useState(false);
  const [draft, setDraft] = useState<SupportCreateInput>(newDraft);
  const [reply, setReply] = useState("");
  const [confirmation, setConfirmation] = useState<"create" | "reply" | null>(null);
  const [lastDetailId, setLastDetailId] = useState<string | null>(null);
  const [lastCreateRevision, setLastCreateRevision] = useState(state.createRevision);
  const [lastReplyRevision, setLastReplyRevision] = useState(state.replyRevision);
  const busy = !support.available || state.pending !== null;
  const locked = busy || state.uncertain !== null;
  const detail = state.detail;

  // 확인된 성공 때만 작성 내용을 비운다. 결과 불명·실패 때는 사용자의 원문을 유지한다.
  // 서버 성공 번호·선택한 문의가 달라진 렌더에서만 초기화한다. 새로고침 중 null은 원문을 지우지 않는다.
  if (lastCreateRevision !== state.createRevision) {
    setLastCreateRevision(state.createRevision);
    setDraft(newDraft());
    setWriting(false);
  }
  if (lastReplyRevision !== state.replyRevision) {
    setLastReplyRevision(state.replyRevision);
    setReply("");
  }
  if (detail && detail.id !== lastDetailId) {
    setLastDetailId(detail.id);
    setReply("");
    setConfirmation(null);
  }
  if (!support.available && confirmation !== null) setConfirmation(null);

  const leave = () => {
    setConfirmation(null);
    setWriting(false);
    setReply("");
    support.backToList();
  };
  const submit = () => {
    if (locked) return;

    // 확인 종류를 먼저 보존한 뒤 동의를 닫고, 기존 통신 훅에 전송을 맡긴다.
    const kind = confirmation;
    setConfirmation(null);
    if (kind === "create") support.create({ ...draft });
    if (kind === "reply") support.reply(reply);
  };

  return {
    support, state, busy, locked, detail,
    writing, draft, reply, confirmation,
    setWriting, setDraft, setReply, setConfirmation,
    leave, submit,
  };
}

export type SupportWorkspace = ReturnType<typeof useSupportWorkspace>;
