// app/_lib/leave-allowance/engine.ts

export type LeaveAllowanceMonthInput = {
  // 例: 2025-10 の「給与総額」「出勤日数」
  ym: string; // "YYYY-MM"（監査ログ用）
  payTotalYen: number; // 給与総額（円）
  attendanceDays: number; // 出勤日数（日）
  calendarDays: number; // 暦日数（日）※UI側で年月から自動算出して渡す
};

export type LeaveAllowanceInput = {
  months: readonly [LeaveAllowanceMonthInput, LeaveAllowanceMonthInput, LeaveAllowanceMonthInput]; // 直近3カ月
  leaveDays: number; // 実休業日数
  rate: number; // 通常 0.6
};

export type LeaveAllowanceAudit = {
  version: string;
  // 入力
  months: LeaveAllowanceMonthInput[];
  leaveDays: number;
  rate: number;

  // 中間
  sumPayTotalYen: number;
  sumCalendarDays: number;
  sumAttendanceDays: number;

  formulaA_dailyWage: number; // A: 給与総額÷暦日数（3カ月合算）
  formulaB_dailyWage: number; // B: 給与総額÷出勤日数×0.6（3カ月合算）
  adoptedDailyWage: number; // max(A,B)

  // 結果
  allowancePerDayYen: number; // adoptedDailyWage×0.6
  allowanceTotalYen: number; // perDay×leaveDays
};

export type LeaveAllowanceResult = {
  adoptedDailyWageYen: number;     // 平均賃金（日額）
  allowancePerDayYen: number;      // 休業手当（日額）
  allowanceTotalYen: number;       // 最終総額
  audit: LeaveAllowanceAudit;      // 監査ログ（計算過程）
};

const rint = (n: number) => Math.round(Number.isFinite(n) ? n : 0);
const clamp0 = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0);

export function calcLeaveAllowance(input: LeaveAllowanceInput): LeaveAllowanceResult {
  const version = "leave-allowance-v1.0.0";

  const months = input.months.map((m) => ({
    ...m,
    payTotalYen: clamp0(Number(m.payTotalYen)),
    attendanceDays: clamp0(Number(m.attendanceDays)),
    calendarDays: clamp0(Number(m.calendarDays)),
  }));

  const leaveDays = clamp0(Number(input.leaveDays));
  const rate = Number.isFinite(input.rate) ? input.rate : 0.6;

  // 合算
  const sumPayTotalYen = rint(months.reduce((a, m) => a + m.payTotalYen, 0));
  const sumCalendarDays = rint(months.reduce((a, m) => a + m.calendarDays, 0));
  const sumAttendanceDays = rint(months.reduce((a, m) => a + m.attendanceDays, 0));

  // Excel式A: 給与総額 ÷ 暦日数
  const formulaA_dailyWage =
    sumCalendarDays > 0 ? rint(sumPayTotalYen / sumCalendarDays) : 0;

  // Excel式B: (給与総額 ÷ 出勤日数) × 0.6
  const formulaB_dailyWage =
    sumAttendanceDays > 0 ? rint((sumPayTotalYen / sumAttendanceDays) * rate) : 0;

  // 高い方採用
  const adoptedDailyWage = Math.max(formulaA_dailyWage, formulaB_dailyWage);

  // 休業手当（日額）= 平均賃金（日額）×0.6
  const allowancePerDayYen = rint(adoptedDailyWage * rate);

  // 最終総額
  const allowanceTotalYen = rint(allowancePerDayYen * leaveDays);

  const audit: LeaveAllowanceAudit = {
    version,
    months,
    leaveDays,
    rate,
    sumPayTotalYen,
    sumCalendarDays,
    sumAttendanceDays,
    formulaA_dailyWage,
    formulaB_dailyWage,
    adoptedDailyWage,
    allowancePerDayYen,
    allowanceTotalYen,
  };

  return {
    adoptedDailyWageYen: adoptedDailyWage,
    allowancePerDayYen,
    allowanceTotalYen,
    audit,
  };
}
