export const chatRealtime = {
  path: "/ws/chat",
  readQueue: "/user/queue/chat/read",
  notificationQueue: "/user/queue/chat/notifications",
};

export function roomTopic(roomId: string): string {
  // 임의 목적지나 경로 조각이 room 구독으로 들어가지 않도록 식별자를 확인한다.
  if (!/^[1-9][0-9]{0,19}$/.test(roomId)) throw new Error("INVALID_ROOM_ID");
  return "/topic/chat/rooms/" + roomId;
}
