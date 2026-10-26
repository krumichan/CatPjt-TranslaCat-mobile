import test from "node:test";
import assert from "node:assert/strict";

import {
  appliedBirthDate, birthDateCalendar, birthDateDraft, birthDateMonthLength, birthDateText, birthDateToday,
  changedBirthDateMonth, parsedBirthDate, shiftedBirthDateMonth,
} from "../src/features/auth/birth-date-picker.ts";
import { validBirthDate } from "../src/features/auth/email-access-contracts.ts";

const now = Date.parse("2026-10-24T15:01:00+09:00");
const today = birthDateToday(now);

test("birthday picker keeps the existing year-one-to-UTC-today API range", () => {
  // 준비 및 실행: 서버 계약에 없는 1900년 하한이나 기기 현지 날짜를 새로 만들지 않는다.
  for (const value of ["0001-01-01", "0099-12-31", "1899-04-30", "2000-02-29", "2026-10-24"]) {
    const selected = parsedBirthDate(value, today);

    // 검증
    assert.ok(selected);
    assert.equal(birthDateText(selected), value);
    assert.equal(validBirthDate(value, now), true);
  }
  for (const value of ["0000-01-01", "2001-02-29", "2026-04-31", "2026-10-25", "2026-13-01", "2000-2-29", ""]) {
    assert.equal(parsedBirthDate(value, today), null);
  }
  assert.deepEqual(birthDateToday(Date.parse("2026-10-25T00:30:00+09:00")), { year: 2026, month: 10, day: 24 });
});

test("birthday picker has no implicit selection when first opened or cancelled", () => {
  // 준비: 부모의 빈 값과 기존 값을 서로 다른 임시 선택으로 연다.
  const original = "";
  const empty = birthDateDraft(original, today);
  const existing = birthDateDraft("2000-02-29", today);

  // 실행: 모달 안에서 연·월만 바꾸고 적용하거나, 기존 선택을 편집하다 취소한다.
  const tentative = changedBirthDateMonth(empty.date, 1995, 3, today);
  const discarded = changedBirthDateMonth(existing.date, 2001, 2, today);

  // 검증: 일자를 명시적으로 고르기 전에는 반환값이 없고 기존 원본·draft는 변하지 않는다.
  assert.equal(empty.hasSelection, false);
  assert.equal(appliedBirthDate(tentative, empty.hasSelection, today), null);
  assert.equal(original, "");
  assert.deepEqual(existing.date, { year: 2000, month: 2, day: 29 });
  assert.deepEqual(discarded, { year: 2001, month: 2, day: 28 });
  assert.equal(appliedBirthDate(existing.date, existing.hasSelection, today), "2000-02-29");
  assert.equal(appliedBirthDate({ ...tentative, day: 21 }, true, today), "1995-03-21");
});

test("birthday year and month changes clamp leap days and month ends without rollover", () => {
  // 실행 및 검증: 윤년의 세기 예외와 31일·오늘 경계를 확인한다.
  assert.equal(birthDateMonthLength(1900, 2), 28);
  assert.equal(birthDateMonthLength(2000, 2), 29);
  assert.equal(birthDateMonthLength(2024, 2), 29);
  assert.equal(birthDateMonthLength(2100, 2), 28);
  assert.deepEqual(changedBirthDateMonth({ year: 2000, month: 2, day: 29 }, 2001, 2, today), { year: 2001, month: 2, day: 28 });
  assert.deepEqual(changedBirthDateMonth({ year: 1995, month: 1, day: 31 }, 1995, 4, today), { year: 1995, month: 4, day: 30 });
  assert.deepEqual(changedBirthDateMonth({ year: 2020, month: 12, day: 31 }, 2026, 12, today), today);
  assert.equal(shiftedBirthDateMonth({ year: 1, month: 1, day: 1 }, -1, today), null);
  assert.equal(shiftedBirthDateMonth(today, 1, today), null);
  assert.deepEqual(shiftedBirthDateMonth({ year: 2023, month: 12, day: 31 }, 1, today), { year: 2024, month: 1, day: 31 });
});

test("birthday calendar preserves real early-year weekdays and disables every future day", () => {
  // 실행: 1년 1월은 월요일에 시작하고 윤년 2월은 29일까지 표시한다.
  const firstYear = birthDateCalendar({ year: 1, month: 1, day: 1 }, today);
  const leapMonth = birthDateCalendar({ year: 2000, month: 2, day: 1 }, today);
  const currentMonth = birthDateCalendar(today, today);

  // 검증: 빈 칸은 날짜가 아니며, 표시된 날짜도 최종 적용에서 미래일을 허용하지 않는다.
  assert.equal(firstYear[0], null);
  assert.deepEqual(firstYear[1], { day: 1, disabled: false });
  assert.equal(firstYear.filter(Boolean).length, 31);
  assert.equal(leapMonth.filter(Boolean).length, 29);
  assert.equal(currentMonth.length % 7, 0);
  for (const cell of currentMonth) {
    if (!cell) continue;
    assert.equal(cell.disabled, cell.day > 24);
    const result = appliedBirthDate({ ...today, day: cell.day }, true, today);
    assert.equal(result !== null, cell.day <= 24);
    if (result) assert.equal(validBirthDate(result, now), true);
  }
});
