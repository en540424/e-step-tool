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
