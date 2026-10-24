import { ApiError } from "../../api/client.ts";
import {
  emailAccessMessage, normalizedEmail, parseEmailChallenge, parseEmailCompletion, parseEmailProof,
  validBirthDate, validNewPassword, type EmailAccessFields, type EmailAccessMode,
} from "./email-access-contracts.ts";

type Request = (path: string, body: unknown, signal: AbortSignal) => Promise<unknown>;
type State = EmailAccessFields & {
  busy: "send" | "verify" | "complete" | null;
  verified: boolean; expiresAt: number; cooldownUntil: number;
  error: string | null; message: string | null; completed: boolean;
};

export function createEmailAccessController({ mode, request, current, now = Date.now, timeoutMs = 20000 }: {
  mode: EmailAccessMode; request: Request; current: () => boolean; now?: () => number; timeoutMs?: number;
}) {
  let state: State = { email: "", code: "", password: "", confirmation: "", nickname: "", birthDate: "",
    busy: null, verified: false, expiresAt: 0, cooldownUntil: 0, error: null, message: null, completed: false };
  let challengeId: string | null = null;
  let proof: string | null = null;
  let revision = 0;
  let pending: { abort: AbortController; cancel: () => void } | null = null;
  const listeners = new Set<() => void>();
  const publish = (patch: Partial<State>) => {
    state = { ...state, ...patch };
    listeners.forEach(listener => listener());
  };

  const invalidate = () => {
    revision++;
    pending?.abort.abort();
    pending?.cancel();
    pending = null;
  };

  const run = async (kind: NonNullable<State["busy"]>, path: string, body: unknown, accept: (value: unknown) => void) => {
    // 응답은 현재 화면·계정의 한 요청만 반영한다. 쓰기 요청은 자동으로 재시도하지 않는다.
    if (state.busy || !current() || state.completed) return;
    const ownedRevision = ++revision;
    const abort = new AbortController();
    let cancel!: () => void;
    const cancelled = new Promise<never>((_, reject) => { cancel = () => reject(new ApiError(0, "REQUEST_ABORTED")); });
    pending = { abort, cancel };
    const timer = setTimeout(() => { abort.abort(); cancel(); }, timeoutMs);
    publish({ busy: kind, error: null, message: null });
    try {
      const result = await Promise.race([request(path, body, abort.signal), cancelled]);
      if (ownedRevision === revision && current()) accept(result);
    } catch (failure) {
      if (ownedRevision !== revision || !current()) return;
      const retry = failure instanceof ApiError ? failure.retryAfterSeconds : undefined;
      // 서버가 준 재발송 제한은 유지하며 원문 오류·인증 증명을 화면에 반사하지 않는다.
      if (retry) publish({ cooldownUntil: Math.max(state.cooldownUntil, now() + retry * 1000) });
      if (kind === "complete" || failure instanceof ApiError && ["AUTH_EMAIL_VERIFICATION_INVALID", "AUTH_PASSWORD_RESET_INVALID"].includes(failure.serverCode ?? "")) {
        proof = null;
        publish({ verified: false, password: "", confirmation: "" });
      }
      publish({ error: emailAccessMessage(failure) });
    } finally {
      clearTimeout(timer);
      if (ownedRevision === revision) {
        pending = null;
        // 폐기된 로그인 세대의 늦은 finally도 이전 화면에 변경을 알리지 않는다.
        if (current()) publish({ busy: null });
      }
    }
  };

  const tick = () => {
    if (!current()) return;
    if (state.expiresAt > 0 && state.expiresAt <= now()) {
      challengeId = null;
      proof = null;
      publish({ verified: false, expiresAt: 0, code: "", message: "인증 시간이 지났어요. 메일을 다시 요청해 주세요." });
    }
  };

  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    setField(field: keyof EmailAccessFields, value: string) {
      if (state.busy || state.completed || !current()) return;
      // 이메일이 바뀌면 이전 주소의 코드와 증명을 재사용하지 않는다.
      if (field === "email" && normalizedEmail(value) !== normalizedEmail(state.email)) {
        challengeId = null;
        proof = null;
        publish({ verified: false, expiresAt: 0, code: "" });
      }
      publish({ [field]: value, error: null });
    },
    tick,
    async send() {
      if (state.busy || state.completed || !current() || state.cooldownUntil > now()) return;
      const email = normalizedEmail(state.email);
      if (!email) { publish({ error: "올바른 이메일 주소를 입력해 주세요." }); return; }
      challengeId = null;
      proof = null;
      // 네트워크 결과가 불명확해도 SMTP가 이미 실행됐을 수 있으므로 기본 대기 시간을 보존한다.
      publish({ verified: false, expiresAt: 0, code: "", cooldownUntil: now() + 60000 });
      await run("send", mode === "register" ? "/auth/email/challenges" : "/auth/password-reset/challenges", { email }, value => {
        const challenge = parseEmailChallenge(value);
        challengeId = challenge.challengeId;
        publish({ expiresAt: now() + challenge.expiresIn * 1000, cooldownUntil: now() + challenge.resendAfterSeconds * 1000,
          message: "인증번호를 보냈어요. 받은편지함과 스팸함을 확인해 주세요." });
      });
    },
    async verify() {
      tick();
      if (state.busy || state.verified || !current()) return;
      if (!challengeId || !/^[0-9]{6}$/.test(state.code)) { publish({ error: "메일을 요청한 뒤 6자리 인증번호를 입력해 주세요." }); return; }
      await run("verify", mode === "register" ? "/auth/email/verify" : "/auth/password-reset/verify", { challengeId, code: state.code }, value => {
        const verified = parseEmailProof(value);
        proof = verified.verificationToken;
        publish({ verified: true, code: "", expiresAt: now() + verified.expiresIn * 1000, message: "이메일을 인증했어요. 아래 정보를 입력해 마무리해 주세요." });
      });
    },
    async complete() {
      tick();
      if (state.busy || state.completed || !current()) return;
      const email = normalizedEmail(state.email);
      if (!email || !proof || !state.verified) { publish({ error: "먼저 이메일 인증을 완료해 주세요." }); return; }
      if (!validNewPassword(state.password)) { publish({ error: "비밀번호는 8자 이상, UTF-8 기준 72바이트 이하로 입력해 주세요." }); return; }
      if (state.password !== state.confirmation) { publish({ error: "비밀번호 확인이 일치하지 않아요." }); return; }
      if (mode === "register" && (!state.nickname.trim() || state.nickname.trim().length > 30 || !validBirthDate(state.birthDate, now()))) {
        publish({ error: "닉네임(1~30자)과 생년월일(YYYY-MM-DD)을 확인해 주세요." }); return;
      }

      // 증명은 메모리에만 두며 제출 시작과 함께 소유권을 넘긴다. 재사용·자동 로그인은 하지 않는다.
      const verificationToken = proof;
      proof = null;
      challengeId = null;
      const body = { email, password: state.password, verificationToken,
        ...(mode === "register" ? { nickname: state.nickname.trim(), birthDate: state.birthDate } : {}) };
      publish({ verified: false, expiresAt: 0, password: "", confirmation: "" });
      await run("complete", mode === "register" ? "/auth/register" : "/auth/password-reset/complete", body, value => {
        parseEmailCompletion(value, mode);
        challengeId = null;
        publish({ password: "", confirmation: "", code: "", verified: false, expiresAt: 0, completed: true,
          message: mode === "register" ? "가입을 완료했어요. 새 계정으로 로그인해 주세요." : "비밀번호를 변경했어요. 기존 로그인은 해제돼요. 새 비밀번호로 로그인해 주세요." });
      });
    },
    suspend(reset = false) {
      const interrupted = state.busy !== null;
      invalidate();
      if (reset) { challengeId = null; proof = null; }
      publish({ busy: null, password: "", confirmation: "", code: "",
        ...(reset ? { verified: false, expiresAt: 0 } : {}),
        ...(interrupted ? { error: "요청 결과를 확인하지 못했어요. 가입·변경 중이었다면 로그인으로 먼저 확인해 주세요." } : {}) });
    },
  };
}
