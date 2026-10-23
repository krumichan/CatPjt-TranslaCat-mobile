import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { AppState } from "react-native";

import { useAuth } from "@/auth/AuthProvider";
import { runtime } from "@/config/runtime";
import { connectInvitationFeed } from "@/realtime/invitation-feed";
import { publishAttentionChange } from "@/notifications/attention-changes";

import { invitationKeys } from "./queries";

export function useOpenInvitationSync() {
  const { sessionKey, status, isCurrentSession, accessToken } = useAuth();
  const client = useQueryClient();
  useEffect(() => {
    if (status !== "signedIn" || !sessionKey || !runtime.apiBaseUrl) return;
    let disposed = false;
    let stop: (() => void) | null = null;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const current = () => !disposed && AppState.currentState === "active" && isCurrentSession(sessionKey);
    const refresh = () => {
      if (!current() || debounce !== null) return;
      // 연속 이벤트를 REST 한 번으로 합치고, 캐시에 이벤트 payload의 개인 정보를 직접 쓰지 않는다.
      debounce = setTimeout(() => {
        debounce = null;
        if (current()) {
          void client.invalidateQueries({ queryKey: invitationKeys.root(sessionKey) });
          publishAttentionChange({ sessionKey });
        }
      }, 150);
    };
    const connect = () => {
      if (!current() || stop) return;
      refresh();
      stop = connectInvitationFeed({ apiBaseUrl: runtime.apiBaseUrl!, isCurrent: current, refresh,
        onRead: readRoom => { if (current()) publishAttentionChange({ sessionKey, readRoom }); },
        accessToken: async () => {
          if (!current()) return null;
          const token = await accessToken();
          return current() ? token : null;
        } });
    };
    connect();
    const subscription = AppState.addEventListener("change", state => {
      if (state === "active") connect();
      else { stop?.(); stop = null; if (debounce !== null) { clearTimeout(debounce); debounce = null; } }
    });
    return () => { disposed = true; stop?.(); subscription.remove(); if (debounce !== null) clearTimeout(debounce); };
  }, [accessToken, isCurrentSession, sessionKey, status, client]);
}
