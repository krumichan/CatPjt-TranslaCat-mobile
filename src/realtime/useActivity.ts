import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";

export function useActivityGate() {
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(AppState.currentState === "active");
  const focusRef = useRef(false);
  useFocusEffect(useCallback(() => {
    focusRef.current = true;
    setFocused(true);
    return () => { focusRef.current = false; setFocused(false); };
  }, []));
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => setActive(state === "active"));
    return () => subscription.remove();
  }, []);
  // 타이머가 React의 다음 렌더 전에 실행되더라도 실제 앱·화면 상태로 읽음 요청을 막는다.
  const isActive = useCallback(() => focusRef.current && AppState.currentState === "active", []);
  return { active: focused && active, isActive };
}

export function useFocusedActive(): boolean {
  return useActivityGate().active;
}
