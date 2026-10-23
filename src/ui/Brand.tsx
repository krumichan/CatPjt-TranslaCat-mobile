import { useState } from "react";
import { Image, StyleSheet, View } from "react-native";

import { colors } from "@/ui/theme";

const wordmark = require("../../assets/brand/translacat-wordmark-light.png");
const catIcon = require("../../assets/brand/translacat-icon.png");

export function BrandWordmark({ width = 176 }: { width?: number }) {
  const [frameWidth, setFrameWidth] = useState(width);

  // 부모가 좁아져 로고 영역이 줄어도 측정한 너비로 동일한 웹 크롭 비율을 유지한다.
  // 이미지 높이를 명시해 웹이 PNG의 원본 높이 725px을 선택하지 않게 한다.
  const imageWidth = frameWidth * 1.05;
  const imageHeight = imageWidth * 725 / 2168;

  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel="TranslaCat"
      style={[styles.wordmarkFrame, { width }]}
      onLayout={({ nativeEvent }) => setFrameWidth(nativeEvent.layout.width)}
    >
      {/* 웹 BrandWordmark와 같은 원본·표시 비율로 투명 여백만 잘라낸다. */}
      <Image
        source={wordmark}
        resizeMode="contain"
        accessible={false}
        style={[
          styles.wordmark,
          { width: imageWidth, height: imageHeight, left: -frameWidth * 0.02, top: -(frameWidth / 4.5) * 0.18 },
        ]}
      />
    </View>
  );
}

export function BrandMark({ small = false }: { small?: boolean }) {
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel="TranslaCat 고양이"
      style={[styles.mark, small && styles.smallMark]}
    >
      <Image source={catIcon} resizeMode="contain" accessible={false} style={styles.cat} />
    </View>
  );
}

const styles = StyleSheet.create({
  wordmarkFrame: { aspectRatio: 9 / 2, maxWidth: "100%", overflow: "hidden", flexShrink: 1 },
  wordmark: { position: "absolute" },
  mark: { width: 76, height: 76, borderRadius: 38, backgroundColor: colors.blueSoft, overflow: "hidden" },
  smallMark: { width: 40, height: 40, borderRadius: 20 },
  cat: { width: "100%", height: "100%" },
});
