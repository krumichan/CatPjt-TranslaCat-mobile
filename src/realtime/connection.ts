import { Client, type StompConfig } from "@stomp/stompjs";

import { chatRealtime, roomTopic } from "./destinations.ts";
import { parseRoomEvent, type RoomEvent } from "./events.ts";

export function chatSocketUrl(apiBaseUrl: string): string {
  const url = new URL(apiBaseUrl);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || !/\/api\/v1\/?$/.test(url.pathname)) throw new Error("INVALID_CHAT_SOCKET_URL");
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = url.pathname.replace(/\/api\/v1\/?$/, "") + chatRealtime.path;
  return url.toString();
}

interface ConnectionDependencies {
  createClient?: (configuration: StompConfig) => Client;
  scheduleRetry?: (callback: () => void, delayMs: number) => () => void;
}

function terminalAuthenticationFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  return ("status" in error && [401, 403].includes(Number(error.status)))
    || ("code" in error && ["SESSION_CHANGED", "SIGN_IN_REQUIRED"].includes(String(error.code)));
}

function scheduleRetry(callback: () => void, delayMs: number): () => void {
  const timer = setTimeout(callback, delayMs);
  return () => clearTimeout(timer);
}

export function connectRoom({ apiBaseUrl, roomId, open, accessToken, onEvent, onConnect, onStatus, onInvalidEvent }: {
  apiBaseUrl: string;
  roomId: string;
  open: boolean;
  accessToken: () => Promise<string | null>;
  onEvent: (event: RoomEvent) => void;
  onConnect: () => void;
  onStatus: (status: string) => void;
  onInvalidEvent: (error: unknown) => void;
}, dependencies: ConnectionDependencies = {}): () => void {
  let disposed = false;
  let terminal = false;
  let failures = 0;
  let cancelRetry: (() => void) | null = null;
  const retryLater = dependencies.scheduleRetry ?? scheduleRetry;
  const stop = () => {
    terminal = true;
    cancelRetry?.();
    cancelRetry = null;
    client.connectHeaders = {};
    client.reconnectDelay = 0;
    if (!disposed) onStatus("ERROR");
    void client.deactivate();
  };
  const configuration: StompConfig = {
    brokerURL: chatSocketUrl(apiBaseUrl), reconnectDelay: 3000, connectionTimeout: 10000,
    heartbeatIncoming: 0, heartbeatOutgoing: 10000,
    debug: () => {},
    beforeConnect: async () => {
      if (disposed || terminal) { void client.deactivate(); return; }
      // 재연결마다 현재 세션의 토큰을 받는다. JWT를 URL이나 로그에 넣지 않는다.
      try {
        const token = await accessToken();
        if (disposed || terminal) return;
        if (!token) { stop(); return; }
        client.connectHeaders = { Authorization: `Bearer ${token}` };
        failures = 0;
        onStatus("CONNECTING");
      } catch (error) {
        if (disposed || terminal) return;
        if (terminalAuthenticationFailure(error)) { stop(); return; }
        // 일시적인 refresh·네트워크 실패는 비인증 CONNECT 없이 잠시 멈췄다가 다시 토큰을 받는다.
        // effect가 폐기되거나 계정이 바뀌면 지연 작업도 취소하며, 메시지 POST는 재전송하지 않는다.
        client.connectHeaders = {};
        onStatus("RETRYING");
        const delayMs = Math.min(3000 * 2 ** Math.min(failures++, 4), 30000);
        void client.deactivate().catch(() => {}).then(() => {
          if (disposed || terminal) return;
          cancelRetry?.();
          cancelRetry = retryLater(() => {
            cancelRetry = null;
            if (!disposed && !terminal) client.activate();
          }, delayMs);
        });
      }
    },
    onConnect: () => {
      if (disposed || terminal) return;
      const destinations = [roomTopic(roomId), chatRealtime.readQueue];
      if (open) destinations.push(`/user/queue/chat/open-rooms/${roomId}`);
      for (const destination of destinations) {
        client.subscribe(destination, (frame) => {
          if (disposed || terminal) return;
          try {
            const event = parseRoomEvent(frame.body);
            if (event?.roomId === roomId) onEvent(event);
          } catch (error) {
            onInvalidEvent(error);
          }
        });
      }
      onStatus("CONNECTED");
      onConnect();
    },
    onWebSocketClose: () => { if (!disposed && !terminal) onStatus("DISCONNECTED"); },
    onWebSocketError: () => { if (!disposed && !terminal) onStatus("ERROR"); },
    onStompError: stop,
  };
  const client = dependencies.createClient?.(configuration) ?? new Client(configuration);
  client.activate();
  return () => {
    disposed = true;
    cancelRetry?.();
    cancelRetry = null;
    void client.deactivate();
  };
}
