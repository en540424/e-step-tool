import { NextResponse } from "next/server";
import { getMonthlyWithholdingKoYen } from "@/app/_lib/payroll/tax/withholding";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const taxableIncomeYen = Number(body.taxableIncomeYen ?? 0);
    const dependentsCount = Number(body.dependentsCount ?? 0);
    const taxYear = Number(body.taxYear ?? 2026);

    if (!Number.isFinite(taxableIncomeYen) || taxableIncomeYen < 0) {
      return NextResponse.json({ error: "invalid_taxableIncomeYen" }, { status: 400 });
    }

    const result = await getMonthlyWithholdingKoYen({
      taxableIncomeYen,
      dependentsCount,
      taxYear,
    });

    return NextResponse.json(result);
  } catch (e: any) {
    return NextResponse.json(
      { error: "failed", message: e?.message ?? String(e) },
      { status: 500 }
    );
  }
}
