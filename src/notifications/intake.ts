export class NotificationIntake {
  private active = true;
  private liveSeen = false;
  private receive: (data: unknown) => void;

  constructor(receive: (data: unknown) => void) { this.receive = receive; }

  live(data: unknown): boolean {
    if (!this.active) return false;
    // 사용자가 방금 탭한 응답은 시작 시 getter에 남아 있던 오래된 응답보다 우선한다.
    this.liveSeen = true;
    this.receive(data);
    return true;
  }

  cold(data: unknown): boolean {
    if (!this.active || this.liveSeen) return false;
    this.receive(data);
    return true;
  }

  stop() { this.active = false; }
}
