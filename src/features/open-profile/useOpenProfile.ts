import { useQueryClient } from "@tanstack/react-query";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { useAuth } from "@/auth/AuthProvider";
import { wireId } from "@/domain/chat/contracts";
import { useActivityGate } from "@/realtime/useActivity";

import { createOpenProfileController, emptyOpenProfileState } from "./controller";
import { pickProfileImage } from "./native-image-picker";
import { createOpenProfileService } from "./service";

export function useOpenProfile(roomId: string) {
  const { api, sessionKey, status, isCurrentSession } = useAuth();
  const { active, isActive } = useActivityGate();
  const cache = useQueryClient();
  let valid = true;
  try { wireId(roomId); } catch { valid = false; }
  const service = useMemo(() => createOpenProfileService(api), [api]);
  const owner = useMemo(() => ({ service, roomId, sessionKey, status, valid }), [service, roomId, sessionKey, status, valid]);
  const current = useRef<object | null>(owner);
  const focused = useRef(false);
  const controller = useRef<ReturnType<typeof createOpenProfileController> | null>(null);
  const [value, setValue] = useState(() => ({ owner, state: emptyOpenProfileState() }));

  useLayoutEffect(() => {
    current.current = owner;
    return () => { if (current.current === owner) current.current = null; };
  }, [owner]);

  useFocusEffect(useCallback(() => {
    focused.current = true;
    if (!valid || status !== "signedIn" || !sessionKey) return () => { focused.current = false; };
    const isCurrent = () => current.current === owner && focused.current && isCurrentSession(sessionKey);
    const owned = createOpenProfileController({ roomId, service, isCurrent, isActive, pickImage: pickProfileImage,
      onChange: state => { if (isCurrent()) setValue({ owner, state }); },
      onSaved: () => {
        if (!isCurrent()) return;
        void cache.invalidateQueries({ queryKey: ["chat-rooms", sessionKey] });
        void cache.invalidateQueries({ queryKey: ["open-chat-rooms", sessionKey] });
      },
    });
    controller.current = owned;
    void owned.load();
    return () => {
      focused.current = false;
      owned.dispose();
      if (controller.current === owned) controller.current = null;
    };
  }, [valid, status, sessionKey, owner, roomId, service, isCurrentSession, isActive, cache]));

  // OS 사진 선택기 동안 controller를 재생성하지 않아 선택 결과와 기존 사진을 보존한다.
  useEffect(() => {
    if (active) void controller.current?.load();
    else controller.current?.suspend();
  }, [active, owner]);

  return {
    state: value.owner === owner && status === "signedIn" ? value.state : emptyOpenProfileState(),
    valid, available: active && valid && status === "signedIn",
    reload: () => { void controller.current?.load(); },
    choose: () => { void controller.current?.choose(); },
    save: () => { void controller.current?.save(); },
    remove: (memberId: string, imageUrl: string | null) => { void controller.current?.remove(memberId, imageUrl); },
    clearDraft: () => controller.current?.clearDraft(),
    acknowledge: () => controller.current?.acknowledge(),
  };
}
