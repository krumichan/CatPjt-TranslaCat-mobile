import { Client, type StompConfig } from "@stomp/stompjs";

import { chatSocketUrl } from "./connection.ts";
import { chatRealtime } from "./destinations.ts";
import { parseRoomEvent } from "./events.ts";

export function isInvitationRefresh(body: string) {
  if (body.length > 262144) return false;
  try {
    const event = JSON.parse(body) as { eventType?: unknown };
    // user queue의 신뢰된 이벤트도 데이터로 사용하지 않고, 수신 계정 전용 REST를 무효화하는 신호로만 쓴다.
    return event?.eventType === "chat.notification.created";
  } catch { return false; }
}

export function connectInvitationFeed(input: {
  apiBaseUrl: string;
  accessToken(): Promise<string | null>;
  isCurrent(): boolean;
  refresh(): void;
  onRead?(cursor: { roomId: string; lastReadMessageId: string }): void;
}, dependencies: { createClient?: (config: StompConfig) => Client;
  schedule?: (callback: () => void, delay: number) => () => void } = {}) {
  let disposed = false;
  let terminal = false;
  let failures = 0;
  let cancelRetry: (() => void) | null = null;
  const current = () => !disposed && !terminal && input.isCurrent();
  const later = dependencies.schedule ?? ((callback, delay) => { const timer = setTimeout(callback, delay); return () => clearTimeout(timer); });
  const stop = () => {
    terminal = true;
    cancelRetry?.();
    client.connectHeaders = {};
    client.reconnectDelay = 0;
    void client.deactivate();
  };
  const configuration: StompConfig = {
    brokerURL: chatSocketUrl(input.apiBaseUrl), reconnectDelay: 3000, connectionTimeout: 10000,
    heartbeatIncoming: 0, heartbeatOutgoing: 10000, debug: () => {},
    beforeConnect: async () => {
      if (!current()) { stop(); return; }
      try {
        const token = await input.accessToken();
        if (!current()) { stop(); return; }
        if (!token) { stop(); return; }
        client.connectHeaders = { Authorization: `Bearer ${token}` };
        failures = 0;
      } catch (error) {
        if (!current()) { stop(); return; }
        const code = error && typeof error === "object" && "code" in error ? error.code : null;
        const status = error && typeof error === "object" && "status" in error ? error.status : null;
        if ([401, 403].includes(Number(status)) || ["SESSION_CHANGED", "SIGN_IN_REQUIRED"].includes(String(code))) { stop(); return; }
        client.connectHeaders = {};
        // 갱신 일시 실패는 비인증 연결을 보내지 않고 backoff 뒤 현재 계정 자격을 다시 확인한다.
        const delay = Math.min(3000 * 2 ** Math.min(failures++, 4), 30000);
        void client.deactivate().catch(() => {}).then(() => {
          if (!current()) return;
          cancelRetry?.();
          cancelRetry = later(() => { cancelRetry = null; if (current()) client.activate(); }, delay);
        });
      }
    },
    onConnect: () => {
      if (!current()) return;
      client.subscribe(chatRealtime.notificationQueue, frame => { if (current() && isInvitationRefresh(frame.body)) input.refresh(); });
      client.subscribe(chatRealtime.readQueue, frame => {
        if (!current() || frame.body.length > 262144) return;
        try {
          const event = parseRoomEvent(frame.body);
          if (event?.kind === "read" && event.last) {
            input.onRead?.({ roomId: event.roomId, lastReadMessageId: event.last });
            input.refresh();
          }
        } catch { /* 실시간 입력은 집계에 직접 더하거나 빼지 않는다. */ }
      });
      input.refresh();
    },
    onStompError: stop,
  };
  const client = dependencies.createClient?.(configuration) ?? new Client(configuration);
  client.activate();
  return () => { disposed = true; cancelRetry?.(); client.connectHeaders = {}; void client.deactivate(); };
}
