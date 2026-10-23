import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { useAuth } from "@/auth/AuthProvider";
import { useActivityGate } from "@/realtime/useActivity";

import { createUserBlockController, emptyBlockState } from "./controller";
import { createUserBlockService } from "./service";

export function useUserBlocks() {
  const { api, status, sessionKey, user, isCurrentSession } = useAuth();
  const { active, isActive } = useActivityGate();
  const cache = useQueryClient();
  const service = useMemo(() => createUserBlockService(api), [api]);
  const selfId = user?.id ?? null;
  const owner = useMemo(() => ({ service, active, status, sessionKey, selfId }), [service, active, status, sessionKey, selfId]);
  const current = useRef<object | null>(owner);
  const controller = useRef<ReturnType<typeof createUserBlockController> | null>(null);
  const [value, setValue] = useState(() => ({ owner, state: emptyBlockState() }));

  // 계정·화면 소유자가 바뀐 commit부터 이전 응답과 확인 버튼을 무효화한다.
  useLayoutEffect(() => { current.current = owner; return () => { if (current.current === owner) current.current = null; }; }, [owner]);
  useEffect(() => {
    if (!active || status !== "signedIn" || !sessionKey || !selfId) return;
    const isCurrent = () => current.current === owner && isActive() && isCurrentSession(sessionKey);
    const owned = createUserBlockController({ service, selfId, isCurrent,
      onChange: state => { if (isCurrent()) setValue({ owner, state }); },
      onRelationshipsChanged: () => {
        if (!isCurrent()) return;
        for (const prefix of ["friends", "friend-requests", "chat-rooms"]) {
          void cache.invalidateQueries({ queryKey: [prefix, sessionKey] });
        }
      },
    });
    controller.current = owned;
    void owned.load();
    return () => { owned.dispose(); if (controller.current === owned) controller.current = null; };
  }, [active, status, sessionKey, selfId, service, isCurrentSession, isActive, owner, cache]);

  return {
    state: value.owner === owner && active && status === "signedIn" ? value.state : emptyBlockState(),
    available: active && status === "signedIn" && !!selfId,
    reload: () => { void controller.current?.load(); },
    clearCandidate: () => controller.current?.clearCandidate(),
    search: (publicId: string) => { void controller.current?.search(publicId); },
    prepareBlock: () => controller.current?.prepareBlock(),
    prepareUnblock: (userId: string) => controller.current?.prepareUnblock(userId),
    cancel: () => controller.current?.cancel(),
    confirm: () => { void controller.current?.confirm(); },
  };
}

