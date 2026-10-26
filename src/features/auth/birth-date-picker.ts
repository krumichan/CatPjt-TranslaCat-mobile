export interface BirthDateParts {
  year: number;
  month: number;
  day: number;
}

export function birthDateText(date: BirthDateParts): string {
  return `${String(date.year).padStart(4, "0")}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
}

export function birthDateToday(now: number): BirthDateParts {
  // 서버 계약과 같은 UTC 날짜를 사용해 기기 시간대 때문에 미래일이 제출되지 않게 한다.
  const date = new Date(now);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

export function birthDateMonthLength(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

export function parsedBirthDate(value: string, maximum: BirthDateParts): BirthDateParts | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > birthDateMonthLength(year, month)) return null;
  return value <= birthDateText(maximum) ? { year, month, day } : null;
}

export function changedBirthDateMonth(date: BirthDateParts, year: number, month: number, maximum: BirthDateParts): BirthDateParts {
  // 연·월을 바꿔도 윤일이나 31일이 다음 달로 넘어가지 않게 해당 달 안에서 줄인다.
  const nextYear = Math.min(maximum.year, Math.max(1, year));
  const lastMonth = nextYear === maximum.year ? maximum.month : 12;
  const nextMonth = Math.min(lastMonth, Math.max(1, month));
  const lastDay = nextYear === maximum.year && nextMonth === maximum.month
    ? maximum.day : birthDateMonthLength(nextYear, nextMonth);
  return { year: nextYear, month: nextMonth, day: Math.min(date.day, lastDay) };
}

export function shiftedBirthDateMonth(date: BirthDateParts, offset: -1 | 1, maximum: BirthDateParts): BirthDateParts | null {
  const index = date.year * 12 + date.month - 1 + offset;
  const year = Math.floor(index / 12);
  const month = index % 12 + 1;
  if (year < 1 || year > maximum.year || year === maximum.year && month > maximum.month) return null;
  return changedBirthDateMonth(date, year, month, maximum);
}

export function birthDateCalendar(date: BirthDateParts, maximum: BirthDateParts): ({ day: number; disabled: boolean } | null)[] {
  // Date.UTC(0~99년)의 1900년 보정 없이 실제 연도와 요일을 계산한다.
  const first = new Date(0);
  first.setUTCFullYear(date.year, date.month - 1, 1);
  first.setUTCHours(0, 0, 0, 0);
  const leading = first.getUTCDay();
  const length = birthDateMonthLength(date.year, date.month);
  const total = Math.ceil((leading + length) / 7) * 7;
  return Array.from({ length: total }, (_, index) => {
    const day = index - leading + 1;
    return day < 1 || day > length ? null : { day, disabled: birthDateText({ ...date, day }) > birthDateText(maximum) };
  });
}

export function birthDateDraft(value: string, maximum: BirthDateParts) {
  const selected = parsedBirthDate(value, maximum);
  return { date: selected ?? maximum, hasSelection: selected !== null };
}

export function appliedBirthDate(date: BirthDateParts, hasSelection: boolean, maximum: BirthDateParts): string | null {
  // 빈 입력은 달력을 열었다는 이유만으로 오늘 날짜가 되지 않는다.
  return hasSelection && parsedBirthDate(birthDateText(date), maximum) ? birthDateText(date) : null;
}
