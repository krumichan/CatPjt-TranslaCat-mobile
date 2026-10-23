import { useEffect, useMemo, useSyncExternalStore } from "react";

import { useAuth } from "@/auth/AuthProvider";
import { runtime } from "@/config/runtime";
import { connectRoom } from "@/realtime/connection";
import { useActivityGate } from "@/realtime/useActivity";
import { publishAttentionChange } from "@/notifications/attention-changes";

import { createRoomChatController } from "./controller";
import { createChatService } from "./service";

export function useRoomChat(roomId: string | null) {
  const auth = useAuth();
  const { active, isActive } = useActivityGate();
  const { api, sessionKey, isCurrentSession, accessToken } = auth;
  const service = useMemo(() => {
    const chat = createChatService(api);
    return { ...chat, read: async (...args: Parameters<typeof chat.read>) => {
      const result = await chat.read(...args);
      if (sessionKey && isActive() && isCurrentSession(sessionKey) && result.lastReadMessageId) {
        publishAttentionChange({ sessionKey, readRoom: { roomId: args[0], lastReadMessageId: result.lastReadMessageId } });
      }
      return result;
    } };
  }, [api, isActive, isCurrentSession, sessionKey]);
  const controller = useMemo(() => createRoomChatController({
    key: `${sessionKey ?? "signed-out"}:${roomId ?? "invalid"}`,
    roomId: roomId ?? "", service, isActive,
    isCurrent: () => isCurrentSession(sessionKey),
    connect: handlers => {
      if (!runtime.apiBaseUrl || !roomId) return () => {};
      return connectRoom({
        ...handlers, apiBaseUrl: runtime.apiBaseUrl, roomId,
        accessToken: async () => {
          if (!isActive() || !isCurrentSession(sessionKey)) return null;
          const token = await accessToken();
          return isActive() && isCurrentSession(sessionKey) ? token : null;
        },
      });
    },
  }), [accessToken, isActive, isCurrentSession, roomId, service, sessionKey]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);

  // 같은 방의 배경 전환은 기록을 보존하고, 다른 계정·방은 별도 controller로 격리한다.
  useEffect(() => {
    if (active && auth.status === "signedIn") controller.start();
    return controller.stop;
  }, [active, auth.status, controller]);

  return { ...controller, state, active };
}
