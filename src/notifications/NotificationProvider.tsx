import * as Notifications from "expo-notifications";
import { useRouter } from "expo-router";
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { AppState, Linking, Platform } from "react-native";

import { createApiClient } from "@/api/client";
import { useAuth } from "@/auth/AuthProvider";
import { runtime } from "@/config/runtime";
import { createChatService } from "@/features/chat/service";
import { createOpenInvitationService } from "@/features/open-invitations/service";
import { useOpenInvitationSync } from "@/features/open-invitations/useOpenInvitationSync";
import { subscribeNotificationPreferenceChanges } from "@/features/notification-preferences/changes";
import { NotificationIntake } from "@/notifications/intake";
import { PushLifecycle } from "@/notifications/lifecycle";
import { acquireNativePushToken, createNativeInstallation } from "@/notifications/native-device";
import { isFreshNotificationPreference, shouldPresentNotification } from "@/notifications/presentation";
import { createPushRegistry, type PushConfiguration } from "@/notifications/registry";
import { NotificationResponses, verifyNotificationRoom, type NotificationTapState } from "@/notifications/response";
import { parseNotification } from "@/notifications/intent";
import { useNotificationAttention } from "@/notifications/useNotificationAttention";

type NotificationContextValue = {
  status: ReturnType<PushLifecycle["getSnapshot"]>["status"];
  tapState: NotificationTapState;
  attentionCount: number | null;
  enable(): Promise<void>;
  retry(): Promise<void>;
  openSettings(): Promise<void>;
};
const NotificationContext = createContext<NotificationContextValue | null>(null);

function configuration(): PushConfiguration | null {
  if ((Platform.OS !== "android" && Platform.OS !== "ios") || !runtime.projectId) return null;
  return { platform: Platform.OS, appEnvironment: runtime.environment, projectId: runtime.projectId };
}

export function NotificationProvider({ children }: { children: ReactNode }) {
  const auth = useAuth();
  useOpenInvitationSync();
  const router = useRouter();
  const [lifecycle] = useState(() => new PushLifecycle(createNativeInstallation(), acquireNativePushToken));
  const snapshot = useSyncExternalStore(lifecycle.subscribe, lifecycle.getSnapshot, lifecycle.getSnapshot);
  const { count: attentionCount, refresh: refreshAttention } = useNotificationAttention(snapshot);
  const [tapState, setTapState] = useState<NotificationTapState>("idle");
  const currentAuth = useRef(auth);
  useLayoutEffect(() => { currentAuth.current = auth; }, [auth]);
  const preferences = useRef<{ sessionKey: string | null; global: { value: boolean; at: number } | null;
    muted: Map<string, { value: boolean; at: number }> }>({
    sessionKey: null, global: null, muted: new Map(),
  });
  const [responses] = useState(() => new NotificationResponses(roomId => {
    router.push({ pathname: "/chat/[roomId]", params: { roomId } });
  }, setTapState, Date.now, notificationId => {
    router.push({ pathname: "/invitations", params: { notificationId } });
  }));
  const config = useMemo(() => configuration(), []);
  const registry = useMemo(() => config ? createPushRegistry(auth.api, config) : null, [auth.api, config]);
  const registerSessionRelease = auth.registerSessionRelease;

  useLayoutEffect(() => {
    preferences.current = { sessionKey: auth.sessionKey, global: null, muted: new Map() };
  }, [auth.sessionKey]);

  useEffect(() => subscribeNotificationPreferenceChanges(change => {
    if (!currentAuth.current.isCurrentSession(change.sessionKey) || preferences.current.sessionKey !== change.sessionKey) return;
    const confirmed = { value: change.value, at: Date.now() };
    if (change.scope.kind === "global") preferences.current.global = confirmed;
    else preferences.current.muted.set(change.scope.roomId, confirmed);
  }), []);

  useEffect(() => {
    const session = auth.status === "signedIn" && auth.sessionKey && registry
      ? { sessionKey: auth.sessionKey, registry } : null;
    void lifecycle.setSession(session);
  }, [auth.sessionKey, auth.status, lifecycle, registry]);

  useEffect(() => registerSessionRelease(async (accessToken, sessionKey) => {
    if (!config) return;
    // 이 client는 로그아웃 직전 캡처한 자격만 사용한다. 새 계정의 토큰을 다시 읽지 않는다.
    const capturedApi = createApiClient({ baseUrl: runtime.apiBaseUrl, accessToken: async () => accessToken });
    await lifecycle.disableSession(sessionKey, createPushRegistry(capturedApi, config));
  }), [config, lifecycle, registerSessionRelease]);

  useEffect(() => {
    const sessionKey = auth.sessionKey;
    if (auth.status !== "signedIn" || !sessionKey) { responses.setSession(null); return; }
    const service = createChatService(auth.api);
    const invitations = createOpenInvitationService(auth.api);
    const accountBindingId = snapshot.sessionKey === sessionKey ? snapshot.accountBindingId : null;
    responses.setSession({
      sessionKey,
      accountBindingId,
      isCurrent: () => {
        const registered = lifecycle.getSnapshot();
        return currentAuth.current.isCurrentSession(sessionKey) && registered.sessionKey === sessionKey
          && registered.accountBindingId === accountBindingId;
      },
      verifyRoom: roomId => verifyNotificationRoom(async signal => {
        const room = await service.room(roomId, signal);
        if (!room.active) return false;
        if (room.roomType === "OPEN") await service.myOpenProfile(roomId, signal);
        return currentAuth.current.isCurrentSession(sessionKey);
      }),
      verifyInvitation: (notificationId, roomId) => verifyNotificationRoom(async signal => {
        const invitation = await invitations.detail(notificationId, signal);
        return invitation.roomId === roomId && currentAuth.current.isCurrentSession(sessionKey);
      }),
    });
  }, [auth.api, auth.sessionKey, auth.status, lifecycle, responses, snapshot.accountBindingId, snapshot.sessionKey]);

  useEffect(() => {
    // 앱 비활성화와 unmount는 진행 중 탐색을 막는다. StrictMode 재설정은 같은 보류 알림을 복구할 수 있다.
    responses.setActive(AppState.currentState === "active");
    const activity = AppState.addEventListener("change", state => {
      const active = state === "active";
      responses.setActive(active);
      if (active) void lifecycle.sync();
    });
    return () => { responses.setActive(false); activity.remove(); };
  }, [lifecycle, responses]);

  useEffect(() => {
    if (Platform.OS === "web") return;
    const intake = new NotificationIntake(data => responses.receive(data));
    // SDK 기본 표시는 켜져 있다. 여기서는 payload와 현재 계정 binding이 맞는 알림만 명시적으로 허용한다.
    Notifications.setNotificationHandler({
      handleNotification: async notification => {
        const current = currentAuth.current;
        const registered = lifecycle.getSnapshot();
        const intent = parseNotification(notification.request.content.data);
        const preference = preferences.current.sessionKey === current.sessionKey ? preferences.current : null;
        const global = preference?.global;
        const room = intent?.schemaVersion === 1 ? preference?.muted.get(intent.roomId) : null;
        const show = shouldPresentNotification({
          data: notification.request.content.data, title: notification.request.content.title,
          trigger: notification.request.trigger, development: __DEV__, signedIn: current.isCurrentSession(current.sessionKey),
          sessionKey: current.sessionKey, registeredSessionKey: registered.sessionKey, accountBindingId: registered.accountBindingId,
          pushEnabled: global && isFreshNotificationPreference(global.at) ? global.value : undefined,
          muted: room && isFreshNotificationPreference(room.at) ? room.value : undefined,
        });
        return {
          shouldPlaySound: show, shouldSetBadge: false,
          shouldShowBanner: show, shouldShowList: show,
        };
      },
    });
    const subscription = Notifications.addNotificationResponseReceivedListener(response => {
      if (intake.live(response.notification.request.content.data)) Notifications.clearLastNotificationResponse();
    });
    // cold start는 인증 복원과 registration 완료를 기다린 뒤 동일한 검증 경로로 처리한다.
    void Notifications.getLastNotificationResponseAsync().then(response => {
      if (response && intake.cold(response.notification.request.content.data)) Notifications.clearLastNotificationResponse();
    }).catch(() => {});
    const rotation = Notifications.addPushTokenListener(nativeToken => { void lifecycle.sync(false, nativeToken); });
    return () => {
      intake.stop();
      subscription.remove(); rotation.remove();
      Notifications.setNotificationHandler(null);
    };
  }, [lifecycle, responses]);

  const value = useMemo<NotificationContextValue>(() => ({
    status: auth.status === "signedIn" && snapshot.sessionKey === auth.sessionKey ? snapshot.status : "signed-out",
    tapState,
    attentionCount,
    enable: () => lifecycle.sync(true),
    retry: async () => { refreshAttention(); await lifecycle.sync(); await responses.retry(); },
    openSettings: async () => { try { await Linking.openSettings(); } catch { /* 상태에 원문 오류를 반사하지 않는다. */ } },
  }), [attentionCount, refreshAttention, auth.sessionKey, auth.status, lifecycle, responses, snapshot.sessionKey, snapshot.status, tapState]);

  return <NotificationContext.Provider value={value}>{children}</NotificationContext.Provider>;
}

export function useNotifications() {
  const value = useContext(NotificationContext);
  if (!value) throw new Error("NOTIFICATION_PROVIDER_REQUIRED");
  return value;
}
