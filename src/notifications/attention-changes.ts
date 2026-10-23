export type AttentionChange = {
  sessionKey: string;
  readRoom?: { roomId: string; lastReadMessageId: string };
  readInvitationId?: string;
};

const listeners = new Set<(change: AttentionChange) => void>();

// 읽음 저장이 성공한 뒤에만 발행한다. 이벤트 자체로 서버 집계 값을 차감하지 않는다.
export function publishAttentionChange(change: AttentionChange) {
  listeners.forEach(listener => listener(change));
}

export function subscribeAttentionChanges(listener: (change: AttentionChange) => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
