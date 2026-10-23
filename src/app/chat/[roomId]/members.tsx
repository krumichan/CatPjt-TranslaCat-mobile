import { useLocalSearchParams } from "expo-router";

import { useAuth } from "@/auth/AuthProvider";
import RoomMembersScreen from "@/features/room-management/RoomMembersScreen";

export default function RoomMembersRoute() {
  const { roomId } = useLocalSearchParams<{ roomId?: string | string[] }>();
  const { sessionKey } = useAuth();
  const id = typeof roomId === "string" ? roomId : "";
  return <RoomMembersScreen key={`${sessionKey}:${id}`} roomId={id} />;
}
