import type { OpenRoom } from "../../domain/chat/types.ts";
import { openRoomCreateFailure, type OpenRoomCreateErrors, type OpenRoomCreateInput, type OpenRoomCreateService } from "./create-service.ts";

interface OpenRoomCreateState {
  status: "idle" | "submitting" | "rejected" | "uncertain" | "created";
  message: string | null;
  fields: OpenRoomCreateErrors;
  roomId: string | null;
}

export function createOpenRoomSubmission(service: OpenRoomCreateService, isCurrent: () => boolean) {
  let state: OpenRoomCreateState = { status: "idle", message: null, fields: {}, roomId: null };
  let attached = false;
  let generation = 0;
  let pending: AbortController | null = null;
  const listeners = new Set<() => void>();
  const publish = (next: OpenRoomCreateState) => {
    state = next;
    for (const listener of listeners) listener();
  };
  const cancel = () => {
    generation += 1;
    pending?.abort();
    pending = null;
    if (state.status === "submitting") {
      publish({ status: "uncertain", roomId: null, fields: {}, message: openRoomCreateFailure(null).message });
    }
  };

  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    // StrictMode가 effect를 setup-cleanup-setup해도 영구 폐기하지 않고 현재 소유권만 다시 연결한다.
    attach() { attached = true; },
    detach() { attached = false; cancel(); },
    cancel,
    clearValidation() {
      if (state.status === "rejected") publish({ status: "idle", message: null, fields: {}, roomId: null });
    },
    async submit(input: OpenRoomCreateInput): Promise<OpenRoom | null> {
      // React의 다음 렌더보다 먼저 동기 잠금을 건다. 생성 성공·결과 불명 상태에서는 재제출하지 않는다.
      if (!attached || !isCurrent() || ["submitting", "uncertain", "created"].includes(state.status)) return null;
      const ownedGeneration = ++generation;
      const controller = new AbortController();
      pending = controller;
      publish({ status: "submitting", message: null, fields: {}, roomId: null });
      const owned = () => attached && generation === ownedGeneration && isCurrent();

      try {
        const room = await service.create(input, controller.signal);
        // 계정 전환·취소 뒤 도착한 성공은 이전 화면을 갱신하거나 새 계정의 방으로 이동시키지 않는다.
        if (!owned()) return null;
        publish({ status: "created", message: null, fields: {}, roomId: room.id });
        return room;
      } catch (error) {
        if (!owned()) return null;
        const failure = openRoomCreateFailure(error);
        publish({ status: failure.uncertain ? "uncertain" : "rejected", message: failure.message, fields: failure.fields, roomId: null });
        return null;
      } finally {
        if (generation === ownedGeneration) pending = null;
      }
    },
  };
}
