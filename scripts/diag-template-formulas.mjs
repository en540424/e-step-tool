/**
 * diag-template-formulas.mjs
 * 行14〜37 の 1月列（I列=col9）の値・数式を全部出力
 */
import ExcelJS from "exceljs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = path.join(__dirname, "../app/_templates/wage-ledger-template.xlsx");

async function main() {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(TEMPLATE);
  const ws = wb.getWorksheet("賃金台帳") ?? wb.worksheets[0];

  console.log("=== 行14〜37 × I列(1月) の数式・値 ===");
  for (let r = 14; r <= 37; r++) {
    const cell = ws.getCell(r, 9); // I列
    const v = cell.value;
    const formula = (v && typeof v === "object") ? (v.formula || v.sharedFormula || null) : null;
    const val     = (v && typeof v === "object") ? v.result  : v;
    const label   = getCellText(ws.getCell(r, 1).value); // A列ラベル
    console.log(
      `  行${String(r).padStart(2)}: [${label || "　　"}]`,
      formula ? `formula="${formula}"` : `value=${JSON.stringify(val)}`
    );
  }
}

function getCellText(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object" && typeof v.text === "string") return v.text;
  if (typeof v === "object" && Array.isArray(v.richText)) return v.richText.map(t => t.text ?? "").join("");
  return String(v);
}

main().catch(e => { console.error(e); process.exit(1); });
