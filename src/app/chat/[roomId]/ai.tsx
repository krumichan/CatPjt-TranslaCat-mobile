import { useLocalSearchParams } from "expo-router";

import { useAuth } from "@/auth/AuthProvider";
import AiRoomScreen from "@/features/ai-chat/AiRoomScreen";

export default function AiRoomRoute() {
  const { roomId } = useLocalSearchParams<{ roomId?: string | string[] }>();
  const { sessionKey } = useAuth();
  const id = typeof roomId === "string" ? roomId : "";
  return <AiRoomScreen key={`${sessionKey}:${id}`} roomId={id} />;
}
