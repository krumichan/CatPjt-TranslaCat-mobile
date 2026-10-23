// 웹 NextAuth 쿠키와 독립된 인증 경계다. 실제 로그인·갱신은 다중 세션 서버 계약 이후 연결한다.
export type AccessTokenProvider = () => Promise<string | null>;

export const signedOutTokenProvider: AccessTokenProvider = async () => null;
