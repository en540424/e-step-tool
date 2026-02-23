// app/_lib/payroll/engine.ts
import type {
  CalcOptions,
  EmployeePolicy,
  PayrollInput,
  PremiumTable,
  PayrollResult,
} from "./types";

const rint = (n: number) => Math.round(Number.isFinite(n) ? n : 0);

function hourlyBase(emp: EmployeePolicy): number {
  // hourlyRateYen は「時間単価（基礎）」として扱う（残業単価ではない）
  return Number(emp.hourlyRateYen ?? 0);
}

function basePayOnly(emp: EmployeePolicy, input: PayrollInput): number {
  // ✅ 固定残業代はここでは含めない（別枠で足す）
  if (emp.employmentType === "daily") {
    return rint((emp.dailyWageYen ?? 0) * (input.workDays ?? 0));
  }
  if (emp.employmentType === "hourly") {
    return rint((emp.hourlyRateYen ?? 0) * (input.baseWorkHours ?? 0));
  }
  return rint(emp.baseSalaryYen ?? 0);
}

function payByHoursFull(hour: number, hours: number, premiumRate: number): number {
  // ✅ “割増込みの支給額” を返す（= hour * hours * (1 + rate)）
  // 例：25% → 1.25倍
  return rint(hour * hours * (1 + (premiumRate ?? 0)));
}

export function calcPayroll(
  emp: EmployeePolicy,
  input: PayrollInput,
  premiums: PremiumTable,
  opts: CalcOptions
): PayrollResult {
  const b = input.breakdown;
  const hour = hourlyBase(emp);

  // 1) 基本給（固定残業代を除く）
  const base = basePayOnly(emp, input);

  // 2) 固定残業代（通知書どおりの「固定支給」）
  const fixedIncludedYen = rint(emp.fixedOtAllowanceYen ?? 0);

  // 3) 実残業（カテゴリ別：割増込み額）
  const legalWithin = payByHoursFull(hour, b.legalWithinHours, premiums.legal_within);
  const ot0_60 = payByHoursFull(hour, b.legalOverHours, premiums.ot_0_60); // 0-60
  // ※60h超を分けたいなら input 側に「ot60plusHours」を追加する（今はUIが無いので未対応）
  const holidayLegal = payByHoursFull(hour, b.holidayLegalHours, premiums.holiday_legal);
  const holidayNonLegal = payByHoursFull(
    hour,
    b.holidayNonLegalHours,
    premiums.holiday_nonlegal
  );
  const night = payByHoursFull(hour, b.nightHours, premiums.night);

  const overtimeTotalAll = rint(legalWithin + ot0_60 + holidayLegal + holidayNonLegal + night);

  // 4) 固定残業との調整
  // - EXCESS_ONLY: 「固定を超えた分だけ追加」
  // - DIFF_ALL_MINUS_FIXED: 「実残業に置き換え（固定との差額で調整）」→ 実残業が固定より少ないと減額になり得る
  let overtimeAdjustYen = 0;
  if (opts.fixedOtMode === "EXCESS_ONLY") {
    overtimeAdjustYen = Math.max(overtimeTotalAll - fixedIncludedYen, 0);
  } else {
    overtimeAdjustYen = overtimeTotalAll - fixedIncludedYen;
  }

  // 5) 手入力手当（給与計算ページ側で template も足す設計だが、エンジン内は manual だけ）
  const manualAllowance = rint(input.allowances?.manual ?? 0);

  // 6) 総支給（エンジン分）
  // ✅ 固定残業代は “支給予定” として必ず足す。その上で差額調整する。
  const grossYen = rint(base + fixedIncludedYen + overtimeAdjustYen + manualAllowance);

  // 7) 警告（最低限：時間外の合計）
  const warnings: string[] = [];
  const otHoursTotal = rint((b.legalWithinHours ?? 0) + (b.legalOverHours ?? 0));

  const limit45 = opts.limits?.month45 ?? 45;
  if (otHoursTotal > limit45) {
    warnings.push(`月の時間外が ${otHoursTotal}h です（上限 ${limit45}h 超過）`);
  }

  // UIは「時間外（超過分のみ）」として otExtraOnly を見ているので、ここは “調整後の追加分” を表示する
  const otExtraOnly = rint(overtimeAdjustYen);

  return {
    grossYen,
    overtime: {
      fixedIncludedYen,
      detail: {
        legalWithin,
        otExtraOnly,
        holidayLegal,
        holidayNonLegal,
        night,
      },
      totals: { otHoursTotal },
    },
    warnings,
  };
}

// page.tsx が PremiumTable を import しているので再export
export type { PremiumTable } from "./types";

/**
 * 雇用保険料の自動計算
 * - isInsured = false（役員など）なら 0
 * - 対象なら grossTaxableYen × rate を四捨五入
 */
export function calcEmploymentInsuranceYen(
  grossTaxableYen: number,
  rate: number,
  isInsured: boolean
): number {
  if (!isInsured) return 0;
  if (!Number.isFinite(grossTaxableYen) || grossTaxableYen <= 0) return 0;
  if (!Number.isFinite(rate) || rate <= 0) return 0;

  return Math.round(grossTaxableYen * rate);
}
