// app/payroll/page.tsx
"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { getSupabaseClient } from "@/app/_lib/supabase/client";
import { calcPayroll, PremiumTable } from "@/app/_lib/payroll/engine";
import type { PayrollInput, EmployeePolicy, EmploymentType } from "@/app/_lib/payroll/types";

type EmployeeRow = {
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
};

type PayrollItemRow = {
  id: string;
  name: string;
  kind: "allowance" | "deduction";
  calc_type: "fixed" | "rate_of_gross" | "rate_of_base" | "manual";
  params: any;
  order_index: number;
  is_active: boolean;
};

function toNum(v: string) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function calcPayrollItemYen(opts: {
  item: PayrollItemRow;
  gross: number;
  base: number;
  manualValue?: number; // manual用
}) {
  const { item, gross, base, manualValue } = opts;
  const p = item.params ?? {};

  let v = 0;

  if (item.calc_type === "fixed") {
    v = Number(p.amount_yen ?? 0);
  } else if (item.calc_type === "rate_of_gross") {
    const rate = Number(p.rate ?? 0);
    v = gross * rate;
  } else if (item.calc_type === "rate_of_base") {
    const rate = Number(p.rate ?? 0);
    v = base * rate;
  } else if (item.calc_type === "manual") {
    v = Number(manualValue ?? 0);
  }

  const cap = Number(p.cap_yen ?? 0);
  if (cap > 0) v = Math.min(v, cap);

  return Math.round(v);
}

function currentYYYYMM() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

/** 画面側でも “ベース給” を計算（控除テンプレの rate_of_base で使う） */
function calcBasePayYenForUI(
  emp: EmployeeRow | null,
  workDays: number,
  baseWorkHours: number
) {
  if (!emp) return 0;

  if (emp.employment_type === "daily") {
    return Math.round((emp.daily_wage_yen || 0) * (workDays || 0));
  }

  if (emp.employment_type === "hourly") {
    const hr = Number(emp.hourly_rate_yen || 0);
    return Math.round(hr * (baseWorkHours || 0));
  }

  return Math.round(emp.base_salary_yen || 0);
}

type DeductionRow = {
  id: string;
  label: string;
  yen: number;
  category?: "social" | "tax" | "custom";
  isRecurring?: boolean;
  source?: "auto" | "manual";
};

const defaultDeductionRows: DeductionRow[] = [
  { id: "health", label: "健康保険料", yen: 0, category: "social" },
  { id: "union", label: "組合費", yen: 0, category: "custom", isRecurring: true },
  { id: "pension", label: "厚生年金保険料", yen: 0, category: "social" },
  { id: "employment", label: "雇用保険料", yen: 0, category: "social" },
  { id: "income_tax", label: "所得税", yen: 0, category: "tax" },
  { id: "resident_tax", label: "住民税", yen: 0, category: "tax", isRecurring: true },
];

function mergeDeductionRows(defaults: DeductionRow[], saved: DeductionRow[]) {
  const map = new Map(saved.map((r) => [r.id, r]));
  const merged = defaults.map((d) => {
    const s = map.get(d.id);
    return s
      ? {
          ...d,
          label: s.label ?? d.label,
          yen: Number(s.yen ?? 0),
          category: s.category ?? d.category,
          isRecurring: s.isRecurring ?? d.isRecurring,
          source: s.source ?? d.source,
        }
      : d;
  });

  const defaultIds = new Set(defaults.map((d) => d.id));
  const customs = saved
    .filter((s) => s && typeof s.id === "string" && !defaultIds.has(s.id))
    .map((s) => ({
      id: String(s.id),
      label: String(s.label ?? "追加控除"),
      yen: Number(s.yen ?? 0),
      category: s.category ?? "custom",
      isRecurring: Boolean(s.isRecurring),
      source: s.source === "auto" || s.source === "manual" ? s.source : undefined,
    }));

  return [...merged, ...customs];
}

function prevYYYYMM(ym: string) {
  const [yStr, mStr] = ym.split("-");
  const y = Number(yStr);
  const m = Number(mStr);
  if (!y || !m) return null;
  const d = new Date(y, m - 1, 1);
  d.setMonth(d.getMonth() - 1);
  const yy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${yy}-${mm}`;
}

function pickRecurringRows(rows: DeductionRow[]) {
  return rows
    .filter((r) => r && r.isRecurring && Number(r.yen || 0) !== 0)
    .map((r) => ({
      id: r.id,
      label: r.label,
      yen: Number(r.yen || 0),
      isRecurring: true,
    }));
}

function applyRecurringIntoDefaults(
  defaults: DeductionRow[],
  recurring: DeductionRow[]
) {
  const map = new Map(recurring.map((r) => [r.id, r]));
  return defaults.map((d) => {
    const r = map.get(d.id);
    if (!r) return d;
    return { ...d, yen: r.yen, isRecurring: true, label: r.label ?? d.label };
  });
}

function DeductionRowsEditor({
  rows,
  onChange,
}: {
  rows: DeductionRow[];
  onChange: (rows: DeductionRow[]) => void;
}) {
  const updateYen = (id: string, yen: number) => {
    onChange(
      rows.map((r) => (r.id === id ? { ...r, yen, source: "manual" } : r))
    );
  };

  const updateLabel = (id: string, label: string) => {
    onChange(
      rows.map((r) =>
        r.id === id ? { ...r, label, source: "manual" } : r
      )
    );
  };

  const addRow = () => {
    const id =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `custom_${Date.now()}`;
    onChange([...rows, { id, label: "追加控除", yen: 0, source: "manual" }]);
  };

  const removeRow = (id: string) => {
    const fixedIds = new Set([
      "health",
      "union",
      "pension",
      "employment",
      "income_tax",
      "resident_tax",
    ]);
    if (fixedIds.has(id)) return;
    onChange(rows.filter((r) => r.id !== id));
  };

  return (
    <div className="space-y-3">
      <div className="text-sm font-semibold">控除（内訳）</div>

      <div className="space-y-2">
        {rows.map((r) => (
          <div key={r.id} className="space-y-1">
            <div className="grid grid-cols-[minmax(160px,1fr)_140px_110px_32px] gap-2 items-center">
              <input
                className="w-full rounded-md border px-3 py-2 text-sm whitespace-normal break-words"
                value={r.label}
                onChange={(e) => updateLabel(r.id, e.target.value)}
              />
              <input
                className="w-full rounded-md border px-3 py-2 text-sm text-right"
                inputMode="numeric"
                value={Number.isFinite(r.yen) ? r.yen : 0}
                onChange={(e) => updateYen(r.id, Number(e.target.value || 0))}
              />
              <label className="flex items-center justify-start pl-2">
                <input
                  type="checkbox"
                  checked={!!r.isRecurring}
                  onChange={(e) =>
                    onChange(
                      rows.map((x) =>
                        x.id === r.id ? { ...x, isRecurring: e.target.checked } : x
                      )
                    )
                  }
                />
              </label>
              <button
                type="button"
                className="rounded-md border px-2 py-2 text-xs"
                onClick={() => removeRow(r.id)}
                title="削除（追加した行のみ）"
              >
                ×
              </button>
            </div>
            {r.isRecurring && (
              <div className="text-[11px] text-gray-500 pl-1">
                ※ ☑毎月控除（次月に引き継ぐ）
              </div>
            )}
          </div>
        ))}
      </div>

      <button
        type="button"
        className="w-full rounded-md border px-3 py-2 text-sm"
        onClick={addRow}
      >
        ＋控除を追加
      </button>
    </div>
  );
}

export default function PayrollPage() {
  // ✅ env未設定でもクラッシュさせない（nullで画面にメッセージ表示）
  const sb = useMemo(() => {
    try {
      return getSupabaseClient();
    } catch {
      return null;
    }
  }, []);

  const [employees, setEmployees] = useState<EmployeeRow[]>([]);
  const [items, setItems] = useState<PayrollItemRow[]>([]);
  const [premiums, setPremiums] = useState<PremiumTable | null>(null);
  const [rules, setRules] = useState<any>(null);

  const [employeeId, setEmployeeId] = useState<string>("");
  const [ym, setYm] = useState(currentYYYYMM());

  // ✅ 固定残業の扱い方式（Payroll画面で切替）
  const [fixedOtMode, setFixedOtMode] = useState<
    "EXCESS_ONLY" | "DIFF_ALL_MINUS_FIXED"
  >("EXCESS_ONLY");

  // ✅ 雇用形態用の入力（必要分だけ）
  const [workDays, setWorkDays] = useState(0);
  const [baseWorkHours, setBaseWorkHours] = useState(0);
  const [dailyHours, setDailyHours] = useState(8);

  // ✅ 勤怠状況（確認用・計算しない）
  const [attendanceDays, setAttendanceDays] = useState(0); // 出勤日数（確認用）
  const [absenceDays, setAbsenceDays] = useState(0); // 欠勤
  const [paidLeaveDays, setPaidLeaveDays] = useState(0); // 有給

  // 勤怠内訳（時間）
  const [legalWithin, setLegalWithin] = useState(0);
  const [legalOver, setLegalOver] = useState(0);
  const [night, setNight] = useState(0);
  const [holidayLegal, setHolidayLegal] = useState(0);
  const [holidayNonLegal, setHolidayNonLegal] = useState(0);

  // 手当・控除
  const [manualAllowance, setManualAllowance] = useState(0);
  const [deductionRows, setDeductionRows] = useState<DeductionRow[]>(defaultDeductionRows);

  const [loading, setLoading] = useState(true);
  const [bootError, setBootError] = useState<string | null>(null);

  // ✅ 選択中従業員
  const selectedEmp = useMemo(
    () => employees.find((e) => e.id === employeeId) ?? null,
    [employees, employeeId]
  );

  // ✅ 休業手当ページからの引き継ぎ（手当へ自動反映 + 対象月も反映）
  useEffect(() => {
    const v = sessionStorage.getItem("leave_allowance_total_yen");
    if (v) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) setManualAllowance(n);
    }

    const targetYm = sessionStorage.getItem("leave_allowance_target_ym");
    if (targetYm) setYm(targetYm);

    sessionStorage.removeItem("leave_allowance_total_yen");
    sessionStorage.removeItem("leave_allowance_target_ym");
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!employeeId || !ym) return;

    const key = `payroll_deduction_rows:${employeeId}:${ym}`;
    const raw = localStorage.getItem(key);

    // ① 当月データがあるなら優先復元
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as DeductionRow[];
        if (Array.isArray(parsed)) {
          setDeductionRows(mergeDeductionRows(defaultDeductionRows, parsed));
          return;
        }
      } catch {
        // fallthrough
      }
      setDeductionRows(defaultDeductionRows);
      return;
    }

    // ② 当月が無い → 前月の固定行だけ引き継ぐ
    const prev = prevYYYYMM(ym);
    if (prev) {
      const prevKey = `payroll_deduction_rows:${employeeId}:${prev}`;
      const prevRaw = localStorage.getItem(prevKey);
      if (prevRaw) {
        try {
          const prevParsed = JSON.parse(prevRaw) as DeductionRow[];
          if (Array.isArray(prevParsed)) {
            const recurring = pickRecurringRows(prevParsed);
            const seeded = applyRecurringIntoDefaults(
              defaultDeductionRows,
              recurring
            );
            setDeductionRows(seeded);
            return;
          }
        } catch {
          // ignore
        }
      }
    }

    // ③ 何も無い
    setDeductionRows(defaultDeductionRows);
  }, [employeeId, ym]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!employeeId || !ym) return;

    const key = `payroll_deduction_rows:${employeeId}:${ym}`;
    localStorage.setItem(key, JSON.stringify(deductionRows));
  }, [employeeId, ym, deductionRows]);

  // ✅ 初期ロード
  useEffect(() => {
    (async () => {
      setBootError(null);

      if (!sb) {
        setLoading(false);
        setBootError(
          "Supabase 未設定です（.env.local を設定して再起動してください）"
        );
        return;
      }

      setLoading(true);

      const [
        { data: emp, error: empErr },
        { data: its, error: itsErr },
        { data: prs, error: prsErr },
        { data: wr, error: wrErr },
      ] = await Promise.all([
        sb
          .from("employees")
          .select(
            "id,name,employment_type,base_salary_yen,daily_wage_yen,hourly_rate_yen,fixed_ot_allowance_yen,fixed_ot_hours,effective_from,is_active"
          )
          .eq("is_active", true)
          .order("name"),
        sb.from("payroll_items").select("*").eq("is_active", true).order("order_index"),
        sb.from("premiums").select("key,rate,note"),
        sb
          .from("work_rules")
          .select("*")
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);

      const errs = [empErr, itsErr, prsErr, wrErr].filter(Boolean) as any[];
      if (errs.length > 0) {
        setLoading(false);
        setBootError(errs.map((e) => e.message).join(" / "));
        return;
      }

      setEmployees((emp ?? []) as any);
      setItems((its ?? []) as any);
      setRules(wr ?? null);

      const map: Record<string, number> = {};
      for (const r of (prs ?? []) as any[]) map[r.key] = Number(r.rate);

      setPremiums({
        legal_within: map.legal_within ?? 0,
        ot_0_60: map.ot_0_60 ?? 0.25,
        ot_60_plus: map.ot_60_plus ?? 0.5,
        holiday_legal: map.holiday_legal ?? 0.35,
        holiday_nonlegal: map.holiday_nonlegal ?? 0.25,
        night: map.night ?? 0.25,
      });

      setLoading(false);
    })();
  }, [sb]);

  // ✅ 従業員選択時：必要入力の初期値を入れる
  useEffect(() => {
    if (!selectedEmp) return;

    if (selectedEmp.employment_type === "daily") {
      if (workDays === 0) setWorkDays(22);
      if (!dailyHours) setDailyHours(8);
    }
    if (selectedEmp.employment_type === "hourly") {
      if (baseWorkHours === 0) setBaseWorkHours(160);
    }

    // ✅ 勤怠状況（確認用）の初期値（見やすい仮）
    if (attendanceDays === 0)
      setAttendanceDays(selectedEmp.employment_type === "daily" ? 22 : 20);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedEmp?.id]);

  const input: PayrollInput | null = useMemo(() => {
    if (!selectedEmp) return null;
    const [y, m] = ym.split("-").map((x) => Number(x));
    if (!y || !m) return null;

    const base: PayrollInput = {
      year: y,
      month: m,
      breakdown: {
        legalWithinHours: legalWithin,
        legalOverHours: legalOver,
        nightHours: night,
        holidayLegalHours: holidayLegal,
        holidayNonLegalHours: holidayNonLegal,
      },
      allowances: {
        manual: manualAllowance,
      },

      // ✅ 確認用（エンジンで使わない前提）
      attendanceDays,
      absenceDays,
      paidLeaveDays,
    };

    if (selectedEmp.employment_type === "daily") {
      base.workDays = workDays;
      base.dailyHours = dailyHours || 8;
    } else if (selectedEmp.employment_type === "hourly") {
      base.baseWorkHours = baseWorkHours;
    }

    return base;
  }, [
    selectedEmp,
    ym,
    legalWithin,
    legalOver,
    night,
    holidayLegal,
    holidayNonLegal,
    manualAllowance,
    workDays,
    baseWorkHours,
    dailyHours,
    attendanceDays,
    absenceDays,
    paidLeaveDays,
  ]);

  const empPolicy: EmployeePolicy | null = useMemo(() => {
    if (!selectedEmp) return null;

    return {
      name: selectedEmp.name,
      employmentType: selectedEmp.employment_type,
      baseSalaryYen: selectedEmp.base_salary_yen,
      dailyWageYen: selectedEmp.daily_wage_yen,
      hourlyRateYen: selectedEmp.hourly_rate_yen,
      fixedOtAllowanceYen: selectedEmp.fixed_ot_allowance_yen,
      fixedOtHours: Number(selectedEmp.fixed_ot_hours),
    };
  }, [selectedEmp]);

  const result = useMemo(() => {
    if (!empPolicy || !input || !premiums) return null;

    return calcPayroll(empPolicy, input, premiums, {
      fixedOtMode,
      limits: {
        month45: rules?.limit_monthly_ot_hours ?? 45,
        year360: rules?.limit_yearly_ot_hours ?? 360,
        special75: rules?.special_monthly_ot_hours ?? 75,
        special720: rules?.special_yearly_ot_hours ?? 720,
        specialMaxTimes: rules?.special_monthly_max_times ?? 6,
      },
    });
  }, [empPolicy, input, premiums, rules, fixedOtMode]);

  const basePayYenForDeduction = useMemo(() => {
    return calcBasePayYenForUI(selectedEmp, workDays, baseWorkHours);
  }, [selectedEmp, workDays, baseWorkHours]);

  /**
   * ✅ テンプレ手当（payroll_items.kind==="allowance"）
   * - manualAllowance は「手入力」なのでここでは足さない（総支給側で合算）
   */
  const computedAllowances = useMemo(() => {
    if (!result) return { total: 0, detail: {} as Record<string, number> };

    const gross = result.grossYen;
    const base = basePayYenForDeduction;

    let total = 0;
    const detail: Record<string, number> = {};

    const allowances = items.filter((x) => x.kind === "allowance");
    for (const a of allowances) {
      const v = calcPayrollItemYen({
        item: a,
        gross,
        base,
        // テンプレ側で manual を使うなら、ここに値を渡す設計にする
        manualValue: 0,
      });
      detail[a.name] = v;
      total += v;
    }

    return { total, detail };
  }, [items, result, basePayYenForDeduction]);

  /**
   * ✅ 総支給（エンジン + テンプレ手当 + 手入力手当）
   */
  const grossWithTemplates = useMemo(() => {
    if (!result) return 0;
    return result.grossYen + computedAllowances.total + manualAllowance;
  }, [result, computedAllowances.total, manualAllowance]);

  const manualDeductionTotal = useMemo(() => {
    return deductionRows.reduce((sum, r) => sum + (r.yen || 0), 0);
  }, [deductionRows]);

  /**
   * ✅ 控除（テンプレ控除 + 手入力控除）
   */
  const computedDeductions = useMemo(() => {
    if (!result) return { total: 0, detail: {} as Record<string, number> };

    const gross = grossWithTemplates; // ←控除が gross 参照のとき「手当反映後」を基準にしたいならこちら
    const base = basePayYenForDeduction;

    let total = 0;
    const detail: Record<string, number> = {};

    const deductions = items.filter((x) => x.kind === "deduction");
    for (const d of deductions) {
      const v = calcPayrollItemYen({
        item: d,
        gross,
        base,
        manualValue: 0,
      });
      detail[d.name] = v;
      total += v;
    }

    if (manualDeductionTotal > 0) {
      detail["手入力控除"] = manualDeductionTotal;
      total += manualDeductionTotal;
    }

    return { total, detail };
  }, [items, result, manualDeductionTotal, basePayYenForDeduction, grossWithTemplates]);

  async function saveRun() {
    if (!sb) return alert("Supabase 未設定です（.env.local を確認）");
    if (!result || !input || !empPolicy) return;
    if (!employeeId) return alert("従業員を選択してください");

    const payload = {
      employee_id: employeeId,
      year: input.year,
      month: input.month,
      engine_version: "v1.0.0",
      deduction_rows: deductionRows,
      input: { ...input, manualDeduction: manualDeductionTotal },
      result: {
        ...result,
        grossWithTemplatesYen: grossWithTemplates,
        allowances: {
          templateTotalYen: computedAllowances.total,
          templateDetail: computedAllowances.detail,
          manualYen: manualAllowance,
        },
        deductions: {
          totalYen: computedDeductions.total,
          detail: computedDeductions.detail,
        },
        netYen: grossWithTemplates - computedDeductions.total,
      },
    };

    let { error } = await sb.from("payroll_runs").upsert(payload as any, {
      onConflict: "employee_id,year,month",
    });

    if (error) {
      const msg = error.message || "";
      const maybeMissingColumn =
        msg.includes("deduction_rows") || msg.toLowerCase().includes("column");

      if (maybeMissingColumn) {
        const { deduction_rows, ...payload2 } = payload as any;
        const retry = await sb.from("payroll_runs").upsert(payload2, {
          onConflict: "employee_id,year,month",
        });
        error = retry.error ?? null;
      }
    }

    if (error) alert(`保存エラー: ${error.message}`);
    else alert("保存しました（payroll_runs）");
  }

  return (
    <main style={{ padding: 24, fontFamily: "system-ui, sans-serif" }}>
      <header
        style={{ display: "flex", justifyContent: "space-between", gap: 12 }}
      >
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 900, margin: 0 }}>
            給与計算（内訳＋法令対応）
          </h1>
          <p style={{ color: "#555", marginTop: 8 }}>
            月60時間超の割増は 50%（法令）で計算。36協定の上限は警告表示。
          </p>
        </div>

      　　</header>

     　　 {!sb && (
        　<section style={panel}>
          <div style={{ color: "#a40000", fontWeight: 900 }}>
            Supabase 未設定です
          </div>
          <div style={{ color: "#555", marginTop: 8, lineHeight: 1.6 }}>
            <div>`.env.local` に以下を設定して dev サーバを再起動：</div>
            <pre
              style={{
                background: "#fafafa",
                padding: 12,
                borderRadius: 10,
                overflowX: "auto",
              }}
            >{`NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...`}</pre>
          </div>
        </section>
      )}

      {sb && bootError && (
        <section style={errorBox}>
          <div style={{ fontWeight: 900 }}>読み込みエラー</div>
          <div style={{ marginTop: 6 }}>{bootError}</div>
        </section>
      )}

      {sb && loading && <section style={panel}>読み込み中…</section>}

      {sb && !loading && !bootError && (
        <>
          <section style={panel}>
            <h2 style={h2}>対象</h2>

            <div
              style={{ display: "grid", gap: 10, gridTemplateColumns: "1fr 1fr" }}
            >
              <label style={labelWrap}>
                <span style={labelText}>従業員</span>
                <select
                  value={employeeId}
                  onChange={(e) => setEmployeeId(e.target.value)}
                  style={inputStyle}
                >
                  <option value="">選択してください</option>
                  {employees.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.name}
                    </option>
                  ))}
                </select>

                {selectedEmp && (
                  <div style={help}>
                    雇用形態：<b>{selectedEmp.employment_type}</b> / 適用開始：
                    {selectedEmp.effective_from}
                    <br />
                    残業単価（通知書）：<b>
                      {Number(selectedEmp.hourly_rate_yen ?? 0).toLocaleString()}{" "}
                      円
                    </b>
                  </div>
                )}
              </label>

              <label style={labelWrap}>
                <span style={labelText}>対象月（YYYY-MM）</span>
                <input
                  value={ym}
                  onChange={(e) => setYm(e.target.value)}
                  style={inputStyle}
                />
              </label>
            </div>

            <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid #eee" }}>
              <h2 style={h2}>勤怠状況（確認用）</h2>
              <div
                style={{
                  display: "grid",
                  gap: 10,
                  gridTemplateColumns: "1fr 1fr 1fr",
                }}
              >
                <Field label="出勤日数" value={attendanceDays} setValue={setAttendanceDays} />
                <Field label="欠勤日数" value={absenceDays} setValue={setAbsenceDays} />
                <Field label="有給日数" value={paidLeaveDays} setValue={setPaidLeaveDays} />
              </div>
              <div style={help}>
                ※ ここは「状況の把握・記録用」です。給与計算（エンジン）には影響しません。
              </div>
            </div>

            {selectedEmp && selectedEmp.employment_type === "daily" && (
              <div
                style={{
                  display: "grid",
                  gap: 10,
                  gridTemplateColumns: "1fr 1fr",
                  marginTop: 10,
                }}
              >
                <Field label="出勤日数（日給：計算用）" value={workDays} setValue={setWorkDays} />
                <Field label="日給の所定時間（割増計算用）" value={dailyHours} setValue={setDailyHours} />
              </div>
            )}

            {selectedEmp && selectedEmp.employment_type === "hourly" && (
              <div
                style={{
                  display: "grid",
                  gap: 10,
                  gridTemplateColumns: "1fr 1fr",
                  marginTop: 10,
                }}
              >
                <Field label="所定労働時間（時給：計算用）" value={baseWorkHours} setValue={setBaseWorkHours} />
                <div />
              </div>
            )}
          </section>

          <div style={{ display: "grid", gridTemplateColumns: "360px 1fr", gap: 12, marginTop: 12 }}>
            <section style={panel}>
              <h2 style={h2}>勤怠内訳（時間）</h2>

              <Field label="法定内（所定超〜8h内）" value={legalWithin} setValue={setLegalWithin} />
              <Field label="法定外（時間外：8h超）" value={legalOver} setValue={setLegalOver} />
              <Field label="深夜（22-5）" value={night} setValue={setNight} />
              <Field label="法定休日" value={holidayLegal} setValue={setHolidayLegal} />
              <Field label="法定外休日" value={holidayNonLegal} setValue={setHolidayNonLegal} />

              <hr style={{ margin: "14px 0", border: "none", borderTop: "1px solid #eee" }} />

              <h2 style={h2}>手当・控除（補助）</h2>
              <FieldYen label="手当（手入力合計）" value={manualAllowance} setValue={setManualAllowance} />
              <DeductionRowsEditor rows={deductionRows} onChange={setDeductionRows} />

              <hr style={{ margin: "14px 0", border: "none", borderTop: "1px solid #eee" }} />

              <section>
                <h2 style={h2}>固定残業の扱い</h2>

                <label>
                  <input
                    type="radio"
                    checked={fixedOtMode === "EXCESS_ONLY"}
                    onChange={() => setFixedOtMode("EXCESS_ONLY")}
                  />
                  超過分のみ追加（安全・一般的）
                </label>

                <br />

                <label>
                  <input
                    type="radio"
                    checked={fixedOtMode === "DIFF_ALL_MINUS_FIXED"}
                    onChange={() => setFixedOtMode("DIFF_ALL_MINUS_FIXED")}
                  />
                  全残業 − 固定残業代（差額方式）
                </label>
              </section>

              <button style={primaryBtn} type="button" onClick={saveRun} disabled={!result}>
                月次計算を保存（Supabase）
              </button>
            </section>

            <section style={panel}>
              <h2 style={h2}>結果（内訳）</h2>

              {!result || !selectedEmp ? (
                <div style={{ color: "#666" }}>従業員を選択してください。</div>
              ) : (
                <>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                    <Kpi label="総支給（テンプレ反映）" value={grossWithTemplates} />
                    <Kpi label="手当（テンプレ）" value={computedAllowances.total} />
                    <Kpi label="控除（テンプレ＋手入力）" value={computedDeductions.total} />
                    <Kpi label="差引支給" value={grossWithTemplates - computedDeductions.total} />
                  </div>

                  <div style={{ marginTop: 12, color: "#333", fontSize: 13, lineHeight: 1.6 }}>
                    <div>
                      ベース給：<b>¥ {basePayYenForDeduction.toLocaleString()}</b>（雇用形態ベース）
                    </div>
                    <div>
                      固定残業方式：
                      <b>{fixedOtMode === "EXCESS_ONLY" ? "超過分のみ追加" : "差額方式"}</b>
                    </div>
                    <div>
                      勤怠（確認用）：出勤 <b>{attendanceDays}</b> / 欠勤 <b>{absenceDays}</b> / 有給{" "}
                      <b>{paidLeaveDays}</b>
                    </div>
                  </div>

                  <div style={{ marginTop: 12 }}>
                    <h3 style={{ margin: "8px 0", fontSize: 14, fontWeight: 900 }}>割増・内訳</h3>
                    <ul style={{ margin: 0, paddingLeft: 18, color: "#333" }}>
                      <li>法定内：¥ {result.overtime.detail.legalWithin.toLocaleString()}</li>
                      <li>時間外（超過分のみ）：¥ {result.overtime.detail.otExtraOnly.toLocaleString()}</li>
                      <li>法定休日：¥ {result.overtime.detail.holidayLegal.toLocaleString()}</li>
                      <li>法定外休日：¥ {result.overtime.detail.holidayNonLegal.toLocaleString()}</li>
                      <li>深夜：¥ {result.overtime.detail.night.toLocaleString()}</li>
                    </ul>
                  </div>

                  <div className="mt-3">
                    <div className="text-sm font-semibold">控除内訳</div>
                    <div className="mt-2 space-y-1 text-sm">
                      {deductionRows.map((r) => (
                        <div key={r.id} className="flex justify-between">
                          <span>{r.label}</span>
                          <span>¥ {r.yen.toLocaleString()}</span>
                        </div>
                      ))}
                      <div className="mt-2 border-t pt-2 flex justify-between font-semibold">
                        <span>控除額合計</span>
                        <span>¥ {manualDeductionTotal.toLocaleString()}</span>
                      </div>
                    </div>
                  </div>

                  {result.warnings.length > 0 && (
                    <div style={{ ...errorBox, marginTop: 12 }}>
                      <div style={{ fontWeight: 900 }}>警告</div>
                      <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                        {result.warnings.map((w, i) => (
                          <li key={i}>{w}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </>
              )}
            </section>
          </div>
        </>
      )}
    </main>
  );
}

function Field({
  label,
  value,
  setValue,
}: {
  label: string;
  value: number;
  setValue: (v: number) => void;
}) {
  return (
    <label style={labelWrap}>
      <span style={labelText}>{label}</span>
      <input
        inputMode="numeric"
        value={String(value)}
        onChange={(e) => setValue(toNum(e.target.value))}
        style={inputStyle}
      />
    </label>
  );
}

function FieldYen({
  label,
  value,
  setValue,
}: {
  label: string;
  value: number;
  setValue: (v: number) => void;
}) {
  return (
    <label style={labelWrap}>
      <span style={labelText}>{label}（円）</span>
      <input
        inputMode="numeric"
        value={String(value)}
        onChange={(e) => setValue(toNum(e.target.value))}
        style={inputStyle}
      />
    </label>
  );
}

function Kpi({ label, value }: { label: string; value: number }) {
  return (
    <div style={kpi}>
      <div style={kpiLabel}>{label}</div>
      <div style={kpiValue}>¥ {value.toLocaleString()}</div>
    </div>
  );
}

/* styles */
const panel: React.CSSProperties = {
  border: "1px solid #ddd",
  borderRadius: 14,
  padding: 14,
  marginTop: 14,
  background: "#fff",
};
const h2: React.CSSProperties = {
  margin: 0,
  marginBottom: 12,
  fontSize: 16,
  fontWeight: 900,
};
const btn: React.CSSProperties = {
  border: "1px solid #ccc",
  borderRadius: 10,
  padding: "8px 12px",
  background: "#fff",
  cursor: "pointer",
  textDecoration: "none",
  color: "#111",
  display: "inline-block",
};
const primaryBtn: React.CSSProperties = {
  ...btn,
  borderColor: "#111",
  fontWeight: 900,
  marginTop: 12,
};

const labelWrap: React.CSSProperties = { display: "grid", gap: 6, marginBottom: 10 };
const labelText: React.CSSProperties = { fontSize: 13, fontWeight: 700 };

const inputStyle: React.CSSProperties = {
  border: "1px solid #ccc",
  borderRadius: 10,
  padding: "10px 12px",
  fontSize: 14,
  outline: "none",
};

const help: React.CSSProperties = {
  fontSize: 12,
  color: "#666",
  marginTop: 6,
  lineHeight: 1.4,
};

const errorBox: React.CSSProperties = {
  border: "1px solid #f0caca",
  background: "#fff7f7",
  borderRadius: 10,
  padding: "10px 12px",
  color: "#a40000",
  fontSize: 13,
};

const kpi: React.CSSProperties = {
  border: "1px solid #eee",
  borderRadius: 14,
  padding: 12,
  background: "#fafafa",
};
const kpiLabel: React.CSSProperties = { fontSize: 12, color: "#666", fontWeight: 800 };
const kpiValue: React.CSSProperties = { marginTop: 6, fontSize: 18, fontWeight: 900 };
