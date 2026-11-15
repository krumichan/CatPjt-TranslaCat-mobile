import { useState } from "react";
import { FlatList, Keyboard, Modal, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Button } from "@/ui/components";
import { colors } from "@/ui/theme";

import {
  appliedBirthDate, birthDateCalendar, birthDateDraft, birthDateToday,
  changedBirthDateMonth, shiftedBirthDateMonth, type BirthDateParts,
} from "./birth-date-picker";

type PickerView = "year" | "month" | "day";
interface PickerState {
  maximum: BirthDateParts;
  date: BirthDateParts;
  hasSelection: boolean;
  view: PickerView;
}

export function BirthDateField({ value, onChange, disabled = false, error }: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  error?: string | null;
}) {
  const [picker, setPicker] = useState<PickerState | null>(null);
  const { fontScale, height } = useWindowDimensions();
  const yearRowHeight = Math.max(48, Math.ceil(24 * fontScale + 24));
  const selectionMinHeight = Math.min(144, Math.max(44, Math.floor(height * 0.2)));
  const close = () => setPicker(null);
  const open = () => {
    if (disabled) return;
    // 입력 중인 키보드를 닫고, 적용 전까지 부모의 생년월일은 바꾸지 않는다.
    Keyboard.dismiss();
    const maximum = birthDateToday(Date.now());
    const draft = birthDateDraft(value, maximum);
    setPicker({ maximum, ...draft, view: draft.hasSelection ? "day" : "year" });
  };
  const apply = () => {
    if (!picker || disabled) return;
    // 자정이 지난 채 열린 선택기도 기존 계약상 미래 날짜를 적용하지 않는다.
    const result = appliedBirthDate(picker.date, picker.hasSelection, birthDateToday(Date.now()));
    if (!result) return;
    onChange(result);
    close();
  };
  const selectMonth = (year: number, month: number, view: PickerView) => {
    setPicker(current => current && ({ ...current, view, date: changedBirthDateMonth(current.date, year, month, current.maximum) }));
  };
  const shiftMonth = (offset: -1 | 1) => {
    setPicker(current => {
      if (!current) return current;
      const next = shiftedBirthDateMonth(current.date, offset, current.maximum);
      return next ? { ...current, date: next, view: "day" } : current;
    });
  };
  const [year, month, day] = value.split("-").map(Number);
  const display = value ? `${year}년 ${month}월 ${day}일` : "날짜를 선택해 주세요";
  const previous = picker ? shiftedBirthDateMonth(picker.date, -1, picker.maximum) : null;
  const next = picker ? shiftedBirthDateMonth(picker.date, 1, picker.maximum) : null;

  return <View style={styles.field}>
    <Text style={styles.label}>생년월일</Text>
    <Pressable accessibilityRole="button" accessibilityLabel="생년월일" accessibilityValue={{ text: display }}
      accessibilityHint={error ?? "날짜 선택기를 열어요. 연도와 월을 고른 뒤 날짜를 선택해 주세요."}
      accessibilityState={{ disabled, expanded: picker !== null }} disabled={disabled} onPress={open}
      style={({ pressed }) => [styles.input, !!error && styles.invalidInput, disabled && styles.disabled, pressed && styles.pressed]}>
      <Text style={[styles.inputLabel, !value && styles.placeholder]}>{display}</Text>
      <Text style={styles.calendarMark} accessible={false}>▦</Text>
    </Pressable>
    {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
    <Modal visible={picker !== null} transparent animationType="fade" onRequestClose={close}>
      <SafeAreaView style={styles.overlay}>
        <View style={styles.dialog} accessibilityViewIsModal>
          <ScrollView style={styles.headingArea} contentContainerStyle={styles.heading}>
            <Text accessibilityRole="header" style={styles.title}>생년월일 선택</Text>
            <Text accessibilityLiveRegion="polite" style={styles.description}>
              {picker?.view === "year" ? "연도를 선택해 주세요." : picker?.view === "month" ? "월을 선택해 주세요."
                : picker?.hasSelection ? `${picker.date.year}년 ${picker.date.month}월 ${picker.date.day}일` : "날짜를 선택해 주세요."}
            </Text>
            {picker && <View style={styles.navigation}>
              <Pressable accessibilityRole="button" accessibilityLabel="이전 달" accessibilityState={{ disabled: !previous }}
                disabled={!previous} onPress={() => shiftMonth(-1)} style={[styles.arrow, !previous && styles.disabled]}>
                <Text style={styles.arrowText} accessible={false}>‹</Text>
              </Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel={`${picker.date.year}년, 연도 선택`}
                accessibilityState={{ expanded: picker.view === "year" }} onPress={() => setPicker({ ...picker, view: "year" })} style={styles.selectPeriod}>
                <Text style={styles.periodText}>{picker.date.year}년 ▾</Text>
              </Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel={`${picker.date.month}월, 월 선택`}
                accessibilityState={{ expanded: picker.view === "month" }} onPress={() => setPicker({ ...picker, view: "month" })} style={styles.selectPeriod}>
                <Text style={styles.periodText}>{picker.date.month}월 ▾</Text>
              </Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel="다음 달" accessibilityState={{ disabled: !next }}
                disabled={!next} onPress={() => shiftMonth(1)} style={[styles.arrow, !next && styles.disabled]}>
                <Text style={styles.arrowText} accessible={false}>›</Text>
              </Pressable>
            </View>}
          </ScrollView>
          {picker?.view === "year" ? <FlatList key="years" style={[styles.selectionArea, { minHeight: selectionMinHeight }]}
            data={Array.from({ length: picker.maximum.year }, (_, index) => picker.maximum.year - index)}
            keyExtractor={item => String(item)} initialScrollIndex={picker.maximum.year - picker.date.year}
            getItemLayout={(_data, index) => ({ length: yearRowHeight, offset: yearRowHeight * index, index })}
            renderItem={({ item }) => <Pressable accessibilityRole="button" accessibilityLabel={`${item}년`}
              accessibilityState={{ selected: item === picker.date.year }} onPress={() => selectMonth(item, picker.date.month, "month")}
              style={[styles.year, { height: yearRowHeight }, item === picker.date.year && styles.selected]}>
              <Text style={[styles.optionText, item === picker.date.year && styles.selectedText]}>{item}년</Text>
            </Pressable>} /> : <ScrollView style={[styles.selectionArea, { minHeight: selectionMinHeight }]} contentContainerStyle={styles.options}>
            {picker?.view === "month" ? <View style={styles.monthGrid}>
              {Array.from({ length: 12 }, (_, index) => index + 1).map(item => {
                const unavailable = picker.date.year === picker.maximum.year && item > picker.maximum.month;
                return <View key={item} style={styles.monthSlot}>
                  <Pressable accessibilityRole="button" accessibilityLabel={`${picker.date.year}년 ${item}월`}
                    accessibilityState={{ disabled: unavailable, selected: item === picker.date.month }} disabled={unavailable}
                    onPress={() => selectMonth(picker.date.year, item, "day")}
                    style={[styles.option, item === picker.date.month && styles.selected, unavailable && styles.disabled]}>
                    <Text style={[styles.optionText, item === picker.date.month && styles.selectedText]}>{item}월</Text>
                  </Pressable>
                </View>;
              })}
            </View> : picker && <>
              <View style={styles.weekdays} accessible={false}>
                {["일", "월", "화", "수", "목", "금", "토"].map(weekday => <Text key={weekday} style={styles.weekday}>{weekday}</Text>)}
              </View>
              <View style={styles.days}>
                {birthDateCalendar(picker.date, picker.maximum).map((cell, index) => <View key={index} style={styles.daySlot}>
                  {cell && <Pressable accessibilityRole="button"
                    accessibilityLabel={`${picker.date.year}년 ${picker.date.month}월 ${cell.day}일`}
                    accessibilityState={{ disabled: cell.disabled, selected: picker.hasSelection && picker.date.day === cell.day }}
                    disabled={cell.disabled} onPress={() => setPicker({ ...picker, date: { ...picker.date, day: cell.day }, hasSelection: true })}
                    style={[styles.option, { minHeight: Math.max(44, Math.ceil(24 * fontScale + 12)) },
                    picker.hasSelection && picker.date.day === cell.day && styles.selected, cell.disabled && styles.disabled]}>
                    <Text style={[styles.optionText, picker.hasSelection && picker.date.day === cell.day && styles.selectedText]}>{cell.day}</Text>
                  </Pressable>}
                </View>)}
              </View>
              <Text style={styles.hint}>오늘 이후 날짜는 선택할 수 없어요.</Text>
            </>}
          </ScrollView>}
          <ScrollView style={styles.footerArea} contentContainerStyle={styles.footer}>
            <View style={styles.action}><Button label="취소" secondary onPress={close} /></View>
            <View style={styles.action}><Button label="이 날짜로 선택" disabled={disabled || !picker?.hasSelection} onPress={apply} /></View>
          </ScrollView>
        </View>
      </SafeAreaView>
    </Modal>
  </View>;
}

const styles = StyleSheet.create({
  field: { gap: 8 },
  label: { color: colors.ink, fontSize: 14, lineHeight: 22, fontWeight: "700" },
  input: {
    flexDirection: "row", alignItems: "center", gap: 12, borderWidth: 1, borderColor: colors.blueLine,
    borderRadius: 12, minHeight: 54, backgroundColor: colors.surface, paddingHorizontal: 14, paddingVertical: 14
  },
  inputLabel: { color: colors.ink, fontSize: 16, lineHeight: 24, flex: 1 },
  placeholder: { color: colors.muted },
  calendarMark: { color: colors.blueDark, fontSize: 24, lineHeight: 28 },
  invalidInput: { borderColor: colors.danger, backgroundColor: colors.dangerSoft },
  error: { color: colors.danger, fontSize: 13, lineHeight: 22 },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.72 },
  overlay: { flex: 1, backgroundColor: "rgba(12, 28, 45, 0.4)", padding: 12, alignItems: "center", justifyContent: "center" },
  dialog: { width: "100%", maxWidth: 480, height: "90%", maxHeight: 680, backgroundColor: colors.surface, borderRadius: 24, overflow: "hidden" },
  // 큰 글꼴·작은 높이에서도 연·월과 동작을 스크롤로 읽으며 날짜 영역은 남겨 둔다.
  headingArea: { flexGrow: 0, flexShrink: 1, maxHeight: "48%" },
  heading: { padding: 16, gap: 8, borderBottomWidth: 1, borderColor: colors.line },
  title: { color: colors.ink, fontSize: 21, lineHeight: 30, fontWeight: "800" },
  description: { color: colors.muted, fontSize: 14, lineHeight: 22 },
  navigation: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 4 },
  arrow: { minWidth: 40, minHeight: 44, alignItems: "center", justifyContent: "center" },
  arrowText: { color: colors.blueDark, fontSize: 32, lineHeight: 36 },
  selectPeriod: { flexGrow: 1, paddingHorizontal: 6, paddingVertical: 10, minHeight: 44, alignItems: "center", justifyContent: "center" },
  periodText: { color: colors.blueDark, fontSize: 16, lineHeight: 24, fontWeight: "700", textAlign: "center" },
  selectionArea: { flexGrow: 1, flexShrink: 0, flexBasis: 0 },
  options: { padding: 12 },
  year: { justifyContent: "center", alignItems: "center", borderBottomWidth: 1, borderColor: colors.line, paddingHorizontal: 16 },
  monthGrid: { flexDirection: "row", flexWrap: "wrap" },
  monthSlot: { width: "33.333333%", padding: 4 },
  option: { minHeight: 48, justifyContent: "center", alignItems: "center", paddingVertical: 10, borderRadius: 12 },
  optionText: { color: colors.ink, fontSize: 16, lineHeight: 24, fontWeight: "600", textAlign: "center", flexShrink: 0 },
  selected: { backgroundColor: colors.blue },
  selectedText: { color: colors.surface },
  weekdays: { flexDirection: "row", paddingBottom: 8 },
  weekday: { width: "14.285714%", color: colors.muted, textAlign: "center", fontSize: 13, lineHeight: 22 },
  days: { flexDirection: "row", flexWrap: "wrap" },
  daySlot: { width: "14.285714%", padding: 1 },
  hint: { color: colors.muted, fontSize: 13, lineHeight: 22, textAlign: "center", marginTop: 12 },
  footerArea: { flexGrow: 0, flexShrink: 1, maxHeight: "40%" },
  footer: { padding: 16, borderTopWidth: 1, borderColor: colors.line, flexDirection: "row", gap: 8 },
  action: { flexGrow: 1, flexBasis: 0, minWidth: 0 },
});
