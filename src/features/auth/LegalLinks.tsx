import { useState } from "react";
import { Linking, StyleSheet, Text, View } from "react-native";

import { Button } from "@/ui/components";
import { colors } from "@/ui/theme";

import { policyLinks, publicPolicyUrl } from "./policy-links";

export function LegalLinks() {
  const [error, setError] = useState<string | null>(null);
  const terms = publicPolicyUrl(policyLinks.terms);
  const privacy = publicPolicyUrl(policyLinks.privacy);
  const open = async (url: string | null) => {
    if (!url) return;
    setError(null);
    try {
      await Linking.openURL(url);
    } catch {
      setError("문서를 열지 못했어요. 브라우저 연결을 확인해 주세요.");
    }
  };

  return (
    <View style={styles.container}>
      <Button label="이용약관" secondary disabled={!terms} onPress={() => void open(terms)} />
      <Button label="개인정보처리방침" secondary disabled={!privacy} onPress={() => void open(privacy)} />
      {(!terms || !privacy) && <Text style={styles.help}>공개 문서 주소를 확인하고 있어요. 확인되면 여기서 열 수 있어요.</Text>}
      {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: 12, paddingVertical: 20 },
  help: { color: colors.muted, fontSize: 12, lineHeight: 21 },
  error: { color: colors.danger, fontSize: 13, lineHeight: 22 },
});
