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

/** 数式を上書きして値を強制書き込み（所得税・住民税など確定値を持つセル用） */
function forceSetCell(ws: ExcelJS.Worksheet, row: number, col: number, value: any) {
  let cell = ws.getCell(row, col);
  if (cell.isMerged) {
    const master = (cell as any).master as ExcelJS.Cell | undefined;
    if (master) cell = master;
  }
  // ExcelJS の内部モデルから formula/sharedFormula を削除する
  // （cell.value = x だけでは sharedFormula 参照が残り、Excel 開時の再計算で値が上書きされる）
  try {
    const m = (cell as any)._model;
    if (m) {
      delete m.formula;
      delete m.sharedFormula;
      delete m.result;
      if (m.type === 6 /* Formula */) m.type = value == null ? 0 : 2;
    }
  } catch { /* 内部APIが変わっても安全に継続 */ }
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

/** merged cell も含めてヘッダテキストを取得（master の値を読む） */
function getHeaderText(ws: ExcelJS.Worksheet, row: number, col: number): string {
  let cell = ws.getCell(row, col);
  if (cell.isMerged) {
    const master = (cell as any).master as ExcelJS.Cell | undefined;
    if (master) cell = master;
  }
  return getCellText(cell.value).replace(/\s/g, "");
}

/** 7行目のヘッダから月の先頭列を動的に取得（merged cell 対応版） */
function buildPeriodStarts(ws: ExcelJS.Worksheet, headerRow = 7) {
  const targets = new Set([
    "1月","2月","3月","4月","5月","6月","7月","8月","9月","10月","11月","12月",
    "賞与１","賞与1","賞与2","賞与２","合計"
  ]);

  const starts: Record<string, number> = {};
  const maxCol = Math.max(ws.columnCount, 80);

  for (let c = 1; c <= maxCol; c++) {
    const t = getHeaderText(ws, headerRow, c);
    if (!targets.has(t)) continue;

    // merged cell の場合は master の列番号を月の開始列とする
    const cell = ws.getCell(headerRow, c);
    const master = cell.isMerged ? (cell as any).master : cell;
    const startCol: number = master?.col ?? c;

    if (starts[t] == null) starts[t] = startCol;
  }

  // ⚠ テンプレに存在しない月（例: 9月列が無いテンプレ）は 0 のまま → writeMonthly でスキップされる
  // 補完推定は隣接月の結合セル内に誤って書き込む危険があるため行わない
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

/** テンプレに 9月 列が無い場合に動的挿入（8月直後に 4 列追加） */
function ensureSeptemberColumn(ws: ExcelJS.Worksheet): void {
  const { monthStarts } = buildPeriodStarts(ws, INPUT_CELLS.headerRow);

  if (monthStarts[8] !== 0) {
    console.log("[ensureSeptemberColumn] 9月 already present at col", monthStarts[8]);
    return;
  }

  const aug = monthStarts[7]; // 8月 開始列
  const oct = monthStarts[9]; // 10月 開始列
  if (!aug || !oct) {
    console.warn("[ensureSeptemberColumn] Cannot insert: 8月 or 10月 not found");
    return;
  }
  if (aug + 4 !== oct) {
    // 想定外のギャップ → 安全のためスキップ
    console.warn(`[ensureSeptemberColumn] Unexpected layout aug=${aug} oct=${oct}. Skipping.`);
    return;
  }

  const insertAt = oct; // 10月直前 = 8月直後
  console.log(`[ensureSeptemberColumn] Inserting 9月 at col ${insertAt}`);

  // 4列挿入
  ws.spliceColumns(insertAt, 0, [], [], [], []);

  // ヘッダ行に "9月" を設定（4列結合）
  const hRow = INPUT_CELLS.headerRow;
  try { ws.unMergeCells(hRow, insertAt, hRow, insertAt + 3); } catch { /* noop */ }
  ws.mergeCells(hRow, insertAt, hRow, insertAt + 3);
  const hCell = ws.getCell(hRow, insertAt);
  hCell.value = "9月";

  // 8月ヘッダのスタイルをコピー
  try {
    const augCell = ws.getCell(hRow, aug);
    const src = augCell.isMerged ? ((augCell as any).master as ExcelJS.Cell) : augCell;
    if (src.font) hCell.font = JSON.parse(JSON.stringify(src.font));
    if ((src.fill as any)?.type) hCell.fill = JSON.parse(JSON.stringify(src.fill)) as ExcelJS.Fill;
    if (src.border) hCell.border = JSON.parse(JSON.stringify(src.border));
    if (src.alignment) hCell.alignment = JSON.parse(JSON.stringify(src.alignment));
  } catch { /* スタイルコピー失敗は無視 */ }

  // 列幅を 8月 からコピー
  for (let offset = 0; offset < 4; offset++) {
    const w = ws.getColumn(aug + offset).width;
    if (w) ws.getColumn(insertAt + offset).width = w;
  }

  // データ行（8〜38）のスタイルを 8月 からコピー
  for (let r = 8; r <= 38; r++) {
    for (let offset = 0; offset < 4; offset++) {
      try {
        const srcCell = ws.getCell(r, aug + offset);
        const dstCell = ws.getCell(r, insertAt + offset);
        if (srcCell.numFmt) dstCell.numFmt = srcCell.numFmt;
        if (srcCell.font) dstCell.font = JSON.parse(JSON.stringify(srcCell.font));
        if ((srcCell.fill as any)?.type) dstCell.fill = JSON.parse(JSON.stringify(srcCell.fill)) as ExcelJS.Fill;
        if (srcCell.border) dstCell.border = JSON.parse(JSON.stringify(srcCell.border));
        if (srcCell.alignment) dstCell.alignment = JSON.parse(JSON.stringify(srcCell.alignment));
      } catch { /* skip */ }
    }
  }

  console.log(`[ensureSeptemberColumn] Done. cols ${insertAt}-${insertAt + 3} added for 9月`);
}

/** 1行分の月別データ（12ヶ月）を安全に書き込む */
function writeMonthly(
  ws: ExcelJS.Worksheet,
  row: number,
  monthStarts: number[],
  values: (number | null)[],
  options: { blankIfZero?: boolean; force?: boolean } = {}
) {
  const { blankIfZero = false, force = false } = options;
  for (let i = 0; i < monthStarts.length && i < values.length; i++) {
    const col = monthStarts[i];
    if (!col) continue;
    const v = values[i];
    if (v == null) continue;
    if (blankIfZero && v === 0) continue;
    if (force) forceSetCell(ws, row, col, v);
    else safeSetCell(ws, row, col, v);
  }
}

// ========== 座標固定辞書（テンプレ確定版） ==========
//
// テンプレートの実際の構造（現行テンプレに合わせた確定版）:
//   Row 7:  月ヘッダ (1月=col I, 2月=col M, 3月=col Q, ...)
//   Row 8:  労働日数
//   Row 9:  労働時間数
//   Row 10: 時間外労働
//   Row 11: 休日労働
//   Row 12: 深夜労働
//   Row 14: 基本給
//   Row 15: 特別手当
//   Row 16: 夜勤
//   Row 17〜22: 手当（可変・6行枠）← テンプレ確定行数
//   Row 23: 課税合計（数式）← 絶対に書き込み禁止
//   Row 24: 非課税合計（数式）
//   Row 25: 総支給額（数式）
//   Row 26: 健康保険料
//   Row 27: 組合費
//   Row 28: 厚生年金保険料
//   Row 29: 雇用保険料
//   Row 32: 所得税
//   Row 33: 住民税
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
    // 控除（入力セル）
    healthIns: 26,
    unionFee: 27,
    pensionIns: 28,
    employmentIns: 29,
    incomeTax: 32,
    residentTax: 33,
    // ※ 課税合計(23)・非課税合計(24)・総支給(25)・課税対象額(31)・差引支給(37) は数式 → 書き込み禁止
    // ⚠ 社保合計(30)・控除額合計(36) はテンプレ数式が特定月で壊れている場合があるため明示書き込み
    socialInsTotal: 30,
    deductionTotal: 36,
  },
  // ✅ 可変手当エリア（課税手当：16〜21 の 6 行）
  // ⚠ 行22 = 非課税専用行（行24の formula="I22" で非課税合計に使われる）
  //   行22 に課税手当を書くと ダブルカウント になるため endRow=21 で止める
  allowanceArea: {
    startRow: 16,  // 夜勤固定行を廃止し、row16も動的エリアに含める
    endRow: 21,   // ← 行22は非課税行のため書き込み禁止
    labelCol: 1,  // A列（結合マスター）
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
  // row16 (夜勤) は動的allowanceAreaに移したため固定書き込みなし

  // 固定ラベル行(14:基本給, 15:特別手当, 16:夜勤)を
  // A-H(8列) → A独立 + B-G結合 に変換して控除ラベルと同じ幅・配置にする
  {
    const fixedLabelFont = { charset: 128, size: 11, name: "ＭＳ 明朝" } as const;
    const colARef14 = ws.getCell(R.healthIns, 1);
    const colAFill14 = colARef14.fill as ExcelJS.Fill | undefined;
    const colABorder14 = colARef14.border as ExcelJS.Borders | undefined;
    for (const fixedRow of [R.baseSalary, R.specialAllowance]) {
      // 現在の値 & B列ボーダーを退避（unMerge後に失われるため）
      let cur = ws.getCell(fixedRow, 1);
      if (cur.isMerged) { const m = (cur as any).master as ExcelJS.Cell | undefined; if (m) cur = m; }
      const curVal = cur.value;
      const bBorder = ws.getCell(fixedRow, 2).border as any;
      // A-H 解除
      try { ws.unMergeCells(fixedRow, 1, fixedRow, 8); } catch { /* ignore */ }
      // col A を独立スタイルに
      const colA = ws.getCell(fixedRow, 1);
      colA.value = null;
      if (colAFill14) colA.fill = colAFill14;
      if (colABorder14) colA.border = colABorder14;
      // B-G 結合してラベル書き込み
      ws.mergeCells(fixedRow, 2, fixedRow, 7);
      const labelCell = ws.getCell(fixedRow, 2);
      // row15 は「特別手当」→「固定残業代」にラベルを差し替え
      labelCell.value = fixedRow === R.specialAllowance ? "固定残業代" : curVal;
      labelCell.font = { ...fixedLabelFont };
      labelCell.alignment = { horizontal: "distributed", vertical: "middle", wrapText: false };
      // 左右罫線を除去して top/bottom のみ（row26-27 と同じスタイル）
      labelCell.border = { top: { style: "dashed" }, bottom: { style: "dashed" } };
    }
  }

  // 手当（可変・6行枠）: 枠内でラベルと金額を書く。endRow 以降は絶対に触らない
  {
    const { startRow, endRow, labelCol } = INPUT_CELLS.allowanceArea;
    const maxRows = endRow - startRow + 1;
    const labels = Array.from(
      new Set(monthly.flatMap(m => m.allowanceItems.map(a => a.label)))
    );
    // overflow がある場合は最終行を合算行として予約 → named 行を maxRows-1 に制限
    const hasOverflow = labels.length > maxRows;
    const displayRows = hasOverflow ? maxRows - 1 : maxRows;
    const limited = labels.slice(0, displayRows);
    const overflow = hasOverflow ? labels.slice(displayRows) : [];

    // テンプレ構造:
    //   Row 14-21: A-H(8列)結合 → alignment left (手当エリアのデフォルト)
    //   Row 26-29: A列独立 + B-G(6列)結合 → alignment distributed (控除ラベル)
    // → row17-21 も A-H を解除し B-G 結合に変換して、控除ラベルと同一構造にする
    const labelFont = { charset: 128, size: 11, name: "ＭＳ 明朝" } as const;
    // row26 col A のスタイル（独立セル）をテンプレから取得しておく
    const colARef = ws.getCell(R.healthIns, 1); // row26 col A の独立セル
    const colAFill = colARef.fill as ExcelJS.Fill | undefined;
    const colABorder = colARef.border as ExcelJS.Borders | undefined;

    function writeLabelCell(row: number, label: string | null) {
      // 1) B列ボーダーを退避（unMerge後に失われるため）
      const bBorder = ws.getCell(row, 2).border as any;
      // 2) A-H 結合を解除（既に解除済みでも無害）
      try { ws.unMergeCells(row, 1, row, 8); } catch { /* ignore */ }
      // 3) col A を控除ラベル行(row26)と同じ独立スタイルに揃える
      const colA = ws.getCell(row, 1);
      colA.value = null;
      if (colAFill) colA.fill = colAFill;
      if (colABorder) colA.border = colABorder;
      // 4) B-G を結合（控除ラベルと同じ幅）
      ws.mergeCells(row, 2, row, 7);
      // 5) ラベルを書き込み、左右罫線を除去して top/bottom のみ（row26-27 と同じスタイル）
      const cell = ws.getCell(row, 2);
      cell.value = label;
      cell.font = { ...labelFont };
      cell.alignment = { horizontal: "distributed", vertical: "middle", wrapText: false };
      cell.border = { top: { style: "dashed" }, bottom: { style: "dashed" } };
    }

    // 枠を完全クリア（ラベル列＋全月の金額列）
    // ⚠ テンプレにformulaがある行(row16:夜勤など)もforceで上書きしてクリア
    for (let i = 0; i < maxRows; i++) {
      const r = startRow + i;
      writeLabelCell(r, null);
      for (const col of monthStarts) {
        if (col) forceSetCell(ws, r, col, null);
      }
    }

    // ラベルを行に割り当てて金額を流す（formula上書きのためforce:true）
    limited.forEach((label, i) => {
      const r = startRow + i;
      writeLabelCell(r, label);
      const values = monthly.map(m => m.allowanceItems.find(a => a.label === label)?.yen ?? null);
      writeMonthly(ws, r, monthStarts, values, { blankIfZero: true, force: true });
    });

    // 溢れた分は最終行に合算
    if (overflow.length > 0) {
      const r = endRow;
      writeLabelCell(r, "その他（合算）");
      const values = monthly.map(m => {
        const sum = m.allowanceItems
          .filter(a => overflow.includes(a.label))
          .reduce((acc, a) => acc + a.yen, 0);
        return sum === 0 ? null : sum;
      });
      writeMonthly(ws, r, monthStarts, values, { blankIfZero: true, force: true });
    }
  }

  // 控除（0なら空欄）
  writeMonthly(ws, R.healthIns, monthStarts, monthly.map(v => v.healthIns), { blankIfZero: true });
  writeMonthly(ws, R.unionFee, monthStarts, monthly.map(v => v.unionFee), { blankIfZero: true });
  writeMonthly(ws, R.pensionIns, monthStarts, monthly.map(v => v.pensionIns), { blankIfZero: true });
  writeMonthly(ws, R.employmentIns, monthStarts, monthly.map(v => v.employmentIns), { blankIfZero: true });
  writeMonthly(ws, R.incomeTax, monthStarts, monthly.map(v => v.incomeTax), { blankIfZero: true, force: true });
  writeMonthly(ws, R.residentTax, monthStarts, monthly.map(v => v.residentTax), { blankIfZero: true, force: true });

  // 行30（社会保険料合計）・行36（控除額合計）: テンプレ数式が特定月で壊れている場合があるため明示上書き
  writeMonthly(ws, R.socialInsTotal, monthStarts, monthly.map(v => {
    const s = (v.healthIns ?? 0) + (v.unionFee ?? 0) + (v.pensionIns ?? 0) + (v.employmentIns ?? 0);
    return s === 0 ? null : s;
  }), { blankIfZero: true, force: true });
  writeMonthly(ws, R.deductionTotal, monthStarts, monthly.map(v => {
    const s = (v.healthIns ?? 0) + (v.unionFee ?? 0) + (v.pensionIns ?? 0) + (v.employmentIns ?? 0)
            + (v.incomeTax ?? 0) + (v.residentTax ?? 0);
    return s === 0 ? null : s;
  }), { blankIfZero: true, force: true });

  // 課税合計(23)・非課税合計(24)・総支給(25)・課税対象額(31)・差引支給(37) はテンプレ数式に任せる
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
    console.log("[export-ledger-template] templatePath:", templatePath ?? "NOT FOUND");
    if (!templatePath) {
      return NextResponse.json({ error: "template_not_found", tried: candidates }, { status: 400 });
    }

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(templatePath);
    const ws = wb.getWorksheet("賃金台帳") ?? wb.worksheets[0];
    if (!ws) {
      return NextResponse.json({ error: "template_sheet_not_found" }, { status: 500 });
    }

    // 9月列がテンプレに無い場合は動的挿入
    ensureSeptemberColumn(ws);

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
  // 可変手当（allowance_rows から動的に構築）
  allowanceItems: { label: string; yen: number }[];
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
    allowanceItems: [],
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

    // 支給（基本給は baseYen 系を優先）
    // res.grossYen は allowanceRowsTotal を含む場合があるため、差し引いてフォールバック
    const baseCandidate =
      res.baseYen ??
      res.basePayYen ??
      res.base_yen ??
      res.base_pay_yen ??
      (res.grossYen != null
        ? res.grossYen -
          (res.allowances?.rowsTotalYen ?? res.allowances?.manualYen ?? 0) -
          (res.allowances?.templateTotalYen ?? 0)
        : null);
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
    // 特別手当（テンプレ設定分）: row15ではなくallowanceItemsに移す
    const templateSpecial = templateDetail["特別手当"] ?? 0;
    const rowSpecial = findAllowFb("special_allowance", "特別手当") ?? 0;
    // res.baseYen がある場合（新形式）は fixedIncludedYen を別行に表示する
    // res.baseYen が無い場合（旧形式）は grossYen に fixedOT が内包されているため加算しない
    const engineFixedOt = res.baseYen != null ? (res.overtime?.fixedIncludedYen ?? 0) : 0;
    // row15 = 固定残業代（自動計算分のみ）。特別手当はallowanceItemsに移す
    months[idx].specialAllowance = engineFixedOt || null;
    months[idx].nightAllowance = templateDetail["夜勤"] ?? templateDetail["夜勤手当"] ?? null;

    // 手当（可変）: allowance_rows + rowsDetail を label→yen に統合
    {
      const merged: Record<string, number> = {};
      for (const a of allowances) {
        const label = String(a?.label ?? a?.name ?? a?.title ?? a?.id ?? "").trim();
        const yen = Number(a?.yen ?? 0);
        if (!label || !Number.isFinite(yen) || yen === 0) continue;
        merged[label] = (merged[label] ?? 0) + yen;
      }
      for (const [label, obj] of Object.entries(rowsDetail)) {
        const yen = Number((obj as any)?.yen ?? 0);
        const key = String(label).trim();
        if (!key || !Number.isFinite(yen) || yen === 0) continue;
        if (merged[key] == null) merged[key] = yen; // allowance_rows 優先
      }
      // 固定残業代はrow15に出すため除外。夜勤・特別手当はrow16廃止によりallowanceItemsに移動
      delete merged["固定残業代"];
      // templateDetail 由来の特別手当が merged に未登録なら追加
      const specialFromTemplate = (templateSpecial + rowSpecial);
      if (specialFromTemplate > 0 && !merged["特別手当"]) {
        merged["特別手当"] = specialFromTemplate;
      }
      // templateDetail 由来の夜勤手当が merged に未登録なら追加
      const nightFromTemplate = templateDetail["夜勤"] ?? templateDetail["夜勤手当"] ?? 0;
      if (nightFromTemplate > 0 && !merged["夜勤"] && !merged["夜勤手当"]) {
        merged["夜勤"] = nightFromTemplate;
      }
      months[idx].allowanceItems = Object.entries(merged).map(([label, yen]) => ({ label, yen }));
    }

    // 控除（result 優先 → deduction_rows フォールバック）
    // result は常に最新保存される。deduction_rows はカラム不在時に更新されない場合がある。
    months[idx].healthIns = findDed("health") || null;
    months[idx].unionFee = findDed("union") || null;
    months[idx].pensionIns = findDed("pension") || res.deductionDetail?.["pension"] || null;
    months[idx].employmentIns = res.employment_insurance?.final_yen || findDed("employment") || res.deductionDetail?.["employment"] || null;
    months[idx].incomeTax = res.income_tax?.final_yen || findDed("income_tax") || res.deductionDetail?.["income_tax"] || null;
    months[idx].residentTax = findDed("resident_tax") || res.deductionDetail?.["resident_tax"] || null;

    const incomeTaxRow = deductions.find((d: any) => d?.id === "income_tax");
    months[idx].incomeTaxSource = incomeTaxRow?.source ?? "auto";
  }

  return months;
}
