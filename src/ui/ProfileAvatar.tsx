import { useState } from "react";
import { Image, StyleSheet, Text, View } from "react-native";

import { profileImageUrl } from "@/domain/chat/profile-image-url";

import { colors } from "./theme";

export function ProfileAvatar({ name, imageUrl, localUri, size = 44 }: {
  name: string; imageUrl?: string | null; localUri?: string | null; size?: number;
}) {
  const remote = profileImageUrl(imageUrl);
  const uri = localUri && /^(file|content):\/\//.test(localUri) ? localUri : remote;
  const [failed, setFailed] = useState<string | null>(null);
  const dimensions = { width: size, height: size, borderRadius: Math.round(size * 0.32) };

  return <View style={[styles.avatar, dimensions]} accessible={false}>
    {uri && uri !== failed ? (
      <Image source={{ uri }} style={dimensions} resizeMode="cover" onError={() => setFailed(uri)} />
    ) : <Text style={[styles.initial, { fontSize: Math.round(size * 0.42) }]}>{Array.from(name)[0] || "참"}</Text>}
  </View>;
}

const styles = StyleSheet.create({
  avatar: { flexShrink: 0, overflow: "hidden", backgroundColor: colors.blueSoft, alignItems: "center", justifyContent: "center" },
  initial: { color: colors.blueDark, fontWeight: "700" },
});
