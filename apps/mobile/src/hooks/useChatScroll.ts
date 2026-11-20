import { useEffect, useRef, useState } from 'react';
import type { NativeScrollEvent, NativeSyntheticEvent, ScrollView } from 'react-native';
import type { AgentMessage } from '@aidb/core';
import type { LiveTurn } from '../types';

export function useChatScroll({ live, messages, sessionId, busy }: { live: LiveTurn | undefined; messages: AgentMessage[]; sessionId: string | undefined; busy: boolean | undefined }) {
  const scrollRef = useRef<ScrollView>(null);
  /** 是否跟随最新输出；用户手动上滑后置为 false，滑回底部再恢复。 */
  const stickRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  /** 首次加载/流式输出期间，内容尺寸变化才跟随贴底；静态展开折叠不触发。 */
  const initialScrollRef = useRef(true);
  const busyRef = useRef(false);
  const lastTurnStartRef = useRef(0);
  const [showJump, setShowJump] = useState(false);

  useEffect(() => {
    busyRef.current = Boolean(busy);
  }, [busy]);

  useEffect(() => {
    if (!stickRef.current) return;
    const timer = setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 60);
    return () => clearTimeout(timer);
  }, [live?.text, live?.tools.length, live?.status, live?.plan, messages.length]);

  // 新一轮开始：无论此前停在哪里都回到最新输出。
  useEffect(() => {
    if (!live || live.startedAt === lastTurnStartRef.current) return;
    lastTurnStartRef.current = live.startedAt;
    stickRef.current = true;
    setShowJump(false);
    scrollRef.current?.scrollToEnd({ animated: false });
  }, [live?.startedAt]);

  // 切换/新建会话：重置为跟随底部，等首屏布局完成再贴底一次。
  useEffect(() => {
    stickRef.current = true;
    setShowJump(false);
    initialScrollRef.current = true;
    const timer = setTimeout(() => {
      initialScrollRef.current = false;
      scrollRef.current?.scrollToEnd({ animated: false });
    }, 160);
    return () => clearTimeout(timer);
  }, [sessionId]);

  const onChatScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const top = contentOffset.y;
    const distance = contentSize.height - top - layoutMeasurement.height;
    const scrolledUp = top < lastScrollTopRef.current - 2;
    lastScrollTopRef.current = top;
    if (scrolledUp) stickRef.current = false;
    else if (distance <= 48) stickRef.current = true;
    setShowJump((prev) => (distance <= 48 ? false : scrolledUp || distance > 120 ? true : prev));
  };

  // 只有首次加载或流式输出期间，尺寸变化才跟随贴底；静态展开折叠不触发。
  const onChatContentSizeChange = () => {
    if (!stickRef.current) return;
    if (!busyRef.current && !initialScrollRef.current) return;
    scrollRef.current?.scrollToEnd({ animated: false });
  };

  const jumpToLatest = () => {
    stickRef.current = true;
    setShowJump(false);
    scrollRef.current?.scrollToEnd({ animated: true });
  };

  return { scrollRef, showJump, onChatScroll, onChatContentSizeChange, jumpToLatest };
}
