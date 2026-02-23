// app/api/payroll/export-ledger-template/route.ts
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import ExcelJS from "exceljs";
import path from "path";
import { promises as fs } from "fs";

export const runtime = "nodejs";

// ========== ヘルパー ==========

function normalizeDeductions(raw: any): any[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;

  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return normalizeDeductions(parsed);
    } catch {
      return [];
    }
  }

  if (typeof raw === "object") {
    const maybeRows = (raw as any).rows;
    if (Array.isArray(maybeRows)) return maybeRows;
  }

  return [];
}

async function pickFirstExisting(candidates: string[]) {
  for (const p of candidates) {
    try {
      await fs.access(p);
      return p;
    } catch {}
  }
  return null;
}

// ========== 書き込みガード ==========

function getCellText(v: any): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object" && typeof v.text === "string") return v.text;
  if (typeof v === "object" && Array.isArray(v.richText)) {
    return v.richText.map((t: any) => t.text ?? "").join("");
  }
  return String(v);
}

function isFormulaCell(cell: ExcelJS.Cell): boolean {
  const m = cell.model as any;
  const v = cell.value as any;
  return (
    !!m?.formula ||
    !!m?.sharedFormula ||
    (v && typeof v === "object" && (v.formula || v.sharedFormula))
  );
}

/** 安全書き込み（merged child → master に寄せる、数式はスキップ） */
function safeSetCell(ws: ExcelJS.Worksheet, row: number, col: number, value: any) {
  let cell = ws.getCell(row, col);
  if (cell.isMerged) {
    const master = (cell as any).master as ExcelJS.Cell | undefined;
    if (master) cell = master;
  }
  if (isFormulaCell(cell)) return;
  cell.value = value;
}

/** アドレス文字列版（ヘッダ用） */
function safeSetByAddress(ws: ExcelJS.Worksheet, addr: string, value: any) {
  let cell = ws.getCell(addr);
  if (cell.isMerged) {
    const master = (cell as any).master as ExcelJS.Cell | undefined;
    if (master) cell = master;
  }
  if (isFormulaCell(cell)) return;
  cell.value = value;
}

/** 7行目のヘッダから月の先頭列を動的に取得 */
function buildPeriodStarts(ws: ExcelJS.Worksheet, headerRow = 7) {
  const targets = new Set([
    "1月","2月","3月","4月","5月","6月","7月","8月","9月","10月","11月","12月",
    "賞与１","賞与1","賞与2","賞与２","合計"
  ]);

  const starts: Record<string, number> = {};
  let prev = "";

  const maxCol = Math.max(ws.columnCount, 80);
  for (let c = 1; c <= maxCol; c++) {
    const t = getCellText(ws.getCell(headerRow, c).value).replace(/\s/g, "");
    if (!targets.has(t)) continue;
    if (t !== prev && starts[t] == null) starts[t] = c;
    prev = t;
  }

  const months = Array.from({ length: 12 }, (_, i) => `${i + 1}月`);

  // ⚠ filter(Boolean) 禁止 — 欠落月があるとインデックスがズレて全月の列がずれる
  // 見つからなかった月は 0 にして writeMonthly 側で !col → skip
  const monthStarts = months.map(m => starts[m] ?? 0) as number[];

  console.log("[buildPeriodStarts] starts:", JSON.stringify(starts));
  console.log("[buildPeriodStarts] monthStarts:", JSON.stringify(monthStarts));

  return {
    monthStarts,
    bonus1: starts["賞与１"] ?? starts["賞与1"],
    bonus2: starts["賞与２"] ?? starts["賞与2"],
    total: starts["合計"],
  };
}

/** 1行分の月別データ（12ヶ月）を安全に書き込む */
function writeMonthly(
  ws: ExcelJS.Worksheet,
  row: number,
  monthStarts: number[],
  values: (number | null)[],
  options: { blankIfZero?: boolean } = {}
) {
  const { blankIfZero = false } = options;
  for (let i = 0; i < monthStarts.length && i < values.length; i++) {
    const col = monthStarts[i];
    if (!col) continue;
    const v = values[i];
    if (v == null) continue;
    if (blankIfZero && v === 0) continue;
    safeSetCell(ws, row, col, v);
  }
}

// ========== 座標固定辞書（テンプレ確定版） ==========
//
// テンプレートの実際の構造:
//   Row 7:  月ヘッダ (1月=col I, 2月=col M, 3月=col Q, ...)
//   Row 8:  労働日数       Row 14: 基本給
//   Row 9:  労働時間数     Row 15: 特別手当
//   Row 10: 時間外労働     Row 16: 夜勤
//   Row 11: 休日労働       Row 17: 定額残業費
//   Row 12: 深夜労働       Row 18: 住宅手当
//   Row 13: (空行)         Row 19: 技能手当
//                          Row 20: 皆勤手当
//                          Row 21: 欠勤控除
//                          Row 22: 休業手当
//   Row 23: 課税合計（数式）
//   Row 24: 非課税合計（数式）
//   Row 25: 総支給額（数式）
//   Row 26: 健康保険料     Row 30: 社会保険料合計（数式）
//   Row 27: 組合費         Row 31: 課税対象額（数式）
//   Row 28: 厚生年金保険料 Row 32: 所得税
//   Row 29: 雇用保険料     Row 33: 住民税
//   Row 36: 控除額合計（数式）
//   Row 37: 差引支給金額（数式）

const INPUT_CELLS = {
  header: {
    title: "A2",     // "2026年　賃金台帳"（A2:BQ2 結合のマスター）
    birth: "A5",     // 生年月日（A5:H5 結合のマスター）
    hire: "I5",      // 雇入年月日（I5:P5 結合のマスター）
    company: "Q5",   // 所属（Q5:AF5 結合のマスター）
    name: "AG5",     // 氏名（AG5:AR5 結合のマスター）
    gender: "AS5",   // 性別（AS5:AV5 結合のマスター）
  },
  headerRow: 7,
  rows: {
    // 勤怠
    workDays: 8,
    workHours: 9,
    overtimeHours: 10,
    holidayHours: 11,
    nightHours: 12,
    // 支給
    baseSalary: 14,
    specialAllowance: 15,
    nightAllowance: 16,
    // 手当（allowance_rows から）
    fixedOtAllowance: 17,
    housingAllowance: 18,
    skillAllowance: 19,
    attendanceAllowance: 20,
    absenceDeduction: 21,
    leaveAllowance: 22,
    // 控除（入力セル）
    healthIns: 26,
    unionFee: 27,
    pensionIns: 28,
    employmentIns: 29,
    incomeTax: 32,
    residentTax: 33,
    // ※ 課税合計(23)・非課税合計(24)・総支給(25)・社保合計(30)・
    //    課税対象額(31)・控除額合計(36)・差引支給(37) は数式 → 書き込み禁止
  },
};

// ========== テンプレ流し込み ==========

function fillLedgerSheet(
  ws: ExcelJS.Worksheet,
  monthly: MonthlyData[],
  year: number,
  emp: { name: string; birth: string; hire: string; gender: string; company?: string },
) {
  // ヘッダ（5行目に値を入れる — 4行目は見出し行）
  safeSetByAddress(ws, INPUT_CELLS.header.title, `${year}年　賃金台帳`);
  safeSetByAddress(ws, INPUT_CELLS.header.name, emp.name);
  safeSetByAddress(ws, INPUT_CELLS.header.birth, emp.birth || "—");
  safeSetByAddress(ws, INPUT_CELLS.header.hire, emp.hire || "—");
  safeSetByAddress(ws, INPUT_CELLS.header.company, emp.company || "—");
  safeSetByAddress(ws, INPUT_CELLS.header.gender, emp.gender || "—");

  // 月の先頭列を動的に取得
  const { monthStarts } = buildPeriodStarts(ws, INPUT_CELLS.headerRow);
  const R = INPUT_CELLS.rows;

  // 勤怠（0なら空欄）
  writeMonthly(ws, R.workDays, monthStarts, monthly.map(v => v.workDays), { blankIfZero: true });
  writeMonthly(ws, R.workHours, monthStarts, monthly.map(v => v.workHours), { blankIfZero: true });
  writeMonthly(ws, R.overtimeHours, monthStarts, monthly.map(v => v.overtimeHours), { blankIfZero: true });
  writeMonthly(ws, R.holidayHours, monthStarts, monthly.map(v => v.holidayHours), { blankIfZero: true });
  writeMonthly(ws, R.nightHours, monthStarts, monthly.map(v => v.nightHours), { blankIfZero: true });

  // 支給（0なら空欄）
  writeMonthly(ws, R.baseSalary, monthStarts, monthly.map(v => v.baseSalary), { blankIfZero: true });
  writeMonthly(ws, R.specialAllowance, monthStarts, monthly.map(v => v.specialAllowance), { blankIfZero: true });
  writeMonthly(ws, R.nightAllowance, monthStarts, monthly.map(v => v.nightAllowance), { blankIfZero: true });

  // 手当（allowance_rows、0なら空欄）
  writeMonthly(ws, R.fixedOtAllowance, monthStarts, monthly.map(v => v.fixedOtAllowance), { blankIfZero: true });
  writeMonthly(ws, R.housingAllowance, monthStarts, monthly.map(v => v.housingAllowance), { blankIfZero: true });
  writeMonthly(ws, R.skillAllowance, monthStarts, monthly.map(v => v.skillAllowance), { blankIfZero: true });
  writeMonthly(ws, R.attendanceAllowance, monthStarts, monthly.map(v => v.attendanceAllowance), { blankIfZero: true });
  writeMonthly(ws, R.absenceDeduction, monthStarts, monthly.map(v => v.absenceDeduction), { blankIfZero: true });
  writeMonthly(ws, R.leaveAllowance, monthStarts, monthly.map(v => v.leaveAllowance), { blankIfZero: true });

  // 控除（0なら空欄）
  writeMonthly(ws, R.healthIns, monthStarts, monthly.map(v => v.healthIns), { blankIfZero: true });
  writeMonthly(ws, R.unionFee, monthStarts, monthly.map(v => v.unionFee), { blankIfZero: true });
  writeMonthly(ws, R.pensionIns, monthStarts, monthly.map(v => v.pensionIns), { blankIfZero: true });
  writeMonthly(ws, R.employmentIns, monthStarts, monthly.map(v => v.employmentIns), { blankIfZero: true });
  writeMonthly(ws, R.incomeTax, monthStarts, monthly.map(v => v.incomeTax), { blankIfZero: true });
  writeMonthly(ws, R.residentTax, monthStarts, monthly.map(v => v.residentTax), { blankIfZero: true });

  // 合計・差引はすべてテンプレの数式に任せる（書き込まない）
}

// ========== POST ハンドラ ==========

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const employeeId = body.employeeId as string | undefined;
    const year = Number(body.year ?? new Date().getFullYear());

    if (!employeeId) {
      return NextResponse.json({ error: "employeeId_required" }, { status: 400 });
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!supabaseUrl || !anonKey) {
      return NextResponse.json({ error: "supabase_not_configured" }, { status: 500 });
    }
    const supabase = createClient(supabaseUrl, anonKey, { auth: { persistSession: false } });

    const { data: emp, error: empErr } = await supabase
      .from("employees")
      .select("*")
      .eq("id", employeeId)
      .maybeSingle();

    if (empErr) {
      return NextResponse.json({ error: "employee_fetch_failed", message: empErr.message }, { status: 500 });
    }

    const employeeName = emp?.name ?? "不明";
    const birthDate = emp?.birth_date ?? "";
    const hireDate = emp?.hire_date ?? emp?.effective_from ?? "";
    const gender = emp?.gender ?? "";

    const monthly = await getMonthlyPayrollData({ supabase, employeeId, year });

    // ★ 診断ログ：どの月にデータがあるか
    const filledMonths = monthly
      .filter(m => m.baseSalary !== null || m.workDays !== null)
      .map(m => ({ month: m.month, baseSalary: m.baseSalary, workDays: m.workDays, employmentIns: m.employmentIns, incomeTax: m.incomeTax }));
    console.log(`[export-ledger-template] employee=${employeeName} (${employeeId}), year=${year}`);
    console.log(`[export-ledger-template] filledMonths:`, JSON.stringify(filledMonths));

    // テンプレート
    const candidates = [
      path.join(process.cwd(), "app", "_templates", "wage-ledger-template.xlsx"),
      path.join(process.cwd(), "app", "_assets", "templates", "wage_ledger_template.xlsx"),
      path.join(process.cwd(), "_assets", "templates", "wage_ledger_template.xlsx"),
    ];
    const templatePath = await pickFirstExisting(candidates);
    if (!templatePath) {
      return NextResponse.json({ error: "template_not_found", tried: candidates }, { status: 400 });
    }

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(templatePath);
    const ws = wb.getWorksheet("賃金台帳") ?? wb.worksheets[0];
    if (!ws) {
      return NextResponse.json({ error: "template_sheet_not_found" }, { status: 500 });
    }

    fillLedgerSheet(ws, monthly, year, {
      name: employeeName,
      birth: birthDate,
      hire: hireDate,
      gender,
      company: emp?.department ?? "㈱イーステップ",
    });

    // 数式再計算を強制（Excelで開いたとき自動再計算）
    wb.calcProperties = { ...(wb.calcProperties ?? {}), fullCalcOnLoad: true };

    const arrayBuffer = await wb.xlsx.writeBuffer();
    const uint8 = new Uint8Array(arrayBuffer);

    return new NextResponse(uint8, {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${encodeURIComponent(`賃金台帳テンプレ_${year}年_${employeeName}.xlsx`)}"`,
        "Cache-Control": "no-store, no-cache, must-revalidate",
        "Content-Length": uint8.byteLength.toString(),
      },
    });
  } catch (e: any) {
    console.error("export-ledger-template error:", e);
    return NextResponse.json({ error: "failed", message: e?.message ?? String(e) }, { status: 500 });
  }
}

// ========== 型定義 ==========

type MonthlyData = {
  month: number;
  workDays: number | null;
  workHours: number | null;
  overtimeHours: number | null;
  holidayHours: number | null;
  nightHours: number | null;
  baseSalary: number | null;
  specialAllowance: number | null;
  nightAllowance: number | null;
  // 手当（allowance_rows）
  fixedOtAllowance: number | null;
  housingAllowance: number | null;
  skillAllowance: number | null;
  attendanceAllowance: number | null;
  absenceDeduction: number | null;
  leaveAllowance: number | null;
  // 控除
  healthIns: number | null;
  unionFee: number | null;
  pensionIns: number | null;
  employmentIns: number | null;
  incomeTax: number | null;
  incomeTaxSource?: "auto" | "manual";
  residentTax: number | null;
};

// ========== データ取得 ==========

async function getMonthlyPayrollData(args: {
  supabase: any;
  employeeId: string;
  year: number;
}): Promise<MonthlyData[]> {
  const { supabase, employeeId, year } = args;

  let { data: runs, error } = await supabase
    .from("payroll_runs")
    .select("month, input, result, deduction_rows, allowance_rows")
    .eq("employee_id", employeeId)
    .eq("year", year)
    .order("month");

  // fallback: allowance_rows カラムが無い場合はカラム除外してリトライ
  if (error) {
    console.warn("getMonthlyPayrollData: retrying without allowance_rows:", error.message);
    const retry = await supabase
      .from("payroll_runs")
      .select("month, input, result, deduction_rows")
      .eq("employee_id", employeeId)
      .eq("year", year)
      .order("month");
    runs = retry.data;
    error = retry.error;
  }

  if (error) {
    console.error("getMonthlyPayrollData error:", error);
  }

  const months: MonthlyData[] = Array.from({ length: 12 }, (_, i) => ({
    month: i + 1,
    workDays: null,
    workHours: null,
    overtimeHours: null,
    holidayHours: null,
    nightHours: null,
    baseSalary: null,
    specialAllowance: null,
    nightAllowance: null,
    fixedOtAllowance: null,
    housingAllowance: null,
    skillAllowance: null,
    attendanceAllowance: null,
    absenceDeduction: null,
    leaveAllowance: null,
    healthIns: null,
    unionFee: null,
    pensionIns: null,
    employmentIns: null,
    incomeTax: null,
    residentTax: null,
  }));

  if (!runs || !Array.isArray(runs)) return months;

  for (const run of runs as any[]) {
    const m = run.month;
    if (m < 1 || m > 12) continue;

    const idx = m - 1;
    const inp = run.input ?? {};
    const res = run.result ?? {};

    // ✅ deduction_rows はトップレベルカラムから取得
    // result.deductions は集計オブジェクト {totalYen, detail} なので控除配列としては使えない
    const deductions = normalizeDeductions(run.deduction_rows);

    // ★ 診断ログ：控除データの中身
    console.log(`[getMonthlyPayrollData] month=${m}, deduction_rows type=${typeof run.deduction_rows}, normalized count=${deductions.length}`);
    if (deductions.length > 0) {
      console.log(`[getMonthlyPayrollData] deductions:`, JSON.stringify(deductions.map((d: any) => ({ id: d?.id, yen: d?.yen }))));
    }

    const findDed = (id: string): number =>
      deductions.find((d: any) => d?.id === id)?.yen ?? 0;

    // 勤怠（入力がある時だけ出力）
    months[idx].workDays = inp.attendanceDays ?? inp.workDays ?? null;
    months[idx].workHours = inp.workHours ?? null;
    months[idx].overtimeHours = inp.overtimeHours ?? res.overtimeHours ?? null;
    months[idx].holidayHours = inp.holidayHours ?? null;
    months[idx].nightHours = inp.nightHours ?? null;

    // 支給（基本給は baseYen 系を優先、フォールバックで grossYen）
    const baseCandidate =
      res.baseYen ??
      res.basePayYen ??
      res.base_yen ??
      res.base_pay_yen ??
      res.grossYen ??
      null;
    months[idx].baseSalary = baseCandidate;

    // 手当ヘルパー（specialAllowance でも使うので先に定義）
    const allowances = normalizeDeductions(run.allowance_rows);
    const findAllow = (id: string): number =>
      allowances.find((a: any) => a?.id === id)?.yen ?? 0;
    const rowsDetail: Record<string, any> = res.allowances?.rowsDetail ?? {};
    const findAllowFb = (id: string, label: string): number | null => {
      const v = findAllow(id);
      if (v !== 0) return v;
      const d = rowsDetail[label];
      if (d && typeof d === "object" && Number.isFinite(d.yen) && d.yen !== 0) return d.yen;
      return null;
    };

    const templateDetail = res.allowances?.templateDetail ?? {};
    // 特別手当: テンプレ + AllowanceRow の合算（どちらか一方でも可）
    const templateSpecial = templateDetail["特別手当"] ?? templateDetail["固定残業代"] ?? 0;
    const rowSpecial = findAllowFb("special_allowance", "特別手当") ?? 0;
    months[idx].specialAllowance = (templateSpecial + rowSpecial) || null;
    months[idx].nightAllowance = templateDetail["夜勤"] ?? templateDetail["夜勤手当"] ?? null;

    // 手当（allowance_rows → result.allowances.rowsDetail のフォールバック）
    months[idx].fixedOtAllowance = findAllowFb("fixed_ot_allowance", "定額残業費");
    months[idx].housingAllowance = findAllowFb("housing_allowance", "住宅手当");
    months[idx].skillAllowance = findAllowFb("skill_allowance", "技能手当");
    months[idx].attendanceAllowance = findAllowFb("attendance_allowance", "皆勤手当");
    months[idx].absenceDeduction = findAllowFb("absence_deduction", "欠勤控除");
    months[idx].leaveAllowance = findAllowFb("leave_allowance", "休業手当");

    // 控除（result 優先 → deduction_rows フォールバック）
    // result は常に最新保存される。deduction_rows はカラム不在時に更新されない場合がある。
    months[idx].healthIns = findDed("health") || null;
    months[idx].unionFee = findDed("union") || null;
    months[idx].pensionIns = findDed("pension") || null;
    months[idx].employmentIns = res.employment_insurance?.final_yen || findDed("employment") || null;
    months[idx].incomeTax = res.income_tax?.final_yen || findDed("income_tax") || null;
    months[idx].residentTax = findDed("resident_tax") || null;

    const incomeTaxRow = deductions.find((d: any) => d?.id === "income_tax");
    months[idx].incomeTaxSource = incomeTaxRow?.source ?? "auto";
  }

  return months;
}
