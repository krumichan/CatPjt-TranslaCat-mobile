import { useAuth } from "@/auth/AuthProvider";
import OpenChatScreen from "@/features/open-chat/OpenChatScreen";

export default function OpenChatRoute() {
  const { sessionKey } = useAuth();
  return <OpenChatScreen key={sessionKey} />;
}
