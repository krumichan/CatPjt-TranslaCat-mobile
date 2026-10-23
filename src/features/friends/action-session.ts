import { ApiError } from "../../api/client.ts";
import { ChatContractError } from "../../domain/chat/contracts.ts";

export function createFriendActionSession(isCurrent: () => boolean) {
  let disposed = false;
  let busy = false;
  let uncertainRoom = false;
  const cancellation = new AbortController();
  return {
    get busy() { return busy; },
    get uncertainRoom() { return uncertainRoom; },
    async run<T>(action: (signal: AbortSignal) => Promise<T>, createsRoom: boolean) {
      // 같은 화면에서 빠른 두 번 탭과 계정 전환 뒤 늦은 결과를 동기적으로 차단한다.
      if (disposed || !isCurrent() || busy || uncertainRoom) return { kind: "ignored" as const };
      busy = true;
      try {
        const value = await action(cancellation.signal);
        if (disposed || !isCurrent()) return { kind: "ignored" as const };
        return { kind: "success" as const, value };
      } catch (error) {
        if (disposed || !isCurrent()) return { kind: "ignored" as const };
        // 비멱등 방 생성의 응답을 잃으면 자동 재전송하지 않고 기존 채팅 목록에서 확인하게 한다.
        const unknown = createsRoom && (error instanceof ChatContractError || !(error instanceof ApiError)
          || error.status === 0 || error.status >= 500 || error.status === 408
          || error.code === "INVALID_API_RESPONSE" || (error.status >= 200 && error.status < 300));
        if (unknown) uncertainRoom = true;
        return { kind: "failure" as const, error, uncertainRoom: unknown };
      } finally { busy = false; }
    },
    dispose() { disposed = true; cancellation.abort(); },
  };
}
