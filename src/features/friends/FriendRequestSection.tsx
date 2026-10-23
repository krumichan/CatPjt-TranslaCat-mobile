import { ActivityIndicator, Text, View } from "react-native";

import { chatErrorMessage } from "@/features/chat/service";
import { Button } from "@/ui/components";
import { colors } from "@/ui/theme";

import type { FriendRequestEntry } from "./service";
import { styles } from "./friends-styles";

type RequestAction = "accept" | "reject" | "cancel";

interface Props {
  direction: "received" | "sent";
  requests: FriendRequestEntry[] | undefined;
  pending?: boolean;
  error: unknown;
  disabled: boolean;
  onRespond: (requestId: string, action: RequestAction) => void;
}

// 받은 요청과 보낸 요청은 같은 목록 표시를 쓰고, 처리 순서는 화면에서 관리한다.
export function FriendRequestSection({ direction, requests, pending, error, disabled, onRespond }: Props) {
  const received = direction === "received";

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>
        {received ? `받은 친구 요청 ${requests?.length ?? ""}` : "보낸 친구 요청"}
      </Text>
      {pending && (
        <ActivityIndicator color={colors.blue} accessibilityLabel="받은 친구 요청 확인 중" />
      )}
      {!!error && <Text style={styles.error}>{chatErrorMessage(error)}</Text>}
      {requests?.length === 0 && (
        <Text style={styles.helper}>
          {received ? "새로운 친구 요청이 없어요." : "기다리는 친구 요청이 없어요."}
        </Text>
      )}
      {requests?.filter(request => request.status === "PENDING").map(request => {
        const person = received ? request.requester : request.receiver;

        return (
          <View key={request.id} style={styles.card}>
            <Text style={styles.name}>{person.nickname}</Text>
            <Text style={styles.helper}>@{person.publicId}</Text>
            {received ? (
              <View style={styles.row}>
                <View style={styles.grow}>
                  <Button label="수락" disabled={disabled} onPress={() => onRespond(request.id, "accept")} />
                </View>
                <View style={styles.grow}>
                  <Button label="거절" secondary disabled={disabled} onPress={() => onRespond(request.id, "reject")} />
                </View>
              </View>
            ) : (
              <Button label="요청 취소" secondary disabled={disabled} onPress={() => onRespond(request.id, "cancel")} />
            )}
          </View>
        );
      })}
    </View>
  );
}
