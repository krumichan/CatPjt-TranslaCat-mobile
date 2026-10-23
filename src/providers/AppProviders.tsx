import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { AuthProvider } from "@/auth/AuthProvider";
import { NotificationProvider } from "@/notifications/NotificationProvider";

export function AppProviders({ children }: { children: ReactNode }) {
  // 인증 및 전송 재시도는 후속 세션 경계에서 결정한다. 전역 자동 재전송은 사용하지 않는다.
  const [queryClient] = useState(() => new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 15_000 },
      mutations: { retry: false },
    },
  }));

  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <AuthProvider><NotificationProvider>{children}</NotificationProvider></AuthProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}
