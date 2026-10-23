import { useLocalSearchParams } from "expo-router";

import { useAuth } from "@/auth/AuthProvider";
import ChatRoomScreen from "@/features/chat/ChatRoomScreen";

export default function ChatRoomRoute() {
  const { roomId } = useLocalSearchParams<{ roomId?: string | string[] }>();
  const { sessionKey } = useAuth();
  const id = typeof roomId === "string" ? roomId : "";
  return <ChatRoomScreen key={`${sessionKey}:${id}`} roomId={id} />;
}
