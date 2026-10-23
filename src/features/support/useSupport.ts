import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { useAuth } from "@/auth/AuthProvider";
import { useActivityGate } from "@/realtime/useActivity";

import { createSupportController, emptySupportState, withSupportRevisionOffset, type SupportCreateInput, type SupportRevisions, type SupportUncertain } from "./controller";
import { createSupportService } from "./service";

// POST 중 화면을 떠났다가 돌아와도 같은 세션의 결과 불명 전송을 반복하지 않는다.
// 본문·제목·토큰은 저장하지 않고 쓰기 종류와 문의 ID만 메모리에 유지한다.
const pendingBySession = new Map<string, SupportUncertain>();

export function useSupport() {
  const { api, status, sessionKey, user, isCurrentSession } = useAuth();
  const { active, isActive } = useActivityGate();
  const selfId = user?.id ?? null;
  const service = useMemo(() => selfId ? createSupportService(api, selfId) : null, [api, selfId]);
  const owner = useMemo(() => ({ service, active, status, sessionKey }), [service, active, status, sessionKey]);
  const current = useRef<object | null>(owner);
  const controller = useRef<ReturnType<typeof createSupportController> | null>(null);
  const revisions = useRef<SupportRevisions>({ createRevision: 0, replyRevision: 0 });
  const [value, setValue] = useState(() => ({ owner, state: emptySupportState() }));

  // commit부터 이전 화면·계정의 확인 버튼과 늦은 네트워크 응답 소유권을 폐기한다.
  useLayoutEffect(() => { current.current = owner; return () => { if (current.current === owner) current.current = null; }; }, [owner]);
  useEffect(() => {
    if (!active || status !== "signedIn" || !sessionKey || !service) return;
    const isCurrent = () => current.current === owner && isActive() && isCurrentSession(sessionKey);
    const uncertain = pendingBySession.get(sessionKey) ?? null;
    // 각 컨트롤러의 0부터 시작하는 번호를 이 작업 화면의 이전 성공 번호에 연결한다.
    const offset = revisions.current;
    const owned = createSupportController({ service, isCurrent, initialUncertain: uncertain,
      onChange: state => {
        if (!isCurrent()) return;
        const mapped = withSupportRevisionOffset(state, offset);
        revisions.current = { createRevision: mapped.createRevision, replyRevision: mapped.replyRevision };
        setValue({ owner, state: mapped });
      },
      onUncertainChange: next => {
        if (!isCurrent()) return;
        if (next) pendingBySession.set(sessionKey, { ...next });
        else pendingBySession.delete(sessionKey);
      },
    });
    controller.current = owned;
    // 답글 결과가 불명인 재진입은 해당 문의를 다시 열어 사용자가 직접 결과를 확인한다.
    if (uncertain?.kind === "reply" && uncertain.inquiryId) void owned.open(uncertain.inquiryId);
    else void owned.list(0);
    return () => { owned.dispose(); if (controller.current === owned) controller.current = null; };
  }, [active, status, sessionKey, service, isCurrentSession, isActive, owner]);

  return {
    // 비활성 화면은 내용을 숨기되 성공 번호를 0으로 되돌려 작성 중인 초안을 지우지 않는다.
    state: value.owner === owner && active && status === "signedIn" ? value.state
      : withSupportRevisionOffset(emptySupportState(), value.owner.sessionKey === sessionKey ? value.state : emptySupportState()),
    available: active && status === "signedIn" && !!selfId,
    list: (page = 0) => { void controller.current?.list(page); },
    open: (id: string) => { void controller.current?.open(id); },
    backToList: () => { void controller.current?.backToList(); },
    create: (input: SupportCreateInput) => { void controller.current?.create(input); },
    reply: (content: string) => { void controller.current?.reply(content); },
    acknowledgeUncertain: () => controller.current?.acknowledgeUncertain(),
  };
}
