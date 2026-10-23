import { useAuth } from "@/auth/AuthProvider";
import OpenRoomCreateScreen from "@/features/open-chat/OpenRoomCreateScreen";

export default function OpenRoomCreateRoute() {
  const { sessionKey } = useAuth();
  return <OpenRoomCreateScreen key={sessionKey} />;
}
