import { useLocalSearchParams } from "expo-router";

import { useAuth } from "@/auth/AuthProvider";
import OpenProfileScreen from "@/features/open-profile/OpenProfileScreen";

export default function OpenProfileRoute() {
  const { roomId } = useLocalSearchParams<{ roomId?: string | string[] }>();
  const { sessionKey } = useAuth();
  const id = typeof roomId === "string" ? roomId : "";
  return <OpenProfileScreen key={`${sessionKey}:${id}`} roomId={id} />;
}
