import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import ExcelJS from "exceljs";
import path from "path";
import fs from "fs";

export const runtime = "nodejs";

/**
 * 月 → 列変換（1月 = I列 = 9列目）
 * 1月=I(9), 2月=J(10), 3月=K(11), ... 12月=T(20)
 */
function monthToColumn(month: number): number {
  return 8 + month; // 1月 = 9 = I列
}

// 賞与・合計列
 const BONUS1_COL = 21;  // U列
const BONUS2_COL = 22;  // V列
const TOTAL_COL = 23;   // W列

/**
 * テンプレートExcelの行マッピング（確定版）
 * 労働日数=7, 基本給=14, 健康保険料=26, 所得税=32, 差引支給金額=37
 */
const ROW_MAP = {
  // 勤怠（7行目〜）
  workDays: 7,          // 労働日数
  workHours: 8,         // 労働時間数
  overtimeHours: 9,     // 時間外労働
  holidayHours: 10,     // 休日労働
  lateNightHours: 11,   // 深夜労働
  // 支給（14行目〜）
  basePay: 14,          // 基本給
  specialAllowance: 15, // 特別手当
  nightAllowance: 16,   // 夜勤
  // 集計（22行目〜）
  taxableTotal: 22,     // 課税合計
  nonTaxableTotal: 23,  // 非課税合計
  grossTotal: 24,       // 総支給額
  // 控除（26行目〜）
  healthInsurance: 26,  // 健康保険料
  unionFee: 27,         // 組合費
  pension: 28,          // 厚生年金保険料
  employmentIns: 29,    // 雇用保険料
  socialInsTotal: 30,   // 社会保険料合計
  taxableTarget: 31,    // 課税対象額
  incomeTax: 32,        // 所得税
  residentTax: 33,      // 住民税
  // 最終（36行目〜）
  deductionTotal: 36,   // 控除額合計
  netPay: 37,           // 差引支給金額
} as const;

/**
 * ヘッダセル位置（確定版 - 労基署・社労士提出OK）
 * 見出しは4行目、値は5行目
 */
const HEADER_CELLS = {
  title: "A2",        // タイトル（例: 2025年 賃金台帳）
  manualNote: "B3",   // 手動修正注記用
  birthDate: "A5",    // 生年月日
  hireDate: "C5",     // 雇入年月日
  company: "E5",      // 所属（㎱イーステップ）
  name: "I5",         // 氏名
  gender: "K5",       // 性別
} as const;

/**
 * シート名に使えない文字を除去（Excel制限）
 */
function safeSheetName(name: string): string {
  return name
    .replace(/[\\\/\*\?\[\]:]/g, "")
    .slice(0, 31); // Excel シート名は31文字まで
}

/**
 * POST /api/export/wage-ledger
 * 年次賃金台帳Excel出力（社員ごとにシート作成）
 * 
 * body: { year: number, employeeIds: string[], mode?: "overwrite" | "append" }
 * - overwrite: 同名シートがあれば削除して新規作成
 * - append: 同名シートがあればスキップ（デフォルト）
 */
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const year = Number(body.year ?? new Date().getFullYear());
    const employeeIds = body.employeeIds as string[];
    const mode = (body.mode as "overwrite" | "append") ?? "append";

    if (!employeeIds || employeeIds.length === 0) {
      return NextResponse.json({ error: "employeeIds is required" }, { status: 400 });
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!supabaseUrl || !anonKey) {
      return NextResponse.json({ error: "supabase_not_configured" }, { status: 500 });
    }
    const supabase = createClient(supabaseUrl, anonKey, { auth: { persistSession: false } });

    // テンプレートファイル読み込み
    const templatePath = path.join(process.cwd(), "_assets", "templates", "wage_ledger_template.xlsx");
    
    const wb = new ExcelJS.Workbook();
    let useTemplate = false;

    if (fs.existsSync(templatePath)) {
      await wb.xlsx.readFile(templatePath);
      useTemplate = true;
    }

    // テンプレートがある場合
    if (useTemplate) {
      // テンプレートシートを名前で取得（「賃金台帳」シート）
      const templateWs = wb.getWorksheet("賃金台帳") ?? wb.worksheets[0];
      if (!templateWs) {
        return NextResponse.json({ error: "template_sheet_not_found", message: "『賃金台帳』シートが見つかりません" }, { status: 500 });
      }

      const templateSheetName = templateWs.name;

      // 社員ごとにシート作成
      for (const employeeId of employeeIds) {
        const { employee, months } = await fetchEmployeeYearData(supabase, year, employeeId);

        // シート名: "2025_中山誠" 形式（アンダースコア区切り）
        const sheetName = safeSheetName(`${year}_${employee.name.replace(/\s+/g, "")}`);
        
        // 同名シートの処理
        const existingSheet = wb.getWorksheet(sheetName);
        if (existingSheet) {
          if (mode === "overwrite") {
            // overwrite モード: 既存シートを削除
            wb.removeWorksheet(existingSheet.id);
          } else {
            // append モード: スキップ
            console.warn(`シート "${sheetName}" は既に存在するためスキップ`);
            continue;
          }
        }

        // テンプレートシートを複製（model コピー方式）
        const ws = cloneWorksheetByModel(wb, templateWs, sheetName);
        // row15 ラベルを「固定残業代」に更新（テンプレの「特別手当」を上書き）
        {
          let r15 = ws.getCell(ROW_MAP.specialAllowance, 1);
          if (r15.isMerged) { const m = (r15 as any).master as ExcelJS.Cell | undefined; if (m) r15 = m; }
          r15.value = "固定残業代";
        }

        // 手動修正があるかチェック
        const hasManualModification = months.some(m => m.incomeTaxSource === "manual");
        
        // ヘッダ情報を書き込み
        ws.getCell(HEADER_CELLS.title).value = `${year}年　賃金台帳`;
        ws.getCell(HEADER_CELLS.birthDate).value = employee.birthDate || "";
        ws.getCell(HEADER_CELLS.hireDate).value = employee.hireDate || "";
        ws.getCell(HEADER_CELLS.company).value = employee.company || "株式会社イーステップ";
        ws.getCell(HEADER_CELLS.name).value = employee.name || "";
        ws.getCell(HEADER_CELLS.gender).value = employee.gender || "";
        
        // 手動修正注記（visible at B3）
        if (hasManualModification) {
          const noteCell = ws.getCell(HEADER_CELLS.manualNote);
          noteCell.value = "※ 手動修正あり（自動再計算停止）";
          noteCell.font = { color: { argb: "FFFF0000" }, italic: true, size: 9 };
        }

        // 月別データ書き込み
        const yearTotals: Record<string, number> = {};
        Object.keys(ROW_MAP).forEach(k => { yearTotals[k] = 0; });

        for (let m = 1; m <= 12; m++) {
          const col = monthToColumn(m);  // 1月=9(I), 2月=10(J), ...
          const r = months[m - 1];

          // 勤怠
          ws.getCell(ROW_MAP.workDays, col).value = r.workDays ?? 0;
          ws.getCell(ROW_MAP.workHours, col).value = r.workHours ?? 0;
          ws.getCell(ROW_MAP.overtimeHours, col).value = r.overtimeHours ?? 0;
          ws.getCell(ROW_MAP.holidayHours, col).value = r.holidayHours ?? 0;
          ws.getCell(ROW_MAP.lateNightHours, col).value = r.lateNightHours ?? 0;

          // 支給
          ws.getCell(ROW_MAP.basePay, col).value = r.basePay ?? 0;
          ws.getCell(ROW_MAP.specialAllowance, col).value = r.specialAllowance ?? 0;
          ws.getCell(ROW_MAP.nightAllowance, col).value = r.nightAllowance ?? 0;

          // 集計
          ws.getCell(ROW_MAP.taxableTotal, col).value = r.taxableTotal ?? 0;
          ws.getCell(ROW_MAP.nonTaxableTotal, col).value = r.nonTaxableTotal ?? 0;
          ws.getCell(ROW_MAP.grossTotal, col).value = r.grossTotal ?? 0;

          // 控除
          ws.getCell(ROW_MAP.healthInsurance, col).value = r.healthInsurance ?? 0;
          ws.getCell(ROW_MAP.unionFee, col).value = r.unionFee ?? 0;
          ws.getCell(ROW_MAP.pension, col).value = r.pension ?? 0;
          ws.getCell(ROW_MAP.employmentIns, col).value = r.employmentIns ?? 0;
          ws.getCell(ROW_MAP.socialInsTotal, col).value = r.socialInsTotal ?? 0;
          ws.getCell(ROW_MAP.taxableTarget, col).value = r.taxableTarget ?? 0;

          // 所得税（手動修正時はセルコメントも付与）
          const taxCell = ws.getCell(ROW_MAP.incomeTax, col);
          taxCell.value = r.incomeTax ?? 0;
          if (r.incomeTaxSource === "manual") {
            taxCell.note = "手動修正あり（自動再計算停止）";
          }

          ws.getCell(ROW_MAP.residentTax, col).value = r.residentTax ?? 0;

          // 最終
          ws.getCell(ROW_MAP.deductionTotal, col).value = r.deductionTotal ?? 0;
          ws.getCell(ROW_MAP.netPay, col).value = r.netPay ?? 0;

          // 年計加算
          Object.keys(ROW_MAP).forEach(k => {
            yearTotals[k] += (r as any)[k] ?? 0;
          });
        }

        // 賞与1・賞与2（将来対応）
        Object.keys(ROW_MAP).forEach(k => {
          ws.getCell((ROW_MAP as any)[k], BONUS1_COL).value = 0;
          ws.getCell((ROW_MAP as any)[k], BONUS2_COL).value = 0;
        });

        // 合計列
        Object.keys(ROW_MAP).forEach(k => {
          ws.getCell((ROW_MAP as any)[k], TOTAL_COL).value = yearTotals[k] ?? 0;
        });
      }

      // テンプレートシートを削除（提出用にスッキリ）
      if (wb.worksheets.length > 1) {
        const templateIndex = wb.worksheets.findIndex(ws => ws.name === templateSheetName);
        if (templateIndex >= 0) {
          wb.removeWorksheet(wb.worksheets[templateIndex].id);
        }
      }

    } else {
      // テンプレートが無い場合：動的生成
      for (const employeeId of employeeIds) {
        const { employee, months } = await fetchEmployeeYearData(supabase, year, employeeId);
        const sheetName = safeSheetName(`${year}${employee.name.replace(/\s+/g, "")}`);
        const ws = wb.addWorksheet(sheetName);
        
        // 簡易版シート生成
        buildSimpleSheet(ws, year, employee, months);
      }
    }

    const arrayBuffer = await wb.xlsx.writeBuffer();
    const uint8 = new Uint8Array(arrayBuffer);

    return new NextResponse(uint8, {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${encodeURIComponent(`賃金台帳_${year}年.xlsx`)}"`,
        "Content-Length": uint8.byteLength.toString(),
      },
    });
  } catch (e: any) {
    console.error("export/wage-ledger error:", e);
    return NextResponse.json({ error: "failed", message: e?.message ?? String(e) }, { status: 500 });
  }
}

// ========== ヘルパー関数 ==========

type EmployeeInfo = {
  id: string;
  name: string;
  birthDate: string;
  hireDate: string;
  gender: string;
  company: string;
};

type MonthData = {
  month: number;
  workDays: number;
  workHours: number;
  overtimeHours: number;
  holidayHours: number;
  lateNightHours: number;
  basePay: number;
  specialAllowance: number;
  nightAllowance: number;
  taxableTotal: number;
  nonTaxableTotal: number;
  grossTotal: number;
  healthInsurance: number;
  unionFee: number;
  pension: number;
  employmentIns: number;
  socialInsTotal: number;
  taxableTarget: number;
  incomeTax: number;
  incomeTaxSource?: "auto" | "manual";
  residentTax: number;
  deductionTotal: number;
  netPay: number;
};

async function fetchEmployeeYearData(
  supabase: any,
  year: number,
  employeeId: string
): Promise<{ employee: EmployeeInfo; months: MonthData[] }> {
  // 従業員情報取得
  const { data: emp } = await supabase
    .from("employees")
    .select("*")
    .eq("id", employeeId)
    .maybeSingle();

  const employee: EmployeeInfo = {
    id: employeeId,
    name: emp?.name ?? "不明",
    birthDate: emp?.birth_date ?? "",
    hireDate: emp?.hire_date ?? emp?.effective_from ?? "",
    gender: emp?.gender ?? "",
    company: "株式会社イーステップ",
  };

  // 月別給与データ取得
  const { data: runs } = await supabase
    .from("payroll_runs")
    .select("month, input, result, deduction_rows, allowance_rows")
    .eq("employee_id", employeeId)
    .eq("year", year)
    .order("month");

  // 12ヶ月分初期化
  const months: MonthData[] = Array.from({ length: 12 }, (_, i) => ({
    month: i + 1,
    workDays: 0,
    workHours: 0,
    overtimeHours: 0,
    holidayHours: 0,
    lateNightHours: 0,
    basePay: 0,
    specialAllowance: 0,
    nightAllowance: 0,
    taxableTotal: 0,
    nonTaxableTotal: 0,
    grossTotal: 0,
    healthInsurance: 0,
    unionFee: 0,
    pension: 0,
    employmentIns: 0,
    socialInsTotal: 0,
    taxableTarget: 0,
    incomeTax: 0,
    residentTax: 0,
    deductionTotal: 0,
    netPay: 0,
  }));

  if (!runs || !Array.isArray(runs)) return { employee, months };

  for (const run of runs as any[]) {
    const m = run.month;
    if (m < 1 || m > 12) continue;

    const idx = m - 1;
    const inp = run.input ?? {};
    const res = run.result ?? {};
    const deductions = (run.deduction_rows ?? []) as any[];
    const allowances = (run.allowance_rows ?? []) as any[];

    const findDed = (id: string) => deductions.find((d: any) => d.id === id)?.yen ?? 0;
    const findAllow = (id: string) => allowances.find((a: any) => a.id === id)?.yen ?? 0;

    // 勤怠
    months[idx].workDays = inp.attendanceDays ?? inp.workDays ?? 0;
    months[idx].workHours = inp.workHours ?? (months[idx].workDays * 8);
    months[idx].overtimeHours = inp.overtimeHours ?? res.overtimeHours ?? 0;
    months[idx].holidayHours = inp.holidayHours ?? 0;
    months[idx].lateNightHours = inp.nightHours ?? 0;

    // 支給 - 基本給はベース給（月給、日給、時給ベース）を取得
    // grossYen はエンジン計算結果（ベース給+残業代）なので、そのまま使用
    months[idx].basePay = res.grossYen ?? inp.baseSalaryYen ?? 0;
    
    // 手当は allowance_rows から取得（保存された手入力の手当）
    const rowsDetail = res.allowances?.rowsDetail ?? {};
    const templateDetail = res.allowances?.templateDetail ?? {};
    
    // row15 = 固定残業代（エンジン自動計算分のみ）
    // 特別手当はallowanceItemsとして別途表示（このルートでは集計に影響しない）
    months[idx].specialAllowance =
      (res.baseYen != null ? (res.overtime?.fixedIncludedYen ?? 0) : 0);
    
    // 夜勤手当
    months[idx].nightAllowance = 
      findAllow("night_allowance") ||
      (rowsDetail["夜勤"]?.yen ?? 0) ||
      (rowsDetail["夜勤手当"]?.yen ?? 0) ||
      (templateDetail["夜勤"] ?? 0) ||
      (templateDetail["夜勤手当"] ?? 0) ||
      0;

    // 集計
    // grossWithTemplatesYen は テンプレート手当 + 手入力手当 を含む（保存時に計算済み）
    const grossWithTemplates = res.grossWithTemplatesYen ?? res.grossYen ?? 0;
    
    // 非課税手当（通勤手当など）
    const commute = templateDetail["通勤手当"] ?? (rowsDetail["通勤手当"]?.yen ?? 0);
    const nonTaxableFromRows = allowances
      .filter((a: any) => a.isTaxable === false)
      .reduce((sum: number, a: any) => sum + (Number(a.yen) || 0), 0);
    
    months[idx].nonTaxableTotal = commute + nonTaxableFromRows;
    months[idx].taxableTotal = grossWithTemplates - months[idx].nonTaxableTotal;
    months[idx].grossTotal = grossWithTemplates;

    // 控除
    months[idx].healthInsurance = findDed("health");
    months[idx].unionFee = findDed("union");
    months[idx].pension = findDed("pension");
    months[idx].employmentIns = findDed("employment") || res.employment_insurance?.final_yen || 0;
    months[idx].socialInsTotal =
      months[idx].healthInsurance +
      months[idx].pension +
      months[idx].employmentIns;

    months[idx].taxableTarget =
      months[idx].grossTotal -
      months[idx].nonTaxableTotal -
      months[idx].socialInsTotal;

    months[idx].incomeTax = findDed("income_tax") || res.income_tax?.final_yen || 0;
    months[idx].residentTax = findDed("resident_tax");

    // 所得税ソース
    const incomeTaxRow = deductions.find((d: any) => d.id === "income_tax");
    months[idx].incomeTaxSource = incomeTaxRow?.source ?? "auto";

    // 最終 - res.deductions.totalYen があればそれを使用（カスタム控除含む）
    months[idx].deductionTotal = res.deductions?.totalYen ?? (
      months[idx].socialInsTotal +
      months[idx].unionFee +
      months[idx].incomeTax +
      months[idx].residentTax
    );

    months[idx].netPay = res.netYen ?? (months[idx].grossTotal - months[idx].deductionTotal);
  }

  return { employee, months };
}

/**
 * ExcelJSでシートを複製（model コピー方式 - 罫線・結合・印刷設定を完全保持）
 */
function cloneWorksheetByModel(
  wb: ExcelJS.Workbook,
  source: ExcelJS.Worksheet,
  newName: string
): ExcelJS.Worksheet {
  // 新しいシートを作成
  const newWs = wb.addWorksheet(newName);
  
  // model を丸ごとコピー（罫線・結合・印刷設定をすべて保持）
  // ExcelJS の model は deep copy が必要
  const sourceModel = source.model as any;
  const newModel = JSON.parse(JSON.stringify(sourceModel));
  
  // シート名とIDを新しいものに差し替え
  newModel.name = newName;
  newModel.id = newWs.id;
  
  // model を適用
  (newWs as any).model = newModel;
  
  return newWs;
}

/**
 * テンプレート無しの簡易シート生成
 */
function buildSimpleSheet(
  ws: ExcelJS.Worksheet,
  year: number,
  employee: EmployeeInfo,
  months: MonthData[]
) {
  const border: Partial<ExcelJS.Borders> = {
    top: { style: "thin" },
    left: { style: "thin" },
    bottom: { style: "thin" },
    right: { style: "thin" },
  };

  // ヘッダー
  ws.getCell("A1").value = `${year}年　賃金台帳`;
  ws.getCell("A1").font = { bold: true, size: 14 };
  ws.mergeCells("A1:O1");

  ws.getCell("A2").value = `氏名: ${employee.name}`;
  ws.getCell("D2").value = `生年月日: ${employee.birthDate || "—"}`;
  ws.getCell("H2").value = `雇入年月日: ${employee.hireDate || "—"}`;

  // 月ヘッダー
  const headers = ["項目", "1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月", "合計"];
  headers.forEach((h, i) => {
    const c = ws.getCell(4, i + 1);
    c.value = h;
    c.font = { bold: true };
    c.border = border;
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFD9E1F2" } };
  });

  // データ行
  const rows = [
    { label: "労働日数", key: "workDays" },
    { label: "労働時間", key: "workHours" },
    { label: "時間外労働", key: "overtimeHours" },
    { label: "基本給", key: "basePay" },
    { label: "特別手当", key: "specialAllowance" },
    { label: "総支給額", key: "grossTotal" },
    { label: "健康保険料", key: "healthInsurance" },
    { label: "厚生年金", key: "pension" },
    { label: "雇用保険", key: "employmentIns" },
    { label: "所得税", key: "incomeTax" },
    { label: "住民税", key: "residentTax" },
    { label: "控除合計", key: "deductionTotal" },
    { label: "差引支給額", key: "netPay" },
  ];

  rows.forEach((row, ri) => {
    const r = 5 + ri;
    ws.getCell(r, 1).value = row.label;
    ws.getCell(r, 1).border = border;

    let total = 0;
    months.forEach((m, mi) => {
      const val = (m as any)[row.key] ?? 0;
      const c = ws.getCell(r, mi + 2);
      c.value = val;
      c.border = border;
      c.numFmt = "#,##0";
      total += val;
    });
    
    const totalCell = ws.getCell(r, 14);
    totalCell.value = total;
    totalCell.border = border;
    totalCell.numFmt = "#,##0";
    totalCell.font = { bold: true };
  });

  // 列幅
  ws.getColumn(1).width = 12;
  for (let i = 2; i <= 14; i++) {
    ws.getColumn(i).width = 10;
  }
}
