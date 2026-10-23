import type { InstallationIdentity } from "./installation.ts";
import type { PushRegistry } from "./registry.ts";

export type PushStatus = "signed-out" | "unavailable" | "permission-required" | "permission-blocked" | "syncing" | "connected" | "retry";
export type PushSnapshot = { status: PushStatus; sessionKey: string | null; accountBindingId: string | null };
export type PushSession = { sessionKey: string; registry: PushRegistry };
export type DevicePushResult = { status: "ready"; token: string } | { status: "unavailable" | "permission-required" | "permission-blocked" };

export class PushLifecycle {
  private current: PushSession | null = null;
  private epoch = 0;
  private queue: Promise<void> = Promise.resolve();
  private snapshot: PushSnapshot = { status: "signed-out", sessionKey: null, accountBindingId: null };
  private listeners = new Set<() => void>();
  private identity: InstallationIdentity;
  private acquire: (askPermission: boolean, nativeToken?: unknown) => Promise<DevicePushResult>;

  constructor(identity: InstallationIdentity, acquire: (askPermission: boolean, nativeToken?: unknown) => Promise<DevicePushResult>) {
    this.identity = identity;
    this.acquire = acquire;
  }

  getSnapshot = (): PushSnapshot => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };

  private publish(status: PushStatus, accountBindingId: string | null = null) {
    this.snapshot = { status, sessionKey: this.current?.sessionKey ?? null, accountBindingId };
    for (const listener of this.listeners) listener();
  }

  private enqueue(operation: () => Promise<void>) {
    const next = this.queue.then(operation);
    this.queue = next.catch(() => {});
    return next;
  }

  setSession(session: PushSession | null): Promise<void> {
    if (session === null && this.current === null) return Promise.resolve();
    // 늦은 저장·SDK·서버 응답은 publish 전에 같은 session 객체와 세대인지 다시 확인한다.
    this.current = session;
    ++this.epoch;
    this.publish(session ? "syncing" : "signed-out");
    return session ? this.sync() : Promise.resolve();
  }

  sync(askPermission = false, nativeToken?: unknown): Promise<void> {
    const session = this.current;
    const epoch = this.epoch;
    const active = () => session !== null && session === this.current && epoch === this.epoch;
    return this.enqueue(async () => {
      if (!session || !active()) return;
      const previousBinding = this.snapshot.accountBindingId;
      this.publish("syncing", previousBinding);
      try {
        const device = await this.acquire(askPermission, nativeToken);
        if (!active()) return;
        if (device.status === "unavailable") { this.publish("unavailable"); return; }
        if (device.status !== "ready") {
          // 권한 상태는 서버가 잠시 불통이어도 표시한다. 다음 resume·명시 재시도가 같은 정리를 다시 시도한다.
          this.publish(device.status);
          try {
            const installation = await this.identity.next();
            if (!active()) return;
            await session.registry.disable(installation);
          } catch { /* 휴대폰 권한을 다시 켤 수 있는 설정 진입점을 유지한다. */ }
          if (active()) this.publish(device.status);
          return;
        }
        const installation = await this.identity.next();
        if (!active()) return;
        const response = await session.registry.register(installation, device.token);
        if (active()) this.publish("connected", response.accountBindingId);
      } catch {
        if (active()) this.publish("retry", previousBinding);
      }
    });
  }

  disableSession(sessionKey: string, capturedRegistry: PushRegistry): Promise<void> {
    // 오래된 계정의 cleanup을 새 계정의 등록보다 뒤에 보내지 않는다. sid revoke가 offline fallback이다.
    if (this.current?.sessionKey !== sessionKey) return Promise.resolve();
    this.current = null;
    const epoch = ++this.epoch;
    this.publish("signed-out");
    return this.enqueue(async () => {
      if (epoch !== this.epoch || this.current !== null) return;
      try {
        const installation = await this.identity.next();
        if (epoch !== this.epoch || this.current !== null) return;
        await capturedRegistry.disable(installation);
      } catch { /* 기존 서버 sid 폐기가 전송 대상의 최종 권한을 제거한다. */ }
    });
  }
}
