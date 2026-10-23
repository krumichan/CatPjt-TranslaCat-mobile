import { useEffect, useMemo, useRef, useState } from "react";

import { useAuth } from "@/auth/AuthProvider";
import { runtime } from "@/config/runtime";
import { connectRoom } from "@/realtime/connection";
import { useActivityGate } from "@/realtime/useActivity";

import { createAiRoomController, emptyAiRoom } from "./controller";
import { createAiService } from "./service";

export function useAiRoom(roomId: string | null) {
  const auth = useAuth();
  const { status, sessionKey, isCurrentSession, accessToken } = auth;
  const { active, isActive } = useActivityGate();
  const key = `${sessionKey ?? "signed-out"}:${roomId ?? "invalid"}`;
  const service = useMemo(() => createAiService(auth.api), [auth.api]);
  const lifetime = useMemo(() => ({ active, status, key, service, accessToken, isCurrentSession, isActive }),
    [active, status, key, service, accessToken, isCurrentSession, isActive]);
  type Controller = ReturnType<typeof createAiRoomController>;
  const [value, setValue] = useState<{ key: string; state: ReturnType<typeof emptyAiRoom>; owner: object | null }>(
    () => ({ key, state: emptyAiRoom(), owner: null }));
  const controller = useRef<Controller | null>(null);

  useEffect(() => {
    if (!active || status !== "signedIn" || !roomId || !sessionKey) return;
    const owned = createAiRoomController(service, roomId, key,
      () => isActive() && isCurrentSession(sessionKey),
      state => setValue({ key, state, owner: lifetime }), {
        connect: handlers => {
          if (!runtime.apiBaseUrl) return () => {};
          return connectRoom({
            ...handlers, apiBaseUrl: runtime.apiBaseUrl, roomId,
            accessToken: async () => {
              // 토큰 조회 전후에 화면·로그인 세대를 확인해 이전 계정으로 연결하지 않는다.
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
      // 화면 이탈·백그라운드·계정 변경 시 요청을 취소하고 늦은 persona 응답을 버린다.
      owned.dispose();
      if (controller.current === owned) controller.current = null;
    };
  }, [active, status, sessionKey, isCurrentSession, isActive, key, roomId, service, accessToken, lifetime]);

  // 같은 방으로 복귀하는 첫 렌더에서도 이전 controller의 persona·권한 캐시를 노출하지 않는다.
  return { state: active && status === "signedIn" && value.key === key && value.owner === lifetime
    ? value.state : emptyAiRoom(), controller, active, isActive };
}
