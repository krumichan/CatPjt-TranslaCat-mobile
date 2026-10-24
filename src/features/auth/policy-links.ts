// 공개 문서의 내용과 주소를 확인한 뒤 등록한다. 로그인 화면으로 이동하는 임의 경로는 사용하지 않는다.
export const policyLinks: { terms: string | null; privacy: string | null } = {
  terms: null,
  privacy: null,
};

export function publicPolicyUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}
