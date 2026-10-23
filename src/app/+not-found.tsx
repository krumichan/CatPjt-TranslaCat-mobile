import { useRouter } from "expo-router";

import { AppHeader, Button, InfoCard, PageHeading, Screen } from "@/ui/components";

export default function NotFoundScreen() {
  const router = useRouter();

  return (
    <Screen>
      <AppHeader />
      <PageHeading title="화면을 찾을 수 없어요" description="링크를 확인하거나 채팅 화면으로 이동해 주세요." />
      <Button label="채팅 화면으로" onPress={() => router.replace("/(tabs)")} />
      <InfoCard title="초대받은 대화방을 찾고 있나요?">
        공유받은 링크가 전체 주소인지 확인한 뒤 다시 열어 주세요.
      </InfoCard>
    </Screen>
  );
}
