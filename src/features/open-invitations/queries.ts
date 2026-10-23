export const invitationKeys = {
  root: (sessionKey: string | null) => ["open-invitations", sessionKey] as const,
  summary: (sessionKey: string | null) => ["open-invitations", sessionKey, "summary"] as const,
  list: (sessionKey: string | null) => ["open-invitations", sessionKey, "list"] as const,
};
