// app/payroll/page.tsx
"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { getSupabaseClient } from "@/app/_lib/supabase/client";
import { calcPayroll, PremiumTable, calcEmploymentInsuranceYen } from "@/app/_lib/payroll/engine";
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

  // ✅ 所得税計算用
  dependents_count: number;
  withholding_type: "KO" | "OTSU";
  is_executive: boolean;
  is_employment_insurance_applicable: boolean;
  employment_insurance_rate: number; // 0.006 等
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

type WithholdingKoRow = {
  tax_year: number;
  pay_type: string;
  taxable_min: number;
  taxable_max: number;
  dep0: number; dep1: number; dep2: number; dep3: number;
  dep4: number; dep5: number; dep6: number; dep7: number;
};

function pickIncomeTaxFromKoTable(opts: {
  taxableIncomeYen: number;
  dependents: number;
  rows: WithholdingKoRow[];
}) {
  const { taxableIncomeYen, dependents, rows } = opts;
  const dep = Math.max(0, Math.min(7, Math.floor(dependents || 0)));

  const hit = rows.find(r => r.taxable_min <= taxableIncomeYen && taxableIncomeYen < r.taxable_max);
  if (!hit) return 0;

  const key = (`dep${dep}`) as keyof WithholdingKoRow;
  const v = Number(hit[key] ?? 0);
  return Number.isFinite(v) ? v : 0;
}

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

type AllowanceRow = {
  id: string;
  label: string;
  yen: number;
  isTaxable: boolean;
  isRecurring?: boolean;
  source?: "auto" | "manual";
};

const defaultAllowanceRows: AllowanceRow[] = [
  { id: "fixed_ot_allowance",   label: "定額残業費", yen: 0, isTaxable: true },
  { id: "special_allowance",    label: "特別手当",   yen: 0, isTaxable: true },
  { id: "housing_allowance",    label: "住宅手当",   yen: 0, isTaxable: true },
  { id: "skill_allowance",      label: "技能手当",   yen: 0, isTaxable: true },
  { id: "attendance_allowance", label: "皆勤手当",   yen: 0, isTaxable: true },
  { id: "absence_deduction",    label: "欠勤控除",   yen: 0, isTaxable: true },
  { id: "leave_allowance",      label: "休業手当",   yen: 0, isTaxable: true },
];

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

// ========== AllowanceRow ヘルパー ==========

function mergeAllowanceRows(defaults: AllowanceRow[], saved: AllowanceRow[]) {
  const map = new Map(saved.map((r) => [r.id, r]));
  const merged = defaults.map((d) => {
    const s = map.get(d.id);
    return s
      ? {
          ...d,
          label: s.label ?? d.label,
          yen: Number(s.yen ?? 0),
          isTaxable: s.isTaxable ?? d.isTaxable,
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
      label: String(s.label ?? "追加手当"),
      yen: Number(s.yen ?? 0),
      isTaxable: s.isTaxable !== false,
      isRecurring: Boolean(s.isRecurring),
      source: s.source === "auto" || s.source === "manual" ? s.source : undefined,
    }));

  return [...merged, ...customs];
}

function pickRecurringAllowanceRows(rows: AllowanceRow[]) {
  return rows
    .filter((r) => r && r.isRecurring && Number(r.yen || 0) !== 0)
    .map((r) => ({
      id: r.id,
      label: r.label,
      yen: Number(r.yen || 0),
      isTaxable: r.isTaxable,
      isRecurring: true as const,
    }));
}

function applyRecurringAllowanceIntoDefaults(
  defaults: AllowanceRow[],
  recurring: AllowanceRow[]
) {
  const map = new Map(recurring.map((r) => [r.id, r]));
  return defaults.map((d) => {
    const r = map.get(d.id);
    if (!r) return d;
    return { ...d, yen: r.yen, isRecurring: true, isTaxable: r.isTaxable, label: r.label ?? d.label };
  });
}

/**
 * deductionRows の特定行を更新/追加するヘルパー
 */
function upsertDeductionRow(
  rows: DeductionRow[],
  id: string,
  patch: Partial<DeductionRow>
): DeductionRow[] {
  const idx = rows.findIndex((r) => r.id === id);
  if (idx === -1) {
    return [...rows, { id, label: id, yen: 0, source: "manual", ...patch } as DeductionRow];
  }
  const next = [...rows];
  next[idx] = { ...next[idx], ...patch };
  return next;
}

function AllowanceRowsEditor({
  rows,
  onChange,
}: {
  rows: AllowanceRow[];
  onChange: (rows: AllowanceRow[]) => void;
}) {
  const fixedIds = new Set([
    "fixed_ot_allowance",
    "special_allowance",
    "housing_allowance",
    "skill_allowance",
    "attendance_allowance",
    "absence_deduction",
    "leave_allowance",
  ]);

  const updateYen = (id: string, yen: number) => {
    onChange(rows.map((r) => (r.id === id ? { ...r, yen } : r)));
  };

  const updateLabel = (id: string, label: string) => {
    onChange(rows.map((r) => (r.id === id ? { ...r, label } : r)));
  };

  const addRow = () => {
    const id =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `custom_${Date.now()}`;
    onChange([...rows, { id, label: "追加手当", yen: 0, isTaxable: true }]);
  };

  const removeRow = (id: string) => {
    if (fixedIds.has(id)) return;
    onChange(rows.filter((r) => r.id !== id));
  };

  const isCustomRow = (id: string) => !fixedIds.has(id);

  const gridColsFixed = "minmax(160px,1fr) 140px";
  const gridColsCustom = "minmax(160px,1fr) 140px 32px";

  return (
    <div className="space-y-3">
      <div className="text-sm font-semibold">手当（内訳）</div>

      <div className="space-y-2">
        {rows.map((r) => (
          <div key={r.id} className="space-y-1">
            <div style={{ display: "grid", gridTemplateColumns: isCustomRow(r.id) ? gridColsCustom : gridColsFixed, gap: 8, alignItems: "center" }}>
              <input
                className="w-full rounded-md border px-3 py-2 text-sm"
                value={r.label}
                onChange={(e) => updateLabel(r.id, e.target.value)}
              />
              <input
                className="w-full rounded-md border px-3 py-2 text-sm text-right"
                inputMode="numeric"
                value={Number.isFinite(r.yen) ? r.yen : 0}
                onChange={(e) => updateYen(r.id, Number(e.target.value || 0))}
              />
              {isCustomRow(r.id) && (
                <button
                  type="button"
                  className="rounded-md border border-red-300 bg-red-50 px-2 py-2 text-xs text-red-600 hover:bg-red-100"
                  onClick={() => removeRow(r.id)}
                  title="削除"
                >
                  ×
                </button>
              )}
            </div>
            <div style={{ display: "flex", gap: 16, alignItems: "center", paddingLeft: 4 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: "#555" }}>
                <input
                  type="checkbox"
                  checked={r.isTaxable}
                  onChange={(e) =>
                    onChange(
                      rows.map((x) =>
                        x.id === r.id ? { ...x, isTaxable: e.target.checked } : x
                      )
                    )
                  }
                />
                課税
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: "#555" }}>
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
                毎月（次月引継ぎ）
              </label>
            </div>
          </div>
        ))}
      </div>

      <button
        type="button"
        className="w-full rounded-md border px-3 py-2 text-sm"
        onClick={addRow}
      >
        ＋手当を追加
      </button>
    </div>
  );
}

function DeductionRowsEditor({
  rows,
  onChange,
}: {
  rows: DeductionRow[];
  onChange: (rows: DeductionRow[]) => void;
}) {
  const fixedIds = new Set([
    "health",
    "union",
    "pension",
    "employment",
    "income_tax",
    "resident_tax",
  ]);

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
    if (fixedIds.has(id)) return;
    onChange(rows.filter((r) => r.id !== id));
  };

  const isCustomRow = (id: string) => !fixedIds.has(id);

  const gridColsFixed = "minmax(160px,1fr) 140px 50px";
  const gridColsCustom = "minmax(160px,1fr) 140px 50px 32px";

  return (
    <div className="space-y-3">
      <div className="text-sm font-semibold">控除（内訳）</div>

      <div className="space-y-2">
        {rows.map((r) => (
          <div key={r.id} className="space-y-1">
            <div style={{ display: "grid", gridTemplateColumns: isCustomRow(r.id) ? gridColsCustom : gridColsFixed, gap: 8, alignItems: "center" }}>
              <input
                className="w-full rounded-md border px-3 py-2 text-sm"
                value={r.label}
                onChange={(e) => updateLabel(r.id, e.target.value)}
              />
              <input
                className="w-full rounded-md border px-3 py-2 text-sm text-right"
                inputMode="numeric"
                value={Number.isFinite(r.yen) ? r.yen : 0}
                onChange={(e) => updateYen(r.id, Number(e.target.value || 0))}
              />
              <label className="flex items-center justify-center">
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
              {isCustomRow(r.id) && (
                <button
                  type="button"
                  className="rounded-md border border-red-300 bg-red-50 px-2 py-2 text-xs text-red-600 hover:bg-red-100"
                  onClick={() => removeRow(r.id)}
                  title="削除"
                >
                  ×
                </button>
              )}
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

function IncomeTaxField({
  autoYen,
  initialOverrideYen,
  onChange,
}: {
  autoYen: number;
  initialOverrideYen: number | null;
  onChange: (payload: { income_tax_override_yen: number | null }) => void;
}) {
  const [overrideYen, setOverrideYen] = useState<number | null>(initialOverrideYen);
  const [isOverrideEditing, setIsOverrideEditing] = useState(initialOverrideYen !== null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const finalYen = overrideYen ?? autoYen;

  const enableOverride = () => {
    setConfirmOpen(false);
    setIsOverrideEditing(true);
    const newVal = overrideYen === null ? autoYen : overrideYen;
    setOverrideYen(newVal);
    onChange({ income_tax_override_yen: newVal });
  };

  const disableOverride = () => {
    setOverrideYen(null);
    setIsOverrideEditing(false);
    onChange({ income_tax_override_yen: null });
  };

  return (
    <div className="space-y-3">
      <div className="text-sm font-semibold">所得税</div>

      <div className="rounded-xl border px-3 py-2">
        <div className="text-xs text-muted-foreground">自動計算結果（円）</div>
        <div className="text-base font-semibold">¥ {autoYen.toLocaleString()}</div>
      </div>

      <div className="rounded-xl border px-3 py-2">
        <div className="text-xs text-muted-foreground">適用値（円）</div>
        <div className="text-base font-semibold">¥ {finalYen.toLocaleString()}</div>
      </div>

      {!isOverrideEditing ? (
        <div>
          <button
            type="button"
            onClick={() => setConfirmOpen(true)}
            className="rounded-xl border px-3 py-2 text-sm hover:bg-muted"
          >
            手動で修正する
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          <label className="text-xs text-muted-foreground">手動入力（円）</label>
          <div className="flex gap-2 items-center">
            <input
              type="number"
              inputMode="numeric"
              className="w-48 rounded-xl border px-3 py-2 text-sm"
              value={overrideYen ?? ""}
              onChange={(e) => {
                const v = e.target.value;
                if (v === "") {
                  setOverrideYen(null);
                  onChange({ income_tax_override_yen: null });
                  return;
                }
                const n = Number(v);
                const newVal = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : null;
                setOverrideYen(newVal);
                onChange({ income_tax_override_yen: newVal });
              }}
            />
            <button
              type="button"
              onClick={disableOverride}
              className="rounded-xl border px-3 py-2 text-sm hover:bg-muted"
              title="上書きを解除して自動に戻す"
            >
              自動に戻す
            </button>
          </div>

          <div className="text-xs text-muted-foreground">
            ※ 手動値がある間は自動計算より優先されます。
          </div>
        </div>
      )}

      {confirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow">
            <div className="text-base font-semibold">所得税を手動編集しますか？</div>
            <div className="mt-2 text-sm text-muted-foreground">
              手動値がある間は、自動計算より優先されます。ズレ調整が必要なときのみ使ってください。
            </div>

            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmOpen(false)}
                className="rounded-xl border px-3 py-2 text-sm hover:bg-muted"
              >
                キャンセル
              </button>
              <button
                type="button"
                onClick={enableOverride}
                className="rounded-xl bg-black px-3 py-2 text-sm text-white hover:opacity-90"
              >
                手動編集する
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function EmploymentInsuranceField({
  autoYen,
  initialOverrideYen,
  onChange,
}: {
  autoYen: number;
  initialOverrideYen: number | null;
  onChange: (payload: { employment_insurance_override_yen: number | null }) => void;
}) {
  const [overrideYen, setOverrideYen] = useState<number | null>(initialOverrideYen);
  const [isOverrideEditing, setIsOverrideEditing] = useState(initialOverrideYen !== null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const finalYen = overrideYen ?? autoYen;

  const enableOverride = () => {
    setConfirmOpen(false);
    setIsOverrideEditing(true);
    const newVal = overrideYen === null ? autoYen : overrideYen;
    setOverrideYen(newVal);
    onChange({ employment_insurance_override_yen: newVal });
  };

  const disableOverride = () => {
    setOverrideYen(null);
    setIsOverrideEditing(false);
    onChange({ employment_insurance_override_yen: null });
  };

  return (
    <div className="space-y-3">
      <div className="text-sm font-semibold">雇用保険料</div>

      <div className="rounded-xl border px-3 py-2">
        <div className="text-xs text-muted-foreground">自動計算結果（円）</div>
        <div className="text-base font-semibold">¥ {autoYen.toLocaleString()}</div>
      </div>

      <div className="rounded-xl border px-3 py-2">
        <div className="text-xs text-muted-foreground">適用値（円）</div>
        <div className="text-base font-semibold">¥ {finalYen.toLocaleString()}</div>
      </div>

      {!isOverrideEditing ? (
        <div>
          <button
            type="button"
            onClick={() => setConfirmOpen(true)}
            className="rounded-xl border px-3 py-2 text-sm hover:bg-muted"
          >
            手動で修正する
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          <label className="text-xs text-muted-foreground">手動入力（円）</label>
          <div className="flex gap-2 items-center">
            <input
              type="number"
              inputMode="numeric"
              className="w-48 rounded-xl border px-3 py-2 text-sm"
              value={overrideYen ?? ""}
              onChange={(e) => {
                const v = e.target.value;
                if (v === "") {
                  setOverrideYen(null);
                  onChange({ employment_insurance_override_yen: null });
                  return;
                }
                const n = Number(v);
                const newVal = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : null;
                setOverrideYen(newVal);
                onChange({ employment_insurance_override_yen: newVal });
              }}
            />
            <button
              type="button"
              onClick={disableOverride}
              className="rounded-xl border px-3 py-2 text-sm hover:bg-muted"
              title="上書きを解除して自動に戻す"
            >
              自動に戻す
            </button>
          </div>

          <div className="text-xs text-muted-foreground">
            ※ 手動値がある間は自動計算より優先されます。
          </div>
        </div>
      )}

      {confirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow">
            <div className="text-base font-semibold">雇用保険料を手動編集しますか？</div>
            <div className="mt-2 text-sm text-muted-foreground">
              手動値がある間は、自動計算より優先されます。ズレ調整が必要なときのみ使ってください。
            </div>

            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmOpen(false)}
                className="rounded-xl border px-3 py-2 text-sm hover:bg-muted"
              >
                キャンセル
              </button>
              <button
                type="button"
                onClick={enableOverride}
                className="rounded-xl bg-black px-3 py-2 text-sm text-white hover:opacity-90"
              >
                手動編集する
              </button>
            </div>
          </div>
        </div>
      )}
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
  const [withholdingKo, setWithholdingKo] = useState<WithholdingKoRow[]>([]);

  const [employeeId, setEmployeeId] = useState<string>("");
  const [ym, setYm] = useState(currentYYYYMM());

  // ✅ 税年度（2025/2026/2027）- 対象月から自動取得 or 手動上書き
  const [taxYearOverride, setTaxYearOverride] = useState<number | null>(null);
  const taxYear = taxYearOverride ?? parseInt(ym.slice(0, 4), 10);

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
  const [allowanceRows, setAllowanceRows] = useState<AllowanceRow[]>(defaultAllowanceRows);
  const [deductionRows, setDeductionRows] = useState<DeductionRow[]>(defaultDeductionRows);

  // 所得税（自動計算値：後で源泉税額表ロジックに差し替える）
  const [incomeTaxAutoYen, setIncomeTaxAutoYen] = useState<number>(0);
  const [incomeTaxAutoStatus, setIncomeTaxAutoStatus] = useState<"ok" | "not_configured" | "not_found" | "no_table">("not_configured");

  // 所得税（手動上書き）
  const [incomeTaxOverrideYen, setIncomeTaxOverrideYen] = useState<number | null>(null);

  // 所得税モード（auto / manual）
  const [incomeTaxMode, setIncomeTaxMode] = useState<"auto" | "manual">("auto");

  // 雇用保険（手動上書き）
  const [employmentInsuranceOverrideYen, setEmploymentInsuranceOverrideYen] = useState<number | null>(null);

  const [loading, setLoading] = useState(true);
  const [bootError, setBootError] = useState<string | null>(null);

  // ✅ 選択中従業員
  const selectedEmp = useMemo(
    () => employees.find((e) => e.id === employeeId) ?? null,
    [employees, employeeId]
  );

  // ✅ 手当行の導出値
  const allowanceRowsTotal = useMemo(() => {
    return allowanceRows.reduce((sum, r) => sum + (Number(r.yen) || 0), 0);
  }, [allowanceRows]);

  const taxableAllowanceRowsTotal = useMemo(() => {
    return allowanceRows
      .filter((r) => r.isTaxable)
      .reduce((sum, r) => sum + (Number(r.yen) || 0), 0);
  }, [allowanceRows]);

  const nonTaxableAllowanceRowsTotal = useMemo(() => {
    return allowanceRows
      .filter((r) => !r.isTaxable)
      .reduce((sum, r) => sum + (Number(r.yen) || 0), 0);
  }, [allowanceRows]);

  const incomeTaxFinalYen = useMemo(
    () => incomeTaxOverrideYen ?? incomeTaxAutoYen,
    [incomeTaxOverrideYen, incomeTaxAutoYen]
  );

  // ✅ 無限ループ対策：source だけを参照する
  const incomeTaxSource = useMemo(() => {
    const row = deductionRows.find((r) => r.id === "income_tax");
    return row?.source ?? "auto";
  }, [deductionRows]);

  const employmentInsuranceSource = useMemo(() => {
    const row = deductionRows.find((r) => r.id === "employment");
    return row?.source ?? "auto";
  }, [deductionRows]);

  // ✅ deductionRowsForCalc は employmentInsuranceAutoYen の後で定義（下で定義）

  const editableDeductionRows = useMemo(
    () => deductionRows.filter((r) => r.id !== "income_tax" && r.id !== "employment"),
    [deductionRows]
  );

  const handleDeductionRowsChange = (rows: DeductionRow[]) => {
    setDeductionRows((prev) => {
      const income =
        prev.find((r) => r.id === "income_tax") ??
        ({ id: "income_tax", label: "所得税", yen: 0, category: "tax" } as DeductionRow);
      const employment =
        prev.find((r) => r.id === "employment") ??
        ({ id: "employment", label: "雇用保険", yen: 0, category: "social" } as DeductionRow);
      return [...rows, income, employment];
    });
  };

  // ✅ 休業手当ページからの引き継ぎ（手当へ自動反映 + 対象月も反映）
  useEffect(() => {
    const v = sessionStorage.getItem("leave_allowance_total_yen");
    if (v) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) {
        setAllowanceRows((prev) =>
          prev.map((r) => (r.id === "leave_allowance" ? { ...r, yen: n } : r))
        );
      }
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

    const syncIncomeTaxOverrideFromRows = (rows: DeductionRow[]) => {
      const tax = rows.find((r) => r.id === "income_tax");
      if (!tax) {
        setIncomeTaxOverrideYen(null);
        return;
      }
      // source==="manual" のときだけ override として復元
      if (tax.source === "manual") {
        setIncomeTaxOverrideYen(Number(tax.yen ?? 0));
      } else {
        setIncomeTaxOverrideYen(null);
      }
    };

    const syncEmploymentInsuranceOverrideFromRows = (rows: DeductionRow[]) => {
      const ins = rows.find((r) => r.id === "employment");
      if (!ins) {
        setEmploymentInsuranceOverrideYen(null);
        return;
      }
      if (ins.source === "manual") {
        setEmploymentInsuranceOverrideYen(Number(ins.yen ?? 0));
      } else {
        setEmploymentInsuranceOverrideYen(null);
      }
    };

    // ① 当月データがあるなら優先復元
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as DeductionRow[];
        if (Array.isArray(parsed)) {
          const merged = mergeDeductionRows(defaultDeductionRows, parsed);
          setDeductionRows(merged);
          syncIncomeTaxOverrideFromRows(merged);
          syncEmploymentInsuranceOverrideFromRows(merged);
          return;
        }
      } catch {
        // fallthrough
      }
      setDeductionRows(defaultDeductionRows);
      setIncomeTaxOverrideYen(null);
      setEmploymentInsuranceOverrideYen(null);
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
            const seeded = applyRecurringIntoDefaults(defaultDeductionRows, recurring);
            setDeductionRows(seeded);
            // 所得税・雇用保険は基本「月次で変わる」ので引き継がない
            setIncomeTaxOverrideYen(null);
            setEmploymentInsuranceOverrideYen(null);
            return;
          }
        } catch {
          // ignore
        }
      }
    }

    // ③ 何も無い
    setDeductionRows(defaultDeductionRows);
    setIncomeTaxOverrideYen(null);
    setEmploymentInsuranceOverrideYen(null);
  }, [employeeId, ym]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!employeeId || !ym) return;

    const key = `payroll_deduction_rows:${employeeId}:${ym}`;

    // ✅ ここは「元の控除行（表示用）」を保存する
    // 所得税の auto を潰さないため、deductionRowsForCalc は保存しない
    localStorage.setItem(key, JSON.stringify(deductionRows));
  }, [employeeId, ym, deductionRows]);

  // ✅ allowanceRows の localStorage 復元
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!employeeId || !ym) return;

    const key = `payroll_allowance_rows:${employeeId}:${ym}`;
    const raw = localStorage.getItem(key);

    // ① 当月データあり → 復元
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as AllowanceRow[];
        if (Array.isArray(parsed)) {
          setAllowanceRows(mergeAllowanceRows(defaultAllowanceRows, parsed));
          return;
        }
      } catch { /* fallthrough */ }
      setAllowanceRows(defaultAllowanceRows);
      return;
    }

    // ② 当月なし → 前月の recurring 行を引き継ぎ
    const prev = prevYYYYMM(ym);
    if (prev) {
      const prevKey = `payroll_allowance_rows:${employeeId}:${prev}`;
      const prevRaw = localStorage.getItem(prevKey);
      if (prevRaw) {
        try {
          const prevParsed = JSON.parse(prevRaw) as AllowanceRow[];
          if (Array.isArray(prevParsed)) {
            const recurring = pickRecurringAllowanceRows(prevParsed);
            setAllowanceRows(applyRecurringAllowanceIntoDefaults(defaultAllowanceRows, recurring));
            return;
          }
        } catch { /* ignore */ }
      }
    }

    // ③ 何もなし
    setAllowanceRows(defaultAllowanceRows);
  }, [employeeId, ym]);

  // ✅ allowanceRows の localStorage 保存
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!employeeId || !ym) return;

    const key = `payroll_allowance_rows:${employeeId}:${ym}`;
    localStorage.setItem(key, JSON.stringify(allowanceRows));
  }, [employeeId, ym, allowanceRows]);

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

      // taxYear はコンポーネントレベルの状態を使用（ここでは税表ロード用に年を計算）
      const [yStr] = ym.split("-");
      const taxYearForLoad = taxYearOverride ?? (Number(yStr) || new Date().getFullYear());

      const [
        { data: emp, error: empErr },
        { data: its, error: itsErr },
        { data: prs, error: prsErr },
        { data: wr, error: wrErr },
        { data: wko, error: wkoErr },
      ] = await Promise.all([
        sb
          .from("employees")
          .select(
            "id,name,employment_type,base_salary_yen,daily_wage_yen,hourly_rate_yen,fixed_ot_allowance_yen,fixed_ot_hours,effective_from,is_active,dependents_count,withholding_type,is_executive,is_employment_insurance_applicable,employment_insurance_rate"
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
        sb
          .from("withholding_monthly_ko")
          .select("*")
          .eq("tax_year", taxYearForLoad)
          .order("taxable_min"),
      ]);

      const errs = [empErr, itsErr, prsErr, wrErr, wkoErr].filter(Boolean) as any[];
      if (errs.length > 0) {
        setLoading(false);
        setBootError(errs.map((e) => e.message).join(" / "));
        return;
      }

      setEmployees((emp ?? []) as any);
      setItems((its ?? []) as any);
      setRules(wr ?? null);
      setWithholdingKo((wko ?? []) as WithholdingKoRow[]);

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
  }, [sb, ym, taxYearOverride]);

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
        // ✅ 0 固定: allowanceRowsTotal はエンジン外で grossWithTemplates に加算する
        // manual に渡すと grossYen と grossWithTemplates で二重計上になる
        manual: 0,
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
    allowanceRowsTotal,
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
   * - allowanceRows は「手入力行」なのでここでは足さない（総支給側で合算）
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
   * ✅ 総支給（エンジン + テンプレ手当 + 手当行合計）
   */
  const grossWithTemplates = useMemo(() => {
    if (!result) return 0;
    return result.grossYen + computedAllowances.total + allowanceRowsTotal;
  }, [result, computedAllowances.total, allowanceRowsTotal]);

  /**
   * ✅ 雇用保険率（従業員個別 > work_rules > デフォルト）
   */
  const employmentInsuranceRate = useMemo(() => {
    // 従業員個別に設定されていればそれを優先
    const empRate = selectedEmp?.employment_insurance_rate;
    if (empRate !== null && empRate !== undefined && Number.isFinite(Number(empRate))) {
      return Number(empRate);
    }
    // work_rules から取得
    const r = Number(rules?.employment_insurance_rate ?? 0.006);
    return Number.isFinite(r) ? r : 0.006;
  }, [selectedEmp?.employment_insurance_rate, rules]);

  /**
   * ✅ 雇用保険料（自動計算）
   */
  const employmentInsuranceAutoYen = useMemo(() => {
    if (!selectedEmp) return 0;

    // 役員 or 対象外 → isInsured = false
    const isInsured =
      !selectedEmp.is_executive &&
      selectedEmp.is_employment_insurance_applicable !== false;

    return calcEmploymentInsuranceYen(grossWithTemplates, employmentInsuranceRate, isInsured);
  }, [selectedEmp, grossWithTemplates, employmentInsuranceRate]);

  /**
   * ✅ 雇用保険料（最終値：override ?? auto）
   */
  const employmentInsuranceFinalYen = useMemo(
    () => employmentInsuranceOverrideYen ?? employmentInsuranceAutoYen,
    [employmentInsuranceOverrideYen, employmentInsuranceAutoYen]
  );

  // ✅ 雇用保険を deductionRows に auto セット（manual なら触らない）
  useEffect(() => {
    if (!grossWithTemplates || grossWithTemplates <= 0) return;
    if (employmentInsuranceSource === "manual") return;

    setDeductionRows((prev) => {
      const row = prev.find((r) => r.id === "employment");
      if (row?.source === "manual") return prev;
      return upsertDeductionRow(prev, "employment", {
        label: "雇用保険",
        yen: employmentInsuranceAutoYen,
        source: "auto",
        category: "social",
      });
    });
  }, [grossWithTemplates, employmentInsuranceAutoYen, employmentInsuranceSource]);

  /**
   * ✅ 控除行（計算用：income_tax と employment は自動で上書き）
   */
  const deductionRowsForCalc = useMemo(() => {
    const baseRows = deductionRows;

    return baseRows.map((r) => {
      if (r.id === "income_tax") {
        return {
          ...r,
          yen: incomeTaxFinalYen,
          source: incomeTaxOverrideYen !== null ? "manual" : "auto",
        };
      }

      if (r.id === "employment") {
        return {
          ...r,
          yen: employmentInsuranceFinalYen,
          source: employmentInsuranceOverrideYen !== null ? "manual" : "auto",
        };
      }

      return r;
    });
  }, [
    deductionRows,
    incomeTaxFinalYen,
    incomeTaxOverrideYen,
    employmentInsuranceFinalYen,
    employmentInsuranceOverrideYen,
  ]);

  /**
   * ✅ 社会保険合計（所得税計算用：雇用保険は自動値を使用）
   */
  const socialInsuranceForIncomeTaxYen = useMemo(() => {
    const pick = (id: string) => deductionRowsForCalc.find((r) => r.id === id)?.yen ?? 0;
    return (pick("health") || 0) + (pick("pension") || 0) + (pick("employment") || 0);
  }, [deductionRowsForCalc]);

  /**
   * ✅ 課税対象額（所得税用：総支給 − 非課税手当 − 社会保険）
   */
  const taxableForIncomeTaxYen = useMemo(() => {
    return Math.max(0, Math.round(grossWithTemplates - nonTaxableAllowanceRowsTotal - socialInsuranceForIncomeTaxYen));
  }, [grossWithTemplates, nonTaxableAllowanceRowsTotal, socialInsuranceForIncomeTaxYen]);

  const manualDeductionTotal = useMemo(() => {
    return deductionRowsForCalc.reduce((sum, r) => sum + (r.yen || 0), 0);
  }, [deductionRowsForCalc]);

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

  // ✅ 所得税の自動計算（API経由で源泉徴収税額表参照）
  useEffect(() => {
    const run = async () => {
      if (!selectedEmp) {
        setIncomeTaxAutoYen(0);
        setIncomeTaxAutoStatus("not_configured");
        return;
      }

      // 手動モードなら自動計算しない
      if (incomeTaxMode === "manual") return;

      // income_tax が manual なら触らない
      if (incomeTaxSource === "manual") return;

      // taxYear はコンポーネントレベルの状態変数を使用
      if (!taxYear) return;

      if (!taxableForIncomeTaxYen || taxableForIncomeTaxYen < 0) return;

      const dep = Number(selectedEmp.dependents_count ?? 0);

      try {
        const res = await fetch("/api/withholding/monthly-ko", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            taxableIncomeYen: taxableForIncomeTaxYen,
            dependentsCount: dep,
            taxYear,
          }),
        });

        const json = await res.json();
        if (!res.ok) {
          console.error("所得税API error:", json);
          setIncomeTaxAutoYen(0);
          setIncomeTaxAutoStatus("not_configured");
          return;
        }

        // ✅ status チェック
        if (json.status === "no_table") {
          setIncomeTaxAutoYen(0);
          setIncomeTaxAutoStatus("no_table");
          return;
        }

        const yen = Number(json.yen ?? 0);
        setIncomeTaxAutoYen(yen);
        setIncomeTaxAutoStatus("ok");

        // ✅ deductionRows にも auto セット
        setDeductionRows((prev) => {
          const row = prev.find((r) => r.id === "income_tax");
          if (row?.source === "manual") return prev;
          return upsertDeductionRow(prev, "income_tax", {
            label: "所得税",
            yen,
            source: "auto",
            category: "tax",
          });
        });
      } catch (e) {
        console.error("所得税API fetch error:", e);
        setIncomeTaxAutoYen(0);
        setIncomeTaxAutoStatus("not_configured");
      }
    };

    run();
  }, [selectedEmp?.id, selectedEmp?.dependents_count, taxYear, taxableForIncomeTaxYen, incomeTaxSource, incomeTaxMode]);

  async function saveRun() {
    if (!sb) return alert("Supabase 未設定です（.env.local を確認）");
    if (!result || !input || !empPolicy) return;
    if (!employeeId) return alert("従業員を選択してください");

    const payload = {
      employee_id: employeeId,
      year: input.year,
      month: input.month,
      engine_version: "v1.0.0",
      deduction_rows: deductionRowsForCalc,
      allowance_rows: allowanceRows,
      input: { ...input, manualDeduction: manualDeductionTotal },
      result: {
        ...result,
        baseYen: basePayYenForDeduction,
        deductionDetail: Object.fromEntries(
          deductionRowsForCalc
            .filter((r) => r.yen !== 0)
            .map((r) => [r.id, r.yen])
        ),
        grossWithTemplatesYen: grossWithTemplates,
        allowances: {
          templateTotalYen: computedAllowances.total,
          templateDetail: computedAllowances.detail,
          manualYen: allowanceRowsTotal,
          rowsTotalYen: allowanceRowsTotal,
          rowsTaxableYen: taxableAllowanceRowsTotal,
          rowsNonTaxableYen: nonTaxableAllowanceRowsTotal,
          rowsDetail: Object.fromEntries(
            allowanceRows
              .filter((r) => r.yen !== 0)
              .map((r) => [r.label, { yen: r.yen, isTaxable: r.isTaxable }])
          ),
        },
        deductions: {
          totalYen: computedDeductions.total,
          detail: computedDeductions.detail,
        },
        income_tax: {
          auto_yen: incomeTaxAutoYen,
          override_yen: incomeTaxOverrideYen,
          final_yen: incomeTaxFinalYen,
          taxable_yen: taxableForIncomeTaxYen,
        },
        employment_insurance: {
          auto_yen: employmentInsuranceAutoYen,
          override_yen: employmentInsuranceOverrideYen,
          final_yen: employmentInsuranceFinalYen,
          rate: employmentInsuranceRate,
        },
        netYen: grossWithTemplates - computedDeductions.total,
      },
    };

    let { error } = await sb.from("payroll_runs").upsert(payload as any, {
      onConflict: "employee_id,year,month",
    });

    // 段階的フォールバック: allowance_rows → deduction_rows の順に除外
    if (error) {
      const msg = error.message || "";
      if (msg.includes("allowance_rows") || msg.toLowerCase().includes("column")) {
        // ① allowance_rows のみ除外（deduction_rows は保持）
        const { allowance_rows, ...payloadNoAllow } = payload as any;
        const retry1 = await sb.from("payroll_runs").upsert(payloadNoAllow, {
          onConflict: "employee_id,year,month",
        });
        error = retry1.error ?? null;

        // ② それでも失敗 → deduction_rows も除外
        if (error) {
          const { deduction_rows, ...payloadMinimal } = payloadNoAllow;
          const retry2 = await sb.from("payroll_runs").upsert(payloadMinimal, {
            onConflict: "employee_id,year,month",
          });
          error = retry2.error ?? null;
        }
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

            <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
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

              <label style={labelWrap}>
                <span style={labelText}>税年度（税表年度）</span>
                <select
                  value={taxYearOverride ?? "auto"}
                  onChange={(e) => {
                    const v = e.target.value;
                    setTaxYearOverride(v === "auto" ? null : parseInt(v, 10));
                  }}
                  style={inputStyle}
                >
                  <option value="auto">自動（{ym.slice(0, 4)}年）</option>
                  <option value="2025">2025年</option>
                  <option value="2026">2026年</option>
                  <option value="2027">2027年</option>
                </select>
                <div style={{ fontSize: 11, color: "#666", marginTop: 2 }}>
                  ※ 所得税計算に使う税表の年度
                </div>
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
              <AllowanceRowsEditor
                rows={allowanceRows}
                onChange={setAllowanceRows}
              />

              {/* 所得税ステータス表示 */}
              {incomeTaxAutoStatus === "no_table" && (
                <div style={{ ...errorBox, background: "#fff8e6", borderColor: "#f5c518" }}>
                  <div style={{ fontWeight: 900, color: "#b8860b" }}>⚠ 税表未登録（{ym.split("-")[0]}年）</div>
                  <div style={{ marginTop: 6 }}>
                    源泉徴収税額表（甲欄）のデータが該当年度で見つかりません。
                    DB に税表を登録するか、「手動で修正する」で補正してください。
                  </div>
                </div>
              )}

              {incomeTaxAutoStatus === "not_configured" && (
                <div style={errorBox}>
                  <div style={{ fontWeight: 900 }}>所得税の自動計算が未設定です</div>
                  <div style={{ marginTop: 6 }}>
                    源泉徴収税額表（甲欄）のデータが未投入のため、所得税は 0 円で表示されています。
                    必要なら「手動で修正する」で補正してください。
                  </div>
                </div>
              )}

              {/* 手動モードバッジ + 再自動計算ボタン */}
              {incomeTaxMode === "manual" && (
                <div style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  marginBottom: 8,
                }}>
                  <div style={{
                    display: "inline-block",
                    padding: "4px 10px",
                    borderRadius: 6,
                    background: "#fff3e0",
                    border: "1px solid #ff9800",
                    color: "#e65100",
                    fontSize: 12,
                    fontWeight: 700,
                  }}>
                    ※ 手動修正あり（自動再計算停止）
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setIncomeTaxMode("auto");
                      setIncomeTaxOverrideYen(null);
                      setDeductionRows((prev) =>
                        prev.map((r) =>
                          r.id === "income_tax"
                            ? { ...r, source: "auto" }
                            : r
                        )
                      );
                    }}
                    style={{
                      padding: "4px 10px",
                      borderRadius: 6,
                      background: "#2196f3",
                      border: "none",
                      color: "#fff",
                      fontSize: 12,
                      fontWeight: 700,
                      cursor: "pointer",
                    }}
                  >
                    🔄 再自動計算に戻す
                  </button>
                </div>
              )}

              <IncomeTaxField
                autoYen={incomeTaxAutoYen}
                initialOverrideYen={incomeTaxOverrideYen}
                onChange={(p) => {
                  setIncomeTaxOverrideYen(p.income_tax_override_yen);

                  // 手動値をセットしたら手動モードに切替
                  if (p.income_tax_override_yen !== null) {
                    setIncomeTaxMode("manual");
                  } else {
                    setIncomeTaxMode("auto");
                  }

                  setDeductionRows((prev) =>
                    prev.map((r) =>
                      r.id === "income_tax"
                        ? {
                            ...r,
                            // ✅ autoYen はここで潰さない（重要）
                            // yen は「自動計算結果（今は手入力0でも可）」として残す
                            source: p.income_tax_override_yen !== null ? "manual" : "auto",
                          }
                        : r
                    )
                  );
                }}
              />

              <EmploymentInsuranceField
                autoYen={employmentInsuranceAutoYen}
                initialOverrideYen={employmentInsuranceOverrideYen}
                onChange={(p) => {
                  setEmploymentInsuranceOverrideYen(p.employment_insurance_override_yen);

                  setDeductionRows((prev) =>
                    prev.map((r) =>
                      r.id === "employment"
                        ? {
                            ...r,
                            source: p.employment_insurance_override_yen !== null ? "manual" : "auto",
                          }
                        : r
                    )
                  );
                }}
              />

              <DeductionRowsEditor
                rows={editableDeductionRows}
                onChange={handleDeductionRowsChange}
              />

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

              <button
                style={{ ...primaryBtn, background: "#6366f1", marginTop: 8 }}
                type="button"
                onClick={() => {
                  if (!selectedEmp) return alert("従業員を選択してください");
                  const url = `/api/payroll/export-ledger?employeeId=${selectedEmp.id}&year=${taxYear}`;
                  window.location.href = url;
                }}
                disabled={!selectedEmp}
              >
                📊 賃金台帳Excel出力（年次）
              </button>

              <button
                style={{ ...primaryBtn, background: "#059669", marginTop: 8 }}
                type="button"
                onClick={async () => {
                  if (!selectedEmp) return alert("従業員を選択してください");
                  try {
                    const res = await fetch("/api/payroll/export-ledger-template", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ employeeId: selectedEmp.id, year: taxYear }),
                    });
                    if (!res.ok) {
                      const json = await res.json();
                      if (json.error === "template_not_found") {
                        alert(
                          "テンプレートファイルが見つかりません。\napp/_templates/wage-ledger-template.xlsx を配置してください。"
                        );
                      } else {
                        alert(`エラー: ${json.message || json.error}`);
                      }
                      return;
                    }

                    const blob = await res.blob();
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;

                    a.download = `賃金台帳テンプレ_${taxYear}年_${selectedEmp.name}.xlsx`;

                    document.body.appendChild(a);
                    a.click();
                    a.remove();
                    setTimeout(() => URL.revokeObjectURL(url), 1000);
                  } catch (e: any) {
                    alert(`出力エラー: ${e?.message || e}`);
                  }
                }}
                disabled={!selectedEmp}
              >
                📄 テンプレ版Excel出力
              </button>

              <div style={{ fontSize: 12, color: "#666", marginTop: 6, lineHeight: 1.4 }}>
                ※社労士提出用テンプレートに給与データを流し込んで出力します。
              </div>

              <button
                style={{ ...primaryBtn, background: "#7c3aed", marginTop: 8 }}
                type="button"
                onClick={async () => {
                  if (employees.length === 0) return alert("従業員データがありません");
                  const employeeIds = employees.map(e => e.id);
                  try {
                    const res = await fetch("/api/payroll/export-ledger-template-all", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ year: taxYear, employeeIds }),
                    });
                    if (!res.ok) {
                      const json = await res.json().catch(() => ({}));
                      alert(`出力失敗: ${json?.message ?? res.statusText}`);
                      return;
                    }
                    const blob = await res.blob();
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = `賃金台帳テンプレ_${taxYear}年_全社員.xlsx`;
                    document.body.appendChild(a);
                    a.click();
                    a.remove();
                    setTimeout(() => URL.revokeObjectURL(url), 1000);
                  } catch (e: any) {
                    alert(`出力エラー: ${e?.message || e}`);
                  }
                }}
                disabled={employees.length === 0}
              >
                📚 全社員 年次賃金台帳（テンプレ版・社員別シート）
              </button>
            </section>

            <section style={panel}>
              <h2 style={h2}>結果（内訳）</h2>

              {!result || !selectedEmp ? (
                <div style={{ color: "#666" }}>従業員を選択してください。</div>
              ) : (
                <>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                    <Kpi label="総支給（テンプレ反映）" value={grossWithTemplates} />
                    <Kpi label="手当（手入力）" value={allowanceRowsTotal} />
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
                    <div className="text-sm font-semibold">手当内訳</div>
                    <div className="mt-2 space-y-1 text-sm">
                      {allowanceRows.filter(r => r.yen !== 0).map((r) => (
                        <div key={r.id} className="flex justify-between">
                          <span>
                            {r.label}
                            {!r.isTaxable && <span className="text-xs text-gray-400 ml-1">（非課税）</span>}
                          </span>
                          <span>¥ {r.yen.toLocaleString()}</span>
                        </div>
                      ))}
                      {nonTaxableAllowanceRowsTotal !== 0 && (
                        <div className="flex justify-between text-xs text-gray-500">
                          <span>うち非課税</span>
                          <span>¥ {nonTaxableAllowanceRowsTotal.toLocaleString()}</span>
                        </div>
                      )}
                      <div className="mt-2 border-t pt-2 flex justify-between font-semibold">
                        <span>手当合計</span>
                        <span>¥ {allowanceRowsTotal.toLocaleString()}</span>
                      </div>
                    </div>
                  </div>

                  <div className="mt-3">
                    <div className="text-sm font-semibold">控除内訳</div>
                    <div className="mt-2 text-sm">
                      {/* 社会保険 */}
                      <div className="text-xs text-gray-500 font-semibold mb-1">社会保険</div>
                      <div className="space-y-1">
                        {deductionRowsForCalc
                          .filter((r) => ["health", "pension", "employment", "union"].includes(r.id))
                          .map((r) => (
                            <div key={r.id} className="flex justify-between">
                              <span>{r.label}</span>
                              <span>¥ {r.yen.toLocaleString()}</span>
                            </div>
                          ))}
                      </div>
                      <div className="flex justify-between text-xs text-gray-500 border-t border-dashed mt-1 pt-1 mb-3">
                        <span>社会保険料合計</span>
                        <span>¥ {deductionRowsForCalc
                          .filter((r) => ["health", "pension", "employment", "union"].includes(r.id))
                          .reduce((s, r) => s + (r.yen || 0), 0)
                          .toLocaleString()}</span>
                      </div>

                      {/* 税金 */}
                      <div className="text-xs text-gray-500 font-semibold mb-1">税金</div>
                      <div className="space-y-1">
                        {deductionRowsForCalc
                          .filter((r) => ["income_tax", "resident_tax"].includes(r.id))
                          .map((r) => (
                            <div key={r.id} className="flex justify-between">
                              <span>{r.label}</span>
                              <span>¥ {r.yen.toLocaleString()}</span>
                            </div>
                          ))}
                      </div>

                      {/* その他（カスタム控除） */}
                      {deductionRowsForCalc.filter((r) =>
                        !["health", "pension", "employment", "union", "income_tax", "resident_tax"].includes(r.id)
                      ).length > 0 && (
                        <>
                          <div className="text-xs text-gray-500 font-semibold mt-3 mb-1">その他</div>
                          <div className="space-y-1">
                            {deductionRowsForCalc
                              .filter((r) =>
                                !["health", "pension", "employment", "union", "income_tax", "resident_tax"].includes(r.id)
                              )
                              .map((r) => (
                                <div key={r.id} className="flex justify-between">
                                  <span>{r.label}</span>
                                  <span>¥ {r.yen.toLocaleString()}</span>
                                </div>
                              ))}
                          </div>
                        </>
                      )}

                      {/* 控除額合計 */}
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
