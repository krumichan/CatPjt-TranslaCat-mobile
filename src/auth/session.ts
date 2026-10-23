import { ApiError } from "../api/client.ts";

export type SessionUser = { id: string; publicId: string; name: string; email: string };
export type TokenPair = {
  accessToken: string; refreshToken: string; accessTokenExpiresIn: number; publicId: string;
};
export type SessionSnapshot = {
  status: "restoring" | "signedOut" | "signedIn";
  user: SessionUser | null;
  sessionKey: string | null;
  error: string | null;
  canRetryRestore: boolean;
};
type SavedSession = { refreshToken: string; publicId: string };
type SessionCredentials = SavedSession & { accessToken: string; expiresAt: number };
type CapturedCleanup = { credentials: SessionCredentials; flight: Promise<void> | null };
export type SessionStorage = {
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
  remove(): Promise<void>;
};
export type SessionTransport = {
  login(email: string, password: string): Promise<TokenPair>;
  refresh(refreshToken: string): Promise<TokenPair>;
  profile(accessToken: string): Promise<SessionUser>;
  logout(accessToken: string): Promise<void>;
};

function validatePair(pair: TokenPair, expectedPublicId?: string): TokenPair {
  if (!pair || typeof pair.accessToken !== "string" || !pair.accessToken
    || typeof pair.refreshToken !== "string" || !pair.refreshToken
    || typeof pair.publicId !== "string" || !pair.publicId
    || !Number.isFinite(pair.accessTokenExpiresIn) || pair.accessTokenExpiresIn <= 0
    || (expectedPublicId !== undefined && pair.publicId !== expectedPublicId)) {
    throw new ApiError(0, "INVALID_AUTH_RESPONSE");
  }
  return pair;
}

export class AuthSession {
  private snapshot: SessionSnapshot = {
    status: "restoring", user: null, sessionKey: null, error: null, canRetryRestore: false,
  };
  private generation = 0;
  private credentials: SessionCredentials | null = null;
  private refreshFlight: Promise<string | null> | null = null;
  private pendingCleanups = new Set<CapturedCleanup>();
  private capturedCleanups = new WeakMap<SessionCredentials, CapturedCleanup>();
  private storageQueue: Promise<void> = Promise.resolve();
  private listeners = new Set<() => void>();
  private storage: SessionStorage;
  private transport: SessionTransport;
  private now: () => number;
  private onBoundary: () => void;
  private onReleaseSession: (accessToken: string, sessionKey: string) => Promise<void>;

  constructor(storage: SessionStorage, transport: SessionTransport, now: () => number = Date.now,
    onBoundary: () => void = () => {}, onReleaseSession: (accessToken: string, sessionKey: string) => Promise<void> = async () => {}) {
    this.storage = storage;
    this.transport = transport;
    this.now = now;
    this.onBoundary = onBoundary;
    this.onReleaseSession = onReleaseSession;
  }

  getSnapshot = (): SessionSnapshot => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private publish(next: SessionSnapshot) {
    if (this.snapshot.sessionKey !== next.sessionKey) this.onBoundary();
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }

  private current(generation: number) {
    if (this.generation !== generation) throw new ApiError(0, "SESSION_CHANGED");
  }

  private store(operation: () => Promise<void>): Promise<void> {
    const next = this.storageQueue.then(operation);
    this.storageQueue = next.catch(() => {});
    return next;
  }

  private invalidate(error: string | null = null, canRetryRestore = false) {
    this.credentials = null;
    this.refreshFlight = null;
    this.publish({ status: "signedOut", user: null, sessionKey: null, error, canRetryRestore });
  }

  private async accept(pair: TokenPair, generation: number, email = "") {
    // 서버의 현재 사용자 조회로 신원을 확인하고 기기 저장소에는 refresh만 남긴다.
    this.current(generation);
    const expiresAt = this.now() + pair.accessTokenExpiresIn * 1000;
    const user = await this.transport.profile(pair.accessToken);
    this.current(generation);
    if (user.publicId !== pair.publicId) throw new ApiError(0, "INVALID_AUTH_RESPONSE");
    await this.store(async () => {
      this.current(generation);
      await this.storage.write(JSON.stringify({ refreshToken: pair.refreshToken, publicId: pair.publicId }));
    });
    this.current(generation);
    this.credentials = { ...pair, expiresAt };
    this.publish({
      status: "signedIn", user: { ...user, email }, sessionKey: String(generation) + ":" + user.publicId,
      error: null, canRetryRestore: false,
    });
  }

  private cleanupCaptured(captured: CapturedCleanup, sessionKey: string | null): Promise<void> {
    // 부가 등록은 경계가 바뀌기 전에 캡처한다. 겹친 정리는 같은 자격의 요청을 공유한다.
    if (captured.flight) return captured.flight;
    this.pendingCleanups.add(captured);
    let release: Promise<void> = Promise.resolve();
    if (sessionKey) {
      try { release = this.onReleaseSession(captured.credentials.accessToken, sessionKey).catch(() => {}); }
      catch { /* 부가 정리가 실패해도 sid 폐기는 독립적으로 진행한다. */ }
    }
    const refreshCaptured = async () => {
      const credentials = captured.credentials;
      const pair = validatePair(await this.transport.refresh(credentials.refreshToken), credentials.publicId);
      // 갱신된 자격은 cleanup 전용 복사본에만 남겨 재시도하며 active 세션·저장소는 바꾸지 않는다.
      captured.credentials = { ...pair, expiresAt: this.now() + pair.accessTokenExpiresIn * 1000 };
      return pair.accessToken;
    };
    const revoke = (async () => {
      let token = captured.credentials.accessToken;
      if (captured.credentials.expiresAt - this.now() <= 30_000) {
        try { token = await refreshCaptured(); }
        catch (error) {
          if (error instanceof ApiError && [401, 403].includes(error.status)) return;
          throw error;
        }
      }
      try { await this.transport.logout(token); }
      catch (error) {
        if (!(error instanceof ApiError) || error.status !== 401) throw error;
        // logout401만으로 완료하지 않고 최신 캡처 refresh의 인증 거절 또는 logout 성공을 확인한다.
        try { token = await refreshCaptured(); }
        catch (failure) {
          if (failure instanceof ApiError && [401, 403].includes(failure.status)) return;
          throw failure;
        }
        await this.transport.logout(token);
      }
    })();
    const flight = Promise.all([release, revoke]).then(() => { this.pendingCleanups.delete(captured); });
    captured.flight = flight;
    void flight.catch(() => {
      // 실패한 자격은 메모리에만 남기고 명시적인 다음 경계 정리에서 재시도한다.
      if (captured.flight === flight) captured.flight = null;
    });
    return flight;
  }

  private captureCleanups(): Promise<void>[] {
    const current = this.credentials;
    const captured = new Set(this.pendingCleanups);
    let currentCleanup: CapturedCleanup | null = null;
    if (current) {
      currentCleanup = this.capturedCleanups.get(current) ?? { credentials: { ...current }, flight: null };
      this.capturedCleanups.set(current, currentCleanup);
      captured.add(currentCleanup);
    }
    return Array.from(captured, cleanup => this.cleanupCaptured(
      cleanup, cleanup === currentCleanup ? this.snapshot.sessionKey : null,
    ));
  }

  private observeCleanup(cleanups: Promise<void>[], generation: number): void {
    void Promise.allSettled(cleanups).then(results => {
      // 이전 계정의 늦은 실패가 새 계정 로그인이나 저장소를 취소하지 못하게 한다.
      if (this.generation === generation && this.snapshot.status === "signedOut"
        && results.some(result => result.status === "rejected")) this.invalidate("SIGN_OUT_INCOMPLETE");
    });
  }

  restore = async (): Promise<void> => {
    // 이전 복원·로그인 응답이 새 계정 상태를 덮어쓰지 않도록 세대를 구분한다.
    const generation = ++this.generation;
    this.credentials = null;
    this.refreshFlight = null;
    this.publish({ status: "restoring", user: null, sessionKey: null, error: null, canRetryRestore: false });
    let saved: SavedSession | null = null;
    try {
      await this.storageQueue;
      this.current(generation);
      const raw = await this.storage.read();
      this.current(generation);
      if (!raw) { this.invalidate(); return; }
      try { saved = JSON.parse(raw) as SavedSession; } catch { /* 아래에서 손상된 저장 값을 거부한다. */ }
      if (!saved || typeof saved.refreshToken !== "string" || !saved.refreshToken
        || typeof saved.publicId !== "string" || !saved.publicId) {
        await this.store(() => this.storage.remove());
        this.current(generation);
        this.invalidate("SAVED_SESSION_INVALID");
        return;
      }
      const pair = validatePair(await this.transport.refresh(saved.refreshToken), saved.publicId);
      await this.accept(pair, generation);
    } catch (error) {
      if (this.generation !== generation) return;
      // 인증 거절만 자격을 폐기하고 일시적인 네트워크·저장소 오류는 복원 재시도를 남긴다.
      const denied = error instanceof ApiError && [401, 403].includes(error.status);
      if (denied) {
        try { await this.store(() => this.storage.remove()); } catch { /* 원문 오류를 노출하지 않는다. */ }
      }
      if (this.generation === generation) this.invalidate(denied ? "SESSION_EXPIRED" : "SESSION_RESTORE_UNAVAILABLE", !denied);
    }
  };

  signIn = async (email: string, password: string): Promise<void> => {
    await this.signInExternal(() => this.transport.login(email.trim(), password), email.trim());
  };

  signInExternal = async (login: () => Promise<TokenPair>, email = ""): Promise<void> => {
    const generation = ++this.generation;
    const cleanups = this.captureCleanups();
    this.invalidate();
    this.observeCleanup(cleanups, generation);
    await this.store(() => this.storage.remove());
    this.current(generation);
    const pair = validatePair(await login());
    try {
      this.current(generation);
      await this.accept(pair, generation, email);
    } catch (error) {
      // 저장 실패 때 불완전한 새 세션을 남기지 않으며, 새 계정이 있으면 건드리지 않는다.
      void this.transport.logout(pair.accessToken).catch(() => {});
      if (this.generation === generation) {
        try { await this.store(() => this.storage.remove()); } catch { /* 화면에서 재시도를 안내한다. */ }
        if (this.generation === generation) this.invalidate();
      }
      throw error;
    }
  };

  accessToken = async (): Promise<string | null> => {
    const credentials = this.credentials;
    if (!credentials || this.snapshot.status !== "signedIn") return null;
    if (credentials.expiresAt - this.now() > 30_000) return credentials.accessToken;
    if (this.refreshFlight) return this.refreshFlight;
    const generation = this.generation;
    const flight = (async () => {
      try {
        const pair = validatePair(await this.transport.refresh(credentials.refreshToken), credentials.publicId);
        const expiresAt = this.now() + pair.accessTokenExpiresIn * 1000;
        this.current(generation);
        await this.store(async () => {
          this.current(generation);
          await this.storage.write(JSON.stringify({ refreshToken: pair.refreshToken, publicId: pair.publicId }));
        });
        this.current(generation);
        this.credentials = { ...pair, expiresAt };
        return pair.accessToken;
      } catch (error) {
        if (this.generation === generation && error instanceof ApiError && [401, 403].includes(error.status)) {
          ++this.generation;
          this.invalidate("SESSION_EXPIRED");
          await this.store(() => this.storage.remove());
        }
        throw error instanceof ApiError ? error : new ApiError(0, "SESSION_REFRESH_UNAVAILABLE");
      }
    })();
    this.refreshFlight = flight;
    try { return await flight; } finally { if (this.refreshFlight === flight) this.refreshFlight = null; }
  };

  signOut = async (): Promise<void> => {
    // 화면·소켓·cache는 즉시 해제하고 캡처한 정리와 저장소 삭제를 함께 기다린다.
    const cleanups = this.captureCleanups();
    const generation = ++this.generation;
    this.invalidate();
    const results = await Promise.allSettled([...cleanups, this.store(() => this.storage.remove())]);
    if (this.generation === generation && results.some(result => result.status === "rejected")) {
      this.invalidate("SIGN_OUT_INCOMPLETE");
    }
  };

  rejectCurrent = (failedToken: string): void => {
    // 보호 요청의 확정된 401은 재전송 없이 현재 세션만 폐기한다.
    if (this.credentials?.accessToken !== failedToken || this.refreshFlight) return;
    const cleanups = this.captureCleanups();
    const generation = ++this.generation;
    this.invalidate("SESSION_EXPIRED");
    this.observeCleanup([...cleanups, this.store(() => this.storage.remove())], generation);
  };
}
