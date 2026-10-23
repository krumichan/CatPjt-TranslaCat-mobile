// 레이아웃 측정 뒤 늦게 도착한 scroll 이벤트가 이전 키보드 높이를 되돌리지 않게 한다.
export class ChatScrollMetrics {
  viewport = 0;
  content = 0;
  offset = 0;
  private measuredViewport: number | null = null;
  private measuredContent: number | null = null;

  measureViewport(height: number) {
    const changed = this.measuredViewport !== height;
    this.measuredViewport = height;
    this.viewport = height;
    return changed;
  }

  measureContent(height: number) {
    const changed = this.measuredContent !== height;
    this.measuredContent = height;
    this.content = height;
    return changed;
  }

  observeScroll(offset: number, content: number, viewport: number) {
    this.offset = offset;
    if (this.measuredContent === null) this.content = content;
    if (this.measuredViewport === null) this.viewport = viewport;
  }
}
