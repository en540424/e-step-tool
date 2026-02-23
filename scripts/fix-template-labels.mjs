/**
 * fix-template-labels.mjs  (v3)
 *
 * ① 行14〜22 ラベルセル: A:H 結合を正しい API で設定
 *    ws.unMergeCells / ws.mergeCells を使用（model.merges 直接操作は無効）
 * ② 行23 課税合計: SUM 終了行を 22 に統一（既に済みなら 0件）
 *
 * 使い方: node scripts/fix-template-labels.mjs
 */

import ExcelJS from "exceljs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = path.join(
  __dirname, "../app/_templates/wage-ledger-template.xlsx"
);

const LABEL_ROWS  = [14, 15, 16, 17, 18, 19, 20, 21, 22];
const L_COL_START = 1;   // A
const L_COL_END   = 8;   // H
const ROW_HEIGHT  = 18;
const SUM_ROW     = 23;
const SUM_START   = 14;
const SUM_END     = 21;  // 行22は非課税専用（行24=I22）なので課税SUMに含めない

// ────────────────────────────────────────────────────────────────────

/** セルテキストを取得 */
function getCellText(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object" && typeof v.text === "string") return v.text;
  if (typeof v === "object" && Array.isArray(v.richText)) {
    return v.richText.map(t => t.text ?? "").join("");
  }
  return String(v);
}

/** セルの数式文字列を取得（全形式対応） */
function extractFormula(cell) {
  const m = cell.model;
  if (m?.formula) return String(m.formula);
  if (m?.sharedFormula) return String(m.sharedFormula);
  const v = cell.value;
  if (v && typeof v === "object") {
    if (v.formula) return String(v.formula);
    if (v.sharedFormula) return String(v.sharedFormula);
  }
  return null;
}

/** "A14:H22" → { c1:1, r1:14, c2:8, r2:22 } */
function parseMergeRange(str) {
  const m = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/i.exec(str);
  if (!m) return null;
  return {
    c1: colLetterToNum(m[1]), r1: parseInt(m[2], 10),
    c2: colLetterToNum(m[3]), r2: parseInt(m[4], 10),
  };
}

/** 列番号(1起算) → 列アドレス */
function colToLetter(n) {
  let s = "";
  while (n > 0) { s = String.fromCharCode(65 + ((n - 1) % 26)) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

/** 列アドレス → 列番号(1起算) */
function colLetterToNum(s) {
  let n = 0;
  for (const ch of s.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

// ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("テンプレ読み込み:", TEMPLATE);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(TEMPLATE);

  const ws = wb.getWorksheet("賃金台帳") ?? wb.worksheets[0];
  if (!ws) { console.error("シートなし"); process.exit(1); }

  // ────────────────────────────────────────────────────
  // ① ラベル結合修復（ws.unMergeCells / ws.mergeCells を使用）
  // ────────────────────────────────────────────────────
  console.log("\n=== ① ラベルセル結合修復 ===");

  for (const row of LABEL_ROWS) {
    // ── このRowのラベルエリア（c1 が A〜H 内）の既存mergeを取得 ──
    const labelMerges = (ws.model.merges ?? []).filter(mr => {
      const p = parseMergeRange(mr);
      return p && p.r1 === row && p.c1 >= L_COL_START && p.c1 <= L_COL_END;
    });

    // ── ラベル値を先に救済（A〜H 列をすべてスキャンして最初のテキストを保存） ──
    let savedValue = null;
    // まず既存 merge master から取得
    for (const mr of labelMerges) {
      const p = parseMergeRange(mr);
      if (!p) continue;
      const masterCell = ws.getCell(p.r1, p.c1);
      const val = getCellText(masterCell.value);
      if (val && !savedValue) { savedValue = masterCell.value; break; }
    }
    // merge がなければ A〜H の各セルをスキャン（B列など非 merge セルに値がある場合対応）
    if (!savedValue) {
      for (let c = L_COL_START; c <= L_COL_END; c++) {
        const cell = ws.getCell(row, c);
        const val = getCellText(cell.value);
        if (val) { savedValue = cell.value; break; }
      }
    }

    // ── 既存ラベルmergeを解除（正しいAPIで） ──
    for (const mr of labelMerges) {
      try {
        ws.unMergeCells(mr);
        console.log(`  行${row}: unMerge ${mr}`);
      } catch (e) {
        console.warn(`  行${row}: unMerge ${mr} failed: ${e.message}`);
      }
    }

    // ── A{row}:H{row} で再merge ──
    try {
      ws.mergeCells(row, L_COL_START, row, L_COL_END);
    } catch (e) {
      console.warn(`  行${row}: mergeCells failed: ${e.message}`);
    }

    // ── 新masterに値をセット ──
    const newMaster = ws.getCell(row, L_COL_START);
    if (savedValue && !getCellText(newMaster.value)) {
      newMaster.value = savedValue;
      console.log(`  行${row}: 値 "${getCellText(savedValue)}" を A に設定`);
    }

    // ── 静的ラベルのフォールバック（テンプレに値がない場合に強制設定） ──
    const STATIC_LABELS = { 14: "基本給", 15: "特別手当", 16: "夜勤" };
    if (STATIC_LABELS[row] && !getCellText(newMaster.value)) {
      newMaster.value = STATIC_LABELS[row];
      console.log(`  行${row}: 静的ラベル "${STATIC_LABELS[row]}" を設定（フォールバック）`);
    }

    // ── スタイル・行高 ──
    newMaster.alignment = { horizontal: "left", vertical: "middle", wrapText: false };
    ws.getRow(row).height = ROW_HEIGHT;
    console.log(`  行${row}: ✓ A${row}:H${row}, value="${getCellText(newMaster.value)}"`);
  }

  // ────────────────────────────────────────────────────
  // ② 課税合計 SUM 数式の終了行を 22 に統一
  // ────────────────────────────────────────────────────
  console.log(`\n=== ② 課税合計（行${SUM_ROW}）SUM修正 ===`);
  let fixCount = 0;

  for (let c = 1; c <= Math.max(ws.columnCount, 80); c++) {
    const cell = ws.getCell(SUM_ROW, c);
    const formula = extractFormula(cell);
    if (!formula) continue;

    const fixed = formula.replace(
      /([A-Z]+)(\d+):([A-Z]+)(\d+)/gi,
      (match, c1, r1, c2, r2) => {
        if (c1.toUpperCase() === c2.toUpperCase() &&
            parseInt(r1, 10) === SUM_START &&
            parseInt(r2, 10) !== SUM_END) {
          return `${c1}${r1}:${c2}${SUM_END}`;
        }
        return match;
      }
    );

    if (fixed !== formula) {
      const oldVal = cell.value;
      const oldResult = (oldVal && typeof oldVal === "object") ? oldVal.result : undefined;
      cell.value = oldResult != null ? { formula: fixed, result: oldResult } : { formula: fixed };
      fixCount++;
      console.log(`  col${c}(${colToLetter(c)}): ${formula} → ${fixed}`);
    }
  }
  console.log(`  SUM修正: ${fixCount}セル${fixCount === 0 ? "（既に済み）" : ""}`);

  // ────── 保存 ──────
  await wb.xlsx.writeFile(TEMPLATE);
  console.log(`\n✅ 保存完了: ${TEMPLATE}`);
}

main().catch(e => { console.error("エラー:", e); process.exit(1); });
