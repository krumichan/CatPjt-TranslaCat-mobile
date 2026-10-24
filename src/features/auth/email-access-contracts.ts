import { ApiError } from "../../api/client.ts";

export type EmailAccessMode = "register" | "reset";
export type EmailAccessFields = {
  email: string; code: string; password: string; confirmation: string; nickname: string; birthDate: string;
};

export function normalizedEmail(value: string): string | null {
  const email = value.trim().toLowerCase();
  const at = email.indexOf("@");
  if (email.length > 254 || at < 1 || at > 64 || email.startsWith(".")
    || email[at - 1] === "." || email.slice(0, at).includes("..")) return null;
  return /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(email) ? email : null;
}

export function validNewPassword(value: string): boolean {
  // BCrypt와 같은 UTF-8 바이트 한도를 사용한다. 원래 비밀번호의 공백은 바꾸지 않는다.
  let bytes = 0;
  for (const character of value) {
    const point = character.codePointAt(0)!;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  }
  return value.trim().length > 0 && value.length >= 8 && bytes <= 72;
}

export function validBirthDate(value: string, now = Date.now()): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000")) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day && value <= new Date(now).toISOString().slice(0, 10);
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(0, "INVALID_AUTH_RESPONSE");
  return value as Record<string, unknown>;
}

function seconds(value: unknown, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > max) throw new ApiError(0, "INVALID_AUTH_RESPONSE");
  return value as number;
}

export function parseEmailChallenge(value: unknown) {
  const data = record(value);
  if (typeof data.challengeId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(data.challengeId)) {
    throw new ApiError(0, "INVALID_AUTH_RESPONSE");
  }
  return { challengeId: data.challengeId, expiresIn: seconds(data.expiresIn, 600), resendAfterSeconds: seconds(data.resendAfterSeconds, 86400) };
}

export function parseEmailProof(value: unknown) {
  const data = record(value);
  if (typeof data.verificationToken !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(data.verificationToken)) throw new ApiError(0, "INVALID_AUTH_RESPONSE");
  return { verificationToken: data.verificationToken, expiresIn: seconds(data.expiresIn, 600) };
}

export function parseEmailCompletion(value: unknown, mode: EmailAccessMode): void {
  const data = record(value);
  if (mode === "reset" ? data.success !== true : typeof data.publicId !== "string" || !/^[A-Za-z0-9-]{1,20}$/.test(data.publicId)) {
    throw new ApiError(0, "INVALID_AUTH_RESPONSE");
  }
}

export function emailAccessMessage(failure: unknown): string {
  if (!(failure instanceof ApiError)) return "요청을 완료하지 못했어요. 연결을 확인한 뒤 다시 시도해 주세요.";
  const code = failure.serverCode;
  if (failure.code === "API_NOT_CONFIGURED") return "서버 연결이 준비되면 이용할 수 있어요.";
  if (failure.status === 429) return "요청이 많아요. 안내된 시간이 지난 뒤 다시 시도해 주세요.";
  if (code === "AUTH_EMAIL_ALREADY_REGISTERED" || code === "ACCOUNT_ALREADY_EXISTS" || code === "ACCOUNT_LINK_REQUIRED") return "이미 사용하는 계정이 있어요. 기존 이메일 또는 Google로 로그인해 주세요.";
  if (code === "AUTH_EMAIL_CODE_INVALID") return "이메일로 받은 6자리 인증번호를 확인해 주세요.";
  if (code === "AUTH_EMAIL_UNAVAILABLE" || code === "AUTH_EMAIL_SEND_FAILED") return "인증 메일을 보내지 못했어요. 잠시 후 다시 시도해 주세요.";
  if (code === "AUTH_PASSWORD_RESET_INVALID") return "이메일 인증을 다시 시작해 주세요. Google로만 가입했다면 Google로 로그인해 주세요.";
  if (code === "AUTH_EMAIL_VERIFICATION_INVALID" || code === "AUTH_EMAIL_CODE_EXPIRED" || code === "AUTH_EMAIL_CODE_UNAVAILABLE"
    || code === "AUTH_EMAIL_CODE_ATTEMPTS_EXCEEDED" || code === "AUTH_EMAIL_CHALLENGE_REPLACED") return "인증이 만료됐거나 사용할 수 없어요. 인증 메일을 다시 요청해 주세요.";
  if (failure.status === 404 || failure.status === 405 || failure.status === 503) return "이 기능의 서버 연결을 준비하고 있어요. 잠시 후 다시 확인해 주세요.";
  return "요청 결과를 확인하지 못했어요. 가입·변경을 눌렀다면 먼저 로그인으로 결과를 확인해 주세요.";
}
