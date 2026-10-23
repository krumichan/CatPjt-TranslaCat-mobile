import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as Notifications from "expo-notifications";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AppState, Platform } from "react-native";

import { useAuth } from "@/auth/AuthProvider";
import { compareIds } from "@/domain/chat/timeline";
import { invitationKeys } from "@/features/open-invitations/queries";
import { attentionKey, createAttentionService } from "@/notifications/attention-service";
import { subscribeAttentionChanges, type AttentionChange } from "@/notifications/attention-changes";
import { NotificationBadge, matchesPresentedNotificationProof, presentedNotificationProof, shouldDismissReadNotification,
  type PresentedNotificationProof } from "@/notifications/badge";
import { parseNotification } from "@/notifications/intent";

export function useNotificationAttention(registration: { sessionKey: string | null; accountBindingId: string | null }) {
  const auth = useAuth();
  const { isCurrentSession } = auth;
  const client = useQueryClient();
  const [active, setActive] = useState(AppState.currentState === "active");
  const [badge] = useState(() => new NotificationBadge(value => Platform.OS === "web"
    ? Promise.resolve(false) : Notifications.setBadgeCountAsync(value)));
  const service = useMemo(() => createAttentionService(auth.api), [auth.api]);
  const sessionKey = auth.status === "signedIn" ? auth.sessionKey : null;
  const owner = useRef({ sessionKey, registration, isCurrent: auth.isCurrentSession });
  const readRooms = useRef(new Map<string, string>());
  const readInvitations = useRef(new Set<string>());
  const revision = useRef(0);
  const freshSince = useRef(0);
  const summary = useQuery({ queryKey: attentionKey(sessionKey), queryFn: async ({ signal }) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let presentedBeforeSummary: PresentedNotificationProof[] = [];
    // 알림함 열거가 멈춰도 REST 집계를 막지 않는다. 시점 증명이 없으면 전체 삭제를 생략한다.
    try {
      if (Platform.OS !== "web") {
        presentedBeforeSummary = await Promise.race([
          Notifications.getPresentedNotificationsAsync().then(items => items.flatMap(item => {
            const proof = presentedNotificationProof(item.request.identifier, item.request.content.data);
            return proof ? [proof] : [];
          })).catch(() => []),
          new Promise<PresentedNotificationProof[]>(resolve => { timer = setTimeout(() => resolve([]), 1000); }),
        ]);
      }
    } finally { if (timer) clearTimeout(timer); }
    return { ...await service.summary(signal), presentedBeforeSummary };
  },
    enabled: active && !!sessionKey, retry: false, staleTime: 0, refetchInterval: active ? 30000 : false });

  useLayoutEffect(() => {
    owner.current = { sessionKey, registration, isCurrent: auth.isCurrentSession };
  }, [auth.isCurrentSession, registration, sessionKey]);

  const refresh = useCallback(() => {
    const key = owner.current.sessionKey;
    if (!key || !owner.current.isCurrent(key) || AppState.currentState !== "active") return;
    revision.current++;
    freshSince.current = Date.now();
    // 읽음 직전 시작한 첫 요약 조회도 취소한다. 오래된 응답으로 배지가 다시 증가하지 않는다.
    void client.cancelQueries({ queryKey: attentionKey(key) }).then(() => {
      if (owner.current.sessionKey !== key || !owner.current.isCurrent(key)) return;
      void client.invalidateQueries({ queryKey: attentionKey(key) });
      void client.invalidateQueries({ queryKey: ["chat-rooms", key] });
      void client.invalidateQueries({ queryKey: invitationKeys.root(key) });
    });
  }, [client]);

  const cleanReadNotifications = useCallback(async (zeroReadProof?: readonly PresentedNotificationProof[]) => {
    const captured = owner.current;
    const key = captured.sessionKey;
    const capturedRevision = revision.current;
    const binding = captured.registration.sessionKey === key ? captured.registration.accountBindingId : null;
    const current = () => !!key && owner.current.sessionKey === key && owner.current.isCurrent(key)
      && owner.current.registration.sessionKey === key && owner.current.registration.accountBindingId === binding
      && (!zeroReadProof || revision.current === capturedRevision)
      && AppState.currentState === "active";
    if (Platform.OS === "web" || !binding || !current()) return;
    try {
      const presented = await Notifications.getPresentedNotificationsAsync();
      for (const notification of presented) {
        if (!current()) return;
        const data = notification.request.content.data;
        const intent = parseNotification(data);
        if (!intent || intent.accountBindingId !== binding) continue;
        const cursor = readRooms.current.get(intent.roomId);
        if ((zeroReadProof && matchesPresentedNotificationProof(notification.request.identifier, data, zeroReadProof, binding))
          || shouldDismissReadNotification({ data, accountBindingId: binding,
          readRoomCursor: cursor ? { roomId: intent.roomId, lastReadMessageId: cursor } : undefined,
          readInvitationIds: Array.from(readInvitations.current) })) {
          await Notifications.dismissNotificationAsync(notification.request.identifier);
        }
      }
    } catch { /* 지원하지 않는 런처와 OS 알림함 오류는 대화·읽음 저장을 막지 않는다. */ }
  }, []);

  useEffect(() => {
    readRooms.current.clear();
    readInvitations.current.clear();
    freshSince.current = Date.now();
    badge.setSession(sessionKey ? { sessionKey, isCurrent: () => isCurrentSession(sessionKey) } : null);
    return () => { badge.setSession(null); };
  }, [isCurrentSession, badge, sessionKey]);

  useEffect(() => {
    if (!active || !sessionKey || !summary.data || summary.isFetching
      || summary.dataUpdatedAt < freshSince.current || !isCurrentSession(sessionKey)) return;
    badge.setCount(sessionKey, summary.data.totalAttentionCount);
    void cleanReadNotifications(summary.data.totalAttentionCount === 0 ? summary.data.presentedBeforeSummary : undefined);
  }, [active, isCurrentSession, badge, cleanReadNotifications, sessionKey, summary.data, summary.dataUpdatedAt, summary.isFetching]);

  useEffect(() => {
    const changed = (change: AttentionChange) => {
      if (change.sessionKey !== owner.current.sessionKey || !owner.current.isCurrent(change.sessionKey)) return;
      if (change.readRoom) {
        const old = readRooms.current.get(change.readRoom.roomId);
        if (!old || compareIds(change.readRoom.lastReadMessageId, old) > 0) {
          readRooms.current.set(change.readRoom.roomId, change.readRoom.lastReadMessageId);
        }
      }
      if (change.readInvitationId) readInvitations.current.add(change.readInvitationId);
      refresh();
      void cleanReadNotifications();
    };
    const stop = subscribeAttentionChanges(changed);
    const activity = AppState.addEventListener("change", state => {
      setActive(state === "active");
      if (state === "active") { badge.retry(); refresh(); }
    });
    const received = Platform.OS === "web" ? null : Notifications.addNotificationReceivedListener(notification => {
      const current = owner.current;
      const intent = parseNotification(notification.request.content.data);
      if (intent && current.registration.sessionKey === current.sessionKey
        && intent.accountBindingId === current.registration.accountBindingId) {
        refresh(); void cleanReadNotifications();
      }
    });
    return () => { stop(); activity.remove(); received?.remove(); };
  }, [badge, cleanReadNotifications, refresh]);

  return { refresh, count: sessionKey && summary.data ? summary.data.totalAttentionCount : null };
}
