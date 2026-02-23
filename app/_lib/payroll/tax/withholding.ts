import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@supabase/supabase-js";

export type WithholdingType = "KO" | "OTSU";

type Args = {
  taxableIncomeYen: number;
  dependentsCount: number; // 0〜7
  taxYear: number;         // 2026 など
};

function clampDependents(n: number) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(7, Math.floor(n)));
}

export type WithholdingResult = {
  yen: number;
  status: "ok" | "no_table";
};

/**
 * API Route から呼ぶ用：1件の税額を返す
 * 税表は「読み取りだけ」なので anon でOK（RLSでSELECT許可してある前提）
 */
export async function getMonthlyWithholdingKoYen(args: Args): Promise<WithholdingResult> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl) throw new Error("NEXT_PUBLIC_SUPABASE_URL is required.");
  if (!anonKey) throw new Error("NEXT_PUBLIC_SUPABASE_ANON_KEY is required.");

  const taxableIncomeYen = Math.floor(args.taxableIncomeYen);
  const dependentsCount = clampDependents(args.dependentsCount);
  const taxYear = Math.floor(args.taxYear);

  const supabase = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false },
  });

  const depCol = `dep${dependentsCount}` as const;

  const { data, error } = await supabase
    .from("withholding_monthly_ko")
    .select(`taxable_min,taxable_max,${depCol}`)
    .eq("tax_year", taxYear)
    .eq("pay_type", "monthly")
    .lte("taxable_min", taxableIncomeYen)
    .gt("taxable_max", taxableIncomeYen) // taxable_min <= income < taxable_max
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(error.message);

  if (!data) {
    return { yen: 0, status: "no_table" };
  }

  const yen = Number((data as any)[depCol] ?? 0);
  return {
    yen: Number.isFinite(yen) ? yen : 0,
    status: "ok",
  };
}

export async function lookupMonthlyIncomeTaxKo(opts: {
  sb: SupabaseClient;
  year: number;
  taxableYen: number;
  dependentsCount: number; // 0..7（7以上は7扱い）
}): Promise<{ yen: number; status: "ok" | "not_configured" | "not_found" }> {
  const dep = Math.max(0, Math.min(7, Math.floor(opts.dependentsCount || 0)));

  // ✅ 税額表が未投入の場合に備えて存在チェック
  const { data, error } = await opts.sb
    .from("withholding_monthly_ko")
    .select("taxable_min,taxable_max,dep0,dep1,dep2,dep3,dep4,dep5,dep6,dep7")
    .eq("tax_year", opts.year)
    .eq("pay_type", "monthly")
    .lte("taxable_min", opts.taxableYen)
    .gt("taxable_max", opts.taxableYen) // taxable_max は「含まない」運用
    .limit(1)
    .maybeSingle();

  if (error) return { yen: 0, status: "not_configured" };
  if (!data) return { yen: 0, status: "not_found" };

  const yen =
    dep === 0 ? data.dep0 :
    dep === 1 ? data.dep1 :
    dep === 2 ? data.dep2 :
    dep === 3 ? data.dep3 :
    dep === 4 ? data.dep4 :
    dep === 5 ? data.dep5 :
    dep === 6 ? data.dep6 :
    data.dep7;

  return { yen: Number(yen || 0), status: "ok" };
}
