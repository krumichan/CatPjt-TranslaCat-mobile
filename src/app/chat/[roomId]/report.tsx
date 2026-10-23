import { useLocalSearchParams } from "expo-router";

import { useAuth } from "@/auth/AuthProvider";
import { wireId } from "@/domain/chat/contracts";
import ReportScreen from "@/features/reports/ReportScreen";
import { reportTarget } from "@/features/reports/service";

export default function ReportRoute() {
  const query = useLocalSearchParams();
  const auth = useAuth();
  let roomId = "";
  let target = null;
  try {
    if (typeof query.roomId !== "string") throw new Error("INVALID_ROOM");
    wireId(query.roomId);
    roomId = query.roomId;
    target = reportTarget(query);
  } catch { /* 경로는 신고 권한으로 신뢰하지 않는다. 잘못된 대상은 제출 화면을 열지 않는다. */ }
  return <ReportScreen key={`${auth.sessionKey}:${roomId}:${JSON.stringify(target)}`} roomId={roomId} target={target} />;
}
