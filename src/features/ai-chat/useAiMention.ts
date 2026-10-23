import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";

import { ApiError } from "@/api/client";
import { useAuth } from "@/auth/AuthProvider";
import { wireId } from "@/domain/chat/contracts";
import { useActivityGate } from "@/realtime/useActivity";

import { visibleAiProfile } from "./access";
import { createAiService } from "./service";

export function useAiMention(roomId: string, setDraft: Dispatch<SetStateAction<string>>) {
  const auth = useAuth();
  const { status, sessionKey, isCurrentSession } = auth;
  const router = useRouter();
  const { active, isActive } = useActivityGate();
  const { aiMention } = useLocalSearchParams<{ aiMention?: string | string[] }>();
  const service = useMemo(() => createAiService(auth.api), [auth.api]);
  const key = `${sessionKey}:${roomId}`;
  const [notice, setNotice] = useState<{ key: string; text: string } | null>(null);

  useEffect(() => {
    if (!active || !aiMention || status !== "signedIn" || !sessionKey) return;
    const abort = new AbortController();
    let alive = true;
    const current = () => alive && isActive() && isCurrentSession(sessionKey);
    const prepare = async () => {
      if (!current()) return;
      try {
        // URL에는 숫자 member ID만 받고 닉네임·권한은 현재 계정의 REST 응답으로 다시 확인한다.
        if (typeof aiMention !== "string") throw new ApiError(400, "INVALID_AI_MEMBER");
        wireId(roomId);
        wireId(aiMention);
        const value = await visibleAiProfile(service, roomId, aiMention, abort.signal);
        if (!current()) return;
        if (!value.canMention) throw new ApiError(403, "AI_MENTION_NOT_ALLOWED");
        setDraft(draft => draft.trim() ? draft : `@${value.profile.nickname} `);
        setNotice({ key, text: `@${value.profile.nickname}와 함께 메시지를 보내면 AI를 부를 수 있어요. 작성 중인 내용은 그대로 유지해요.` });
      } catch {
        if (current()) setNotice({ key, text: "AI를 부를 권한이나 현재 프로필을 확인하지 못했어요. 방 설정을 확인해 주세요." });
      } finally {
        if (current()) router.setParams({ aiMention: undefined });
      }
    };
    void prepare();
    return () => { alive = false; abort.abort(); };
  }, [active, aiMention, status, sessionKey, isCurrentSession, isActive, key, roomId, router, service, setDraft]);

  return notice?.key === key ? notice.text : null;
}
