// 일반 계정 프로필이나 인증 헤더를 보충하지 않고 서버가 준 공개 HTTPS 이미지만 사용한다.
export function profileImageUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 8192 || /[\u0000-\u0020]/.test(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash ? url.href : null;
  } catch {
    return null;
  }
}
