import { useLocalSearchParams } from "expo-router";

import { useAuth } from "@/auth/AuthProvider";
import AiProfileScreen from "@/features/ai-chat/AiProfileScreen";

export default function AiProfileRoute() {
  const params = useLocalSearchParams<{ roomId?: string | string[]; aiMemberId?: string | string[] }>();
  const { sessionKey } = useAuth();
  const roomId = typeof params.roomId === "string" ? params.roomId : "";
  const memberId = typeof params.aiMemberId === "string" ? params.aiMemberId : "";
  return <AiProfileScreen key={`${sessionKey}:${roomId}:${memberId}`} roomId={roomId} memberId={memberId} />;
}
