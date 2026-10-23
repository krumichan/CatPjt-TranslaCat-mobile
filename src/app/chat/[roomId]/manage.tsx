import { useLocalSearchParams } from "expo-router";

import { useAuth } from "@/auth/AuthProvider";
import RoomManagementScreen from "@/features/room-management/RoomManagementScreen";

export default function RoomManagementRoute() {
  const { roomId } = useLocalSearchParams<{ roomId?: string | string[] }>();
  const { sessionKey } = useAuth();
  const id = typeof roomId === "string" ? roomId : "";
  return <RoomManagementScreen key={`${sessionKey}:${id}`} roomId={id} />;
}
