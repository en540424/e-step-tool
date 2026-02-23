// app/api/payroll/export-ledger-template-all/route.ts
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
    return Object.values(raw);
  }

  return [];
}

function safeSheetName(name: string): string {
  return name
    .replace(/[\\\/\*\?\[\]:]/g, "")
    .slice(0, 31);
}

// ========== シート複製（レイアウト＋ラベル安全コピー） ==========
//
// ルール：
//   - 数式(formula / sharedFormula)は絶対コピーしない
//   - 数値はコピーしない（fillLedgerSheet が入れる）
//   - 文字列 / richText だけコピーする
//   - 結合セルの子セルには value を絶対入れない（master だけ）
//   → 「労 労 労…」「1月 1月 1月…」の文字崩壊を防止

function isFormulaValue(v: any): boolean {
  return v && typeof v === "object" && (v.formula || v.sharedFormula);
}

function isRichText(v: any): boolean {
  return v && typeof v === "object" && Array.isArray(v.richText);
}

function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

/** "BC7" → { row: 7, col: 55 } のようにパース */
function parseCellAddress(addr: string): { row: number; col: number } {
  const match = addr.match(/^([A-Z]+)(\d+)$/);
  if (!match) return { row: 0, col: 0 };
  const letters = match[1];
  const row = parseInt(match[2], 10);
  let col = 0;
  for (let i = 0; i < letters.length; i++) {
    col = col * 26 + (letters.charCodeAt(i) - 64); // A=1, B=2, ..., Z=26
  }
  return { row, col };
}

function cloneWorksheetLayoutAndLabels(src: ExcelJS.Worksheet, dst: ExcelJS.Worksheet) {
  dst.properties = { ...src.properties };
  dst.pageSetup = { ...src.pageSetup };
  dst.views = (src.views ?? []).map((v: any) => ({ ...v }));
  dst.headerFooter = { ...src.headerFooter };

  // merge 範囲から maxRow / maxCol を算出（罫線・結合だけの列も確実にカバー）
  const mergeRanges: string[] = (src.model as any).merges ?? [];
  let maxRow = (src.model as any).rows?.length ?? src.rowCount;
  let maxCol = (src.model as any).cols?.length ?? src.columnCount;

  for (const range of mergeRanges) {
    const parts = range.split(":");
    const end = parseCellAddress(parts[1] ?? parts[0]);
    if (end.row > maxRow) maxRow = end.row;
    if (end.col > maxCol) maxCol = end.col;
  }
  console.log(`[clone] computed maxRow=${maxRow}, maxCol=${maxCol}, merges=${mergeRanges.length}`);

  // columns: getColumn で1列ずつコピー（一括代入はズレ要因）
  for (let c = 1; c <= maxCol; c++) {
    const sc = src.getColumn(c);
    const dc = dst.getColumn(c);
    dc.width = sc.width;
    dc.hidden = sc.hidden;
    dc.outlineLevel = sc.outlineLevel;
    if (sc.style) dc.style = JSON.parse(JSON.stringify(sc.style));
  }

  // ---- Pass 1: スタイルだけコピー（値は入れない）
  for (let r = 1; r <= maxRow; r++) {
    const srcRow = src.getRow(r);
    const dstRow = dst.getRow(r);

    dstRow.height = srcRow.height;
    dstRow.hidden = srcRow.hidden;
    dstRow.outlineLevel = srcRow.outlineLevel;

    for (let c = 1; c <= maxCol; c++) {
      const s = srcRow.getCell(c);
      const d = dstRow.getCell(c);

      d.style = s.style ? JSON.parse(JSON.stringify(s.style)) : {};
      d.numFmt = s.numFmt;
      d.alignment = s.alignment ? JSON.parse(JSON.stringify(s.alignment)) : undefined;
      d.font = s.font ? JSON.parse(JSON.stringify(s.font)) : undefined;
      d.border = s.border ? JSON.parse(JSON.stringify(s.border)) : undefined;
      d.fill = s.fill ? JSON.parse(JSON.stringify(s.fill)) : undefined;
      d.protection = s.protection ? JSON.parse(JSON.stringify(s.protection)) : undefined;
    }
  }

  // ---- Pass 2: merges（src.model.merges を使う）
  for (const range of mergeRanges) {
    try {
      dst.mergeCells(range);
    } catch (e) {
      console.warn("[clone] merge failed:", range, e);
    }
  }

  // ---- Pass 3: ラベル文字だけ master セルにコピー
  for (let r = 1; r <= maxRow; r++) {
    const srcRow = src.getRow(r);
    const dstRow = dst.getRow(r);

    for (let c = 1; c <= maxCol; c++) {
      const s = srcRow.getCell(c);
      const d = dstRow.getCell(c);

      // 結合セルの子セルは絶対にスキップ（master だけ値を入れる）
      if (d.isMerged) {
        const master = (d as any).master as ExcelJS.Cell | undefined;
        if (master && master.address !== d.address) continue;
      }

      const v = s.value;
      if (v === null || v === undefined) continue;
      if (isFormulaValue(v)) continue;          // 数式禁止
      if (typeof v === "number") continue;       // 数値は fill で入れる

      // 文字列 or richText だけコピー（ラベル）
      if (typeof v === "string") {
        d.value = v;
      } else if (isRichText(v)) {
        d.value = deepClone(v);
      }
    }
  }
}

// ========== テンプレセルダンプ（デバッグ用・INPUT_CELLS 洗い出し） ==========

function dumpTemplateCells(ws: ExcelJS.Worksheet) {
  const maxRow = Math.max(ws.rowCount, 40);
  const maxCol = Math.max(ws.columnCount, 20);
  const lines: string[] = [];

  for (let r = 1; r <= maxRow; r++) {
    for (let c = 1; c <= maxCol; c++) {
      const cell = ws.getCell(r, c);
      if (cell.value === null || cell.value === undefined) continue;

      const addr = cell.address; // e.g. "A1"
      const v = cell.value as any;
      let cellType: string;
      let preview: string;

      if (typeof v === "string") {
        cellType = "string";
        preview = v.length > 40 ? v.slice(0, 40) + "…" : v;
      } else if (typeof v === "number") {
        cellType = "number";
        preview = String(v);
      } else if (v && typeof v === "object" && v.formula) {
        cellType = "formula";
        preview = v.formula.length > 60 ? v.formula.slice(0, 60) + "…" : v.formula;
      } else if (v && typeof v === "object" && v.sharedFormula) {
        cellType = "sharedFormula";
        preview = v.sharedFormula.length > 60 ? v.sharedFormula.slice(0, 60) + "…" : v.sharedFormula;
      } else if (v && typeof v === "object" && v.richText) {
        cellType = "richText";
        preview = v.richText.map((t: any) => t.text).join("").slice(0, 40);
      } else if (v instanceof Date) {
        cellType = "date";
        preview = v.toISOString();
      } else {
        cellType = typeof v;
        preview = JSON.stringify(v).slice(0, 60);
      }

      lines.push(`  ${addr.padEnd(6)} [${cellType.padEnd(14)}] ${preview}`);
    }
  }

  console.log(`[template-dump] ${ws.name} — ${lines.length} non-empty cells (rows 1-${maxRow}, cols 1-${maxCol})`);
  console.log(lines.join("\n"));
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

  // merged child → master に寄せる（throwしない）
  if (cell.isMerged) {
    const master = (cell as any).master as ExcelJS.Cell | undefined;
    if (master) cell = master;
  }

  // 数式セルは書き込みスキップ（止めない）
  if (isFormulaCell(cell)) {
    return;
  }

  cell.value = value;
}

/** アドレス文字列版（ヘッダ用）— merged child なら master に寄せる */
function safeSetByAddress(ws: ExcelJS.Worksheet, addr: string, value: any) {
  let cell = ws.getCell(addr);

  // merged child なら master に寄せる
  if (cell.isMerged) {
    const master = (cell as any).master as ExcelJS.Cell | undefined;
    if (master) cell = master;
  }

  if (isFormulaCell(cell)) {
    return; // 数式セルはスキップ
  }

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

    // 同じ文字が連続するのは1回だけ拾う（先頭列）
    if (t !== prev && starts[t] == null) starts[t] = c;
    prev = t;
  }

  console.log("[buildPeriodStarts] found:", starts);

  // 12ヶ月＋賞与＋合計の順で返す
  const months = Array.from({ length: 12 }, (_, i) => `${i + 1}月`);
  const bonus1 = starts["賞与１"] ?? starts["賞与1"];
  const bonus2 = starts["賞与２"] ?? starts["賞与2"];
  const total = starts["合計"];

  // ⚠ filter(Boolean) 禁止 — 欠落月があるとインデックスがズレて全月の列がずれる
  const monthStarts = months.map(m => starts[m] ?? 0) as number[];

  console.log("[buildPeriodStarts] starts:", JSON.stringify(starts));
  console.log("[buildPeriodStarts] monthStarts:", JSON.stringify(monthStarts));

  return {
    monthStarts,
    bonus1,
    bonus2,
    total,
  };
}

/** 1行分の月別データ（12ヶ月）を安全に書き込む — monthStarts ベース */
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
    // null は書かない（データ無し月は空欄）
    if (v == null) continue;
    // 0は空欄にするオプション
    if (blankIfZero && v === 0) continue;
    safeSetCell(ws, row, col, v);
  }
}

// ========== 座標固定辞書（テンプレ確定版） ==========
//
// 書き込み対象は「値セル」のみ。
// 課税合計・非課税合計・総支給額・社会保険・所得税・住民税・差引支給額
// → すべて数式セル。Node側では一切触らない。

const INPUT_CELLS = {
  header: {
    title: "A2",     // "2026年　賃金台帳"（A2:BQ2 結合のマスター）
    birth: "A5",     // 生年月日（A5:H5 結合のマスター）
    hire: "I5",      // 雇入年月日（I5:P5 結合のマスター）
    company: "Q5",   // 所属（Q5:AF5 結合のマスター）
    name: "AG5",     // 氏名（AG5:AR5 結合のマスター）
    gender: "AS5",   // 性別（AS5:AV5 結合のマスター）
  },
  headerRow: 7,      // 月ヘッダ行（1月/2月/... が並ぶ行）
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
    // 控除
    healthIns: 26,
    unionFee: 27,
    pensionIns: 28,
    employmentIns: 29,
    incomeTax: 32,
    residentTax: 33,
    // ※ 課税合計・総支給・差引支給は数式 → 書き込み禁止
  },
};

// ========== テンプレ流し込み（座標固定 + safeSet ガード） ==========

function fillLedgerTemplateOnSheet(
  ws: ExcelJS.Worksheet,
  monthly: MonthData[],
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

  // 月の先頭列を動的に取得（I, M, Q, ... の先頭列）
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

/**
 * POST /api/payroll/export-ledger-template-all
 *
 * body: { year: number, employeeIds?: string[] }
 * employeeIds 省略時は全社員
 */
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const year = Number(body.year ?? new Date().getFullYear());
    const employeeIds = body.employeeIds as string[] | undefined;

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!supabaseUrl || !anonKey) {
      return NextResponse.json({ error: "supabase_not_configured" }, { status: 500 });
    }
    const supabase = createClient(supabaseUrl, anonKey, { auth: { persistSession: false } });

    // 従業員一覧取得
    let employees: any[];
    if (employeeIds && employeeIds.length > 0) {
      const { data, error } = await supabase
        .from("employees")
        .select("*")
        .in("id", employeeIds);
      if (error) {
        return NextResponse.json({ error: "employees_fetch_failed", message: error.message }, { status: 500 });
      }
      employees = data ?? [];
    } else {
      const { data, error } = await supabase
        .from("employees")
        .select("*")
        .order("name");
      if (error) {
        return NextResponse.json({ error: "employees_fetch_failed", message: error.message }, { status: 500 });
      }
      employees = data ?? [];
    }

    if (employees.length === 0) {
      return NextResponse.json({ error: "no_employees" }, { status: 400 });
    }

    // テンプレート読み込み（1箇所に固定）
    const templatePath = path.join(process.cwd(), "app", "_templates", "wage-ledger-template.xlsx");
    try {
      await fs.access(templatePath);
    } catch {
      return NextResponse.json({ error: "template_not_found", path: templatePath }, { status: 400 });
    }
    console.log("[ledger-template] using template:", templatePath);

    // ① 複製元（未加工テンプレ）— fill で汚さない
    const baseWb = new ExcelJS.Workbook();
    await baseWb.xlsx.readFile(templatePath);
    const baseWs = baseWb.worksheets[0];

    // ② 出力用（ここにシートを増やして返す）
    const outWb = new ExcelJS.Workbook();
    await outWb.xlsx.readFile(templatePath);
    const templateWs = outWb.worksheets[0];
    if (!templateWs) {
      return NextResponse.json({ error: "template_sheet_not_found" }, { status: 500 });
    }
    // デバッグ：テンプレの全セルをダンプ（INPUT_CELLS 辞書の洗い出し用）
    dumpTemplateCells(templateWs);

    console.log("[ledger-template] views:", templateWs.views);
    console.log("[ledger-template] pageSetup:", templateWs.pageSetup);

    // 1人目：テンプレシートをそのまま使う（リネーム）
    const firstEmp = employees[0];
    templateWs.name = safeSheetName(`${year}_${firstEmp?.name ?? "社員"}`);

    {
      const monthly = await getMonthlyPayrollData({ supabase, employeeId: firstEmp.id, year });
      fillLedgerTemplateOnSheet(templateWs, monthly, year, {
        name: firstEmp?.name ?? "不明",
        birth: firstEmp?.birth_date ?? "",
        hire: firstEmp?.hire_date ?? firstEmp?.effective_from ?? "",
        gender: firstEmp?.gender ?? "",
        company: firstEmp?.department ?? firstEmp?.company ?? "",
      });
    }

    // 2人目以降：未加工 baseWs から複製して埋める
    for (let i = 1; i < employees.length; i++) {
      const emp = employees[i];
      const ws = outWb.addWorksheet(safeSheetName(`${year}_${emp?.name ?? `社員${i + 1}`}`));
      cloneWorksheetLayoutAndLabels(baseWs, ws);

      const monthly = await getMonthlyPayrollData({ supabase, employeeId: emp.id, year });
      fillLedgerTemplateOnSheet(ws, monthly, year, {
        name: emp?.name ?? "不明",
        birth: emp?.birth_date ?? "",
        hire: emp?.hire_date ?? emp?.effective_from ?? "",
        gender: emp?.gender ?? "",
        company: emp?.department ?? emp?.company ?? "",
      });
    }

    // 数式再計算を強制（Excelで開いたとき自動再計算）
    outWb.calcProperties = { ...(outWb.calcProperties ?? {}), fullCalcOnLoad: true };

    const arrayBuffer = await outWb.xlsx.writeBuffer();
    const uint8 = new Uint8Array(arrayBuffer);

    return new NextResponse(uint8, {
      status: 200,
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${encodeURIComponent(
          `賃金台帳_${year}年_全社員_${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "")}.xlsx`
        )}"`,
        "Cache-Control": "no-store",
        "Content-Length": uint8.byteLength.toString(),
      },
    });
  } catch (e: any) {
    console.error("export-ledger-template-all error:", e);
    return NextResponse.json(
      { error: "failed", message: e?.message ?? String(e) },
      { status: 500 }
    );
  }
}

// ========== 型定義 ==========

type MonthData = {
  month: number;
  hasRun: boolean; // その月のデータがあるか
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
  residentTax: number | null;
  // 集計系（テンプレ数式に任せるので出力には使わない）
  taxableTotal: number | null;
  nonTaxableTotal: number | null;
  grossTotal: number | null;
  socialInsTotal: number | null;
  taxableIncome: number | null;
  deductionTotal: number | null;
  netPay: number | null;
  incomeTaxSource?: "auto" | "manual";
};

// ========== データ取得 ==========

async function getMonthlyPayrollData(args: {
  supabase: any;
  employeeId: string;
  year: number;
}): Promise<MonthData[]> {
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

  const months: MonthData[] = Array.from({ length: 12 }, (_, i) => ({
    month: i + 1,
    hasRun: false,
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
    taxableTotal: null,
    nonTaxableTotal: null,
    grossTotal: null,
    socialInsTotal: null,
    taxableIncome: null,
    deductionTotal: null,
    netPay: null,
  }));

  if (!runs || !Array.isArray(runs)) return months;

  for (const run of runs as any[]) {
    const m = run.month;
    if (m < 1 || m > 12) continue;

    const idx = m - 1;
    const inp = run.input ?? {};
    const res = run.result ?? {};
    // ✅ deduction_rows はトップレベルカラムから取得（result.deductions は集計オブジェクトなので使わない）
    const deductions = normalizeDeductions(run.deduction_rows);

    const findDed = (id: string) =>
      deductions.find((d: any) => d?.id === id)?.yen ?? 0;

    // この月のデータがある
    months[idx].hasRun = true;

    // 勤怠（入力がある時だけ出力、勝手計算しない）
    months[idx].workDays = inp.attendanceDays ?? inp.workDays ?? null;
    // 労働時間は入力がある時だけ（日数×8の自動計算をやめる）
    months[idx].workHours = inp.workHours ?? null;
    months[idx].overtimeHours = inp.overtimeHours ?? res.overtimeHours ?? null;
    months[idx].holidayHours = inp.holidayHours ?? null;
    months[idx].nightHours = inp.nightHours ?? null;

    // 支給（基本給は grossYen ではなく baseYen 系を優先）
    const baseCandidate =
      res.baseYen ??
      res.basePayYen ??
      res.base_yen ??
      res.base_pay_yen ??
      res.base?.yen ??
      res.pay?.baseYen ??
      res.grossYen ??  // フォールバック
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

    // 集計系はテンプレの数式に任せるので、ここでは計算しない
  }

  return months;
}
