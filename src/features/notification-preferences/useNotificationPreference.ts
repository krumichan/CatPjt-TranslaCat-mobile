import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { useAuth } from "@/auth/AuthProvider";
import { useActivityGate } from "@/realtime/useActivity";

import { publishNotificationPreferenceChange } from "./changes";
import { createNotificationPreferenceController, emptyNotificationPreference } from "./controller";
import { createNotificationPreferenceService } from "./service";

export function useNotificationPreference(roomId?: string, enabled = true) {
  const { api, status, sessionKey, isCurrentSession } = useAuth();
  const { active, isActive } = useActivityGate();
  const service = useMemo(() => createNotificationPreferenceService(api), [api]);
  const owner = useMemo(() => ({ service, roomId, enabled, active, status, sessionKey }), [service, roomId, enabled, active, status, sessionKey]);
  const current = useRef<object | null>(owner);
  const controller = useRef<ReturnType<typeof createNotificationPreferenceController> | null>(null);
  const [value, setValue] = useState(() => ({ owner, state: emptyNotificationPreference() }));

  // 새 계정·방 렌더가 commit되면 이전 effect의 응답을 즉시 무효화한다.
  useLayoutEffect(() => { current.current = owner; return () => { if (current.current === owner) current.current = null; }; }, [owner]);
  useEffect(() => {
    if (!enabled || !active || status !== "signedIn" || !sessionKey) return;
    const isCurrent = () => current.current === owner && isActive() && isCurrentSession(sessionKey);
    const owned = createNotificationPreferenceController({
      read: async signal => roomId ? (await service.room(roomId, signal)).muted : (await service.global(signal)).pushEnabled,
      write: async (next, signal) => roomId ? (await service.setRoom(roomId, next, signal)).muted : (await service.setGlobal(next, signal)).pushEnabled,
      isCurrent,
      onChange: state => { if (isCurrent()) setValue({ owner, state }); },
      onConfirmed: confirmed => {
        if (isCurrent()) publishNotificationPreferenceChange({ sessionKey, scope: roomId ? { kind: "room", roomId } : { kind: "global" }, value: confirmed });
      },
    });
    controller.current = owned;
    void owned.load();
    return () => { owned.dispose(); if (controller.current === owned) controller.current = null; };
  }, [enabled, active, status, sessionKey, roomId, service, isCurrentSession, isActive, owner]);

  return {
    state: value.owner === owner && enabled && active && status === "signedIn" ? value.state : emptyNotificationPreference(),
    available: enabled && active && status === "signedIn",
    reload: () => { void controller.current?.load(); },
    setValue: (next: boolean) => { void controller.current?.setValue(next); },
  };
}
