export type EmploymentType = "monthly" | "daily" | "hourly";

export type PayrollInput = {
  year: number;
  month: number;

  breakdown: {
    legalWithinHours: number;
    legalOverHours: number;
    nightHours: number;
    holidayLegalHours: number;
    holidayNonLegalHours: number;
  };

  allowances: {
    manual: number;
  };

  // UI記録用（計算には使わない想定）
  attendanceDays?: number;
  absenceDays?: number;
  paidLeaveDays?: number;

  // 雇用形態入力
  workDays?: number;
  dailyHours?: number;
  baseWorkHours?: number;
};

export type EmployeePolicy = {
  name: string;
  employmentType: EmploymentType;

  baseSalaryYen: number;
  dailyWageYen: number;
  hourlyRateYen: number | null;

  fixedOtAllowanceYen: number;
  fixedOtHours: number;
};

export type PremiumTable = {
  legal_within: number;
  ot_0_60: number;
  ot_60_plus: number;
  holiday_legal: number;
  holiday_nonlegal: number;
  night: number;
};

export type CalcOptions = {
  fixedOtMode: "EXCESS_ONLY" | "DIFF_ALL_MINUS_FIXED";
  limits: {
    month45: number;
    year360: number;
    special75: number;
    special720: number;
    specialMaxTimes: number;
  };
};

export type PayrollResult = {
  grossYen: number;
  overtime: {
    fixedIncludedYen: number;
    detail: {
      legalWithin: number;
      otExtraOnly: number;
      holidayLegal: number;
      holidayNonLegal: number;
      night: number;
    };
    totals: {
      otHoursTotal: number;
    };
  };
  warnings: string[];
};

// ✅ 従業員型（税計算用フィールド含む）
export type Employee = {
  id: string;
  name: string;
  employment_type: EmploymentType;
  base_salary_yen: number;
  daily_wage_yen: number;
  hourly_rate_yen: number | null;
  fixed_ot_allowance_yen: number;
  fixed_ot_hours: number;
  effective_from: string;
  is_active: boolean;

  // 税計算用
  dependents_count: number;              // 扶養人数
  is_employment_insured: boolean;        // 雇用保険 対象/非対象（役員false）
  withholding_pay_type?: "ko" | "otsu"; // 将来用（今は ko 固定でOK）
  is_executive: boolean;                 // 役員フラグ
  employment_insurance_rate: number | null; // 個別料率（null=デフォルト）
};
