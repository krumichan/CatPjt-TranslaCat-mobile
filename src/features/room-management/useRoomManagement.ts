import { useEffect, useMemo, useRef, useState } from "react";

import { useAuth } from "@/auth/AuthProvider";
import { runtime } from "@/config/runtime";
import { wireId } from "@/domain/chat/contracts";
import { connectRoom } from "@/realtime/connection";
import { useActivityGate } from "@/realtime/useActivity";

import { createRoomManagementController, emptyRoomManagement } from "./controller";
import { createRoomManagementService } from "./service";

export function useRoomManagement(roomId: string | null) {
  const { api, status, sessionKey, user, isCurrentSession, accessToken } = useAuth();
  const { active, isActive } = useActivityGate();
  const key = `${sessionKey ?? "signed-out"}:${roomId ?? "invalid"}`;
  let valid = roomId !== null;
  try { if (roomId !== null) wireId(roomId); } catch { valid = false; }
  const service = useMemo(() => createRoomManagementService(api), [api]);
  const lifetime = useMemo(() => ({ active, status, key, service, accessToken, isCurrentSession, isActive, user }),
    [active, status, key, service, accessToken, isCurrentSession, isActive, user]);
  const [value, setValue] = useState(() => ({ key, epoch: 0, owner: null as object | null, state: emptyRoomManagement() }));
  const epoch = useRef(0);
  const controller = useRef<ReturnType<typeof createRoomManagementController> | null>(null);

  useEffect(() => {
    if (!valid || !active || status !== "signedIn" || !sessionKey || !roomId || !user) return;
    const ownedEpoch = ++epoch.current;
    const owned = createRoomManagementController(service, roomId, user.id, key,
      () => isActive() && isCurrentSession(sessionKey), state => setValue({ key, epoch: ownedEpoch, owner: lifetime, state }), 15000, {
        connect: handlers => {
          if (!runtime.apiBaseUrl) return () => {};
          return connectRoom({
            ...handlers, apiBaseUrl: runtime.apiBaseUrl, roomId,
            accessToken: async () => {
              // 토큰 조회 전후에 화면·로그인 세대를 확인해 이전 자격으로 연결하지 않는다.
              if (!isActive() || !isCurrentSession(sessionKey)) return null;
              const token = await accessToken();
              return isActive() && isCurrentSession(sessionKey) ? token : null;
            },
          });
        },
      });
    controller.current = owned;
    void owned.load();
    return () => {
      // 이전 계정·방·화면에서 진행되던 관리 응답이 새 화면을 바꾸지 못하게 취소한다.
      owned.dispose();
      if (controller.current === owned) controller.current = null;
    };
  }, [valid, active, status, sessionKey, roomId, user, key, service, isCurrentSession, isActive, accessToken, lifetime]);

  const ownsState = active && status === "signedIn" && value.key === key && value.owner === lifetime;
  // 같은 방으로 돌아오는 첫 렌더부터 이전 controller의 역할·차단 목록을 숨긴다.
  return { state: !valid ? { ...emptyRoomManagement(), loading: false, error: "대화방 링크를 확인해 주세요." }
    : ownsState ? value.state : emptyRoomManagement(), epoch: ownsState ? value.epoch : 0, controller, active, isActive };
}
