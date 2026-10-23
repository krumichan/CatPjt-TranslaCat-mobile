import { useLocalSearchParams } from "expo-router";
import { Text } from "react-native";

import InvitationInboxScreen from "@/features/open-invitations/InvitationInboxScreen";
import { Screen } from "@/ui/components";

export default function InvitationsRoute() {
  const { notificationId } = useLocalSearchParams<{ notificationId?: string | string[] }>();
  const valid = typeof notificationId === "string" && /^[1-9][0-9]*$/.test(notificationId)
    && Number.isSafeInteger(Number(notificationId)) && String(Number(notificationId)) === notificationId;
  if (notificationId !== undefined && !valid) return <Screen><Text>올바른 초대 주소가 아니에요. 채팅 목록에서 받은 초대를 다시 열어 주세요.</Text></Screen>;
  return <InvitationInboxScreen notificationId={valid ? notificationId as string : null} />;
}
