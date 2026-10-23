import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { FlatList, Keyboard, type FlatListProps, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";

import { ChatScrollFollow } from "@/domain/chat/scroll-follow";
import { ChatScrollMetrics } from "@/domain/chat/scroll-metrics";
import type { ChatMessage } from "@/domain/chat/types";

// 목록 하단 padding 16px은 메시지 가림이 아니다. 배치 반올림 2px만 더 허용한다.
const END_TOLERANCE = 18;

interface ScrollOptions {
  messages: ChatMessage[];
  loading: boolean;
  entryTarget: { messageId: string | null; unread: boolean } | null;
  active: boolean;
  markVisible: (ids: string[]) => void;
  setReadingReady: (ready: boolean) => void;
}

export function useChatScroll(options: ScrollOptions, list: RefObject<FlatList<ChatMessage> | null>) {
  const { entryTarget, setReadingReady, active, markVisible, loading, messages } = options;
  const current = useRef(options);
  useLayoutEffect(() => { current.current = options; }, [options]);
  const [placement, setPlacement] = useState<{ target: ScrollOptions["entryTarget"]; placed: boolean; error: string | null }>({ target: null, placed: false, error: null });
  const placed = placement.target === entryTarget && placement.placed;
  const positionError = placement.target === entryTarget ? placement.error : null;
  const [atLatest, setAtLatest] = useState(false);
  const ready = useRef(false);
  const pending = useRef<{ id: string | null; latest: boolean } | null>(null);
  const visible = useRef<string[]>([]);
  const metrics = useRef(new ChatScrollMetrics());
  const attempts = useRef(0);
  const retry = useRef<ReturnType<typeof setTimeout> | null>(null);
  const frame = useRef<number | null>(null);
  const tryPosition = useRef<() => void>(() => {});
  const lastMessageId = messages[messages.length - 1]?.id ?? null;
  const previousLastId = useRef(lastMessageId);
  const [follow] = useState(() => new ChatScrollFollow({
    scheduler: {
      requestFrame: (callback) => requestAnimationFrame(callback),
      cancelFrame: (handle) => cancelAnimationFrame(handle),
      setTimer: (callback, delay) => setTimeout(callback, delay),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
    canFollow: () => ready.current && current.current.active && !pending.current,
    isAtBottom: () => {
      const { content, viewport, offset } = metrics.current;
      const lastId = current.current.messages[current.current.messages.length - 1]?.id;
      return content > 0 && viewport > 0 && Math.max(0, content - viewport - offset) <= END_TOLERANCE
        && Boolean(lastId && visible.current.includes(lastId));
    },
    // 가상화가 추정한 마지막 셀 높이 대신 실제 콘텐츠·뷰포트 측정값을 사용한다.
    scrollToEnd: () => list.current?.scrollToOffset({
      offset: Math.max(0, metrics.current.content - metrics.current.viewport), animated: false,
    }),
    onFollowingChange: setAtLatest,
  }));

  const cancelScheduled = useCallback(() => {
    if (retry.current) clearTimeout(retry.current);
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    retry.current = null;
    frame.current = null;
  }, []);

  const confirmPosition = useCallback(() => {
    if (!pending.current) return;
    const latest = pending.current.latest;
    cancelScheduled();
    pending.current = null;
    ready.current = true;
    follow.positionConfirmed(latest);
    setPlacement({ target: current.current.entryTarget, placed: true, error: null });
  }, [cancelScheduled, follow]);

  const schedulePosition = useCallback(() => {
    if (frame.current !== null || !current.current.active || !pending.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      if (pending.current) tryPosition.current();
    });
  }, []);

  // 가변 높이 말풍선은 가상화 측정 뒤 다시 찾아간다. 임시로 보인 행은 읽음 처리하지 않는다.
  const attemptPosition = useCallback(() => {
    const target = pending.current;
    if (!target || current.current.loading || !current.current.active || !metrics.current.viewport) return;
    const messages = current.current.messages;
    if (!messages.length) { confirmPosition(); return; }
    if (target.latest) {
      if (!metrics.current.content) return;
      list.current?.scrollToOffset({
        offset: Math.max(0, metrics.current.content - metrics.current.viewport), animated: false,
      });
      const distance = Math.max(0, metrics.current.content - metrics.current.viewport - metrics.current.offset);
      const lastId = messages[messages.length - 1]?.id;
      if (distance <= END_TOLERANCE && lastId && visible.current.includes(lastId)) confirmPosition();
      else if (!retry.current) {
        attempts.current += 1;
        if (attempts.current > 40) {
          pending.current = null;
          setPlacement({ target: current.current.entryTarget, placed: false, error: "최신 위치를 표시하지 못했어요. 최신 메시지로 다시 이동해 주세요." });
          return;
        }
        retry.current = setTimeout(() => { retry.current = null; schedulePosition(); }, 100);
      }
      return;
    }
    const index = messages.findIndex((message) => message.id === target.id);
    if (index >= 0) list.current?.scrollToIndex({ index, animated: false, viewPosition: 0.15 });
  }, [confirmPosition, list, schedulePosition]);

  useLayoutEffect(() => { tryPosition.current = attemptPosition; }, [attemptPosition]);

  useEffect(() => {
    cancelScheduled();
    ready.current = false;
    follow.reset();
    attempts.current = 0;
    const target = entryTarget;
    pending.current = target ? { id: target.messageId, latest: !target.unread } : null;
    setReadingReady(false);
    schedulePosition();
  }, [entryTarget, setReadingReady, cancelScheduled, schedulePosition, follow]);

  useEffect(() => {
    // 읽음 수·번역 변경으로 새 배열이 생겨도 하단 이동을 반복하지 않는다.
    const appended = previousLastId.current !== lastMessageId;
    previousLastId.current = lastMessageId;
    schedulePosition();
    if (appended) follow.contentOrViewportChanged();
  }, [loading, messages, lastMessageId, schedulePosition, follow]);

  useEffect(() => {
    // 화면이 표시된 다음에만 읽음 타이머를 열고, 복귀 때도 실제 화면의 기존 행만 전달한다.
    setReadingReady(active && placed && ready.current);
    if (active && placed && ready.current) markVisible(visible.current);
    if (active) schedulePosition();
    else {
      cancelScheduled();
      follow.cancelScheduled();
    }
    return () => setReadingReady(false);
  }, [active, placed, setReadingReady, markVisible, cancelScheduled, schedulePosition, follow]);

  useEffect(() => () => {
    cancelScheduled();
    follow.cancelScheduled();
  }, [cancelScheduled, follow]);

  useEffect(() => {
    // 최종 IME 배치도 정합하되, 과거 열람이나 사용자 제스처에서 따라가기를 새로 켜지 않는다.
    const reconcile = () => follow.contentOrViewportChanged();
    const show = Keyboard.addListener("keyboardDidShow", reconcile);
    const hide = Keyboard.addListener("keyboardDidHide", reconcile);
    return () => { show.remove(); hide.remove(); };
  }, [follow]);

  const onViewableItemsChanged = useCallback<NonNullable<FlatListProps<ChatMessage>["onViewableItemsChanged"]>>(({ viewableItems }) => {
    visible.current = viewableItems.filter((item) => item.isViewable).map((item) => item.item.id);
    const target = pending.current;
    const distance = Math.max(0, metrics.current.content - metrics.current.viewport - metrics.current.offset);
    const lastId = current.current.messages[current.current.messages.length - 1]?.id;
    if (target && (!target.latest ? target.id && visible.current.includes(target.id)
      : metrics.current.content > 0 && distance <= END_TOLERANCE && lastId && visible.current.includes(lastId))) confirmPosition();
    if (ready.current && current.current.active) current.current.markVisible(visible.current);
  }, [confirmPosition]);

  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    metrics.current.observeScroll(contentOffset.y, contentSize.height, layoutMeasurement.height);
    const distance = Math.max(0, metrics.current.content - metrics.current.viewport - metrics.current.offset);
    const lastId = current.current.messages[current.current.messages.length - 1]?.id;
    if (pending.current?.latest && distance <= END_TOLERANCE && lastId && visible.current.includes(lastId)) confirmPosition();
    follow.scrolled();
  }, [confirmPosition, follow]);

  const onContentSizeChange = useCallback((_width: number, height: number) => {
    // onScroll이 먼저 새 크기를 알려도 실제 측정 이벤트의 변화는 별도로 인식한다.
    const changed = metrics.current.measureContent(height);
    if (pending.current) schedulePosition();
    else if (changed) follow.contentOrViewportChanged();
  }, [schedulePosition, follow]);

  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const height = event.nativeEvent.layout.height;
    const changed = metrics.current.measureViewport(height);
    if (pending.current) schedulePosition();
    else if (changed) follow.contentOrViewportChanged();
  }, [schedulePosition, follow]);

  const onScrollToIndexFailed = useCallback<NonNullable<FlatListProps<ChatMessage>["onScrollToIndexFailed"]>>((info) => {
    if (!pending.current || !current.current.active) return;
    attempts.current += 1;
    if (attempts.current > 20) {
      pending.current = null;
      setPlacement({ target: current.current.entryTarget, placed: false, error: "읽던 위치를 표시하지 못했어요. 최신 메시지로 이동하거나 방을 다시 열어 주세요." });
      return;
    }
    list.current?.scrollToOffset({ offset: Math.max(0, info.averageItemLength * info.index), animated: false });
    if (retry.current) clearTimeout(retry.current);
    retry.current = setTimeout(() => { retry.current = null; schedulePosition(); }, 100);
  }, [schedulePosition, list]);

  const jumpToLatest = useCallback(() => {
    cancelScheduled();
    follow.reset();
    ready.current = false;
    attempts.current = 0;
    setPlacement({ target: current.current.entryTarget, placed: false, error: null });
    current.current.setReadingReady(false);
    pending.current = { id: null, latest: true };
    schedulePosition();
  }, [cancelScheduled, schedulePosition, follow]);

  const beginUserScroll = useCallback(() => {
    if (!ready.current) return;
    cancelScheduled();
    follow.beginDrag();
  }, [cancelScheduled, follow]);

  const prepareComposerFocus = useCallback(() => {
    const { content, viewport, offset } = metrics.current;
    follow.prepareForViewportChange(content > 0 && viewport > 0
      && Math.max(0, content - viewport - offset) <= END_TOLERANCE);
  }, [follow]);

  const endUserScroll = useCallback(() => follow.endDrag(), [follow]);
  const beginMomentum = useCallback(() => follow.beginMomentum(), [follow]);
  const endMomentum = useCallback(() => follow.endMomentum(), [follow]);
  const onWheel = useCallback(() => {
    if (!ready.current) return;
    cancelScheduled();
    follow.wheel();
  }, [cancelScheduled, follow]);

  return {
    placed, atLatest, positionError, jumpToLatest, onLayout, onScroll, onContentSizeChange, prepareComposerFocus,
    onViewableItemsChanged, onScrollToIndexFailed,
    onScrollBeginDrag: beginUserScroll,
    onScrollEndDrag: endUserScroll,
    onTouchEnd: endUserScroll,
    onTouchCancel: endUserScroll,
    onMomentumScrollBegin: beginMomentum,
    onMomentumScrollEnd: endMomentum,
    onWheel,
  };
}
