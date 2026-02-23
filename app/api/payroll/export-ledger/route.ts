// app/api/payroll/export-ledger/route.ts
import { NextResponse } from "next/server";

export const runtime = "nodejs";

/**
 * GET /api/payroll/export-ledger?employeeId=xxx&year=2026
 * 旧：自前フォーマット生成
 * 新：テンプレ方式に統一（export-ledger-template と同じ出力）
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const employeeId = searchParams.get("employeeId");
  const year = Number(searchParams.get("year") ?? new Date().getFullYear());

  if (!employeeId) {
    return NextResponse.json({ error: "employeeId is required" }, { status: 400 });
  }

  // 同一サーバ内で POST を叩く（Next.js内のAPI呼び出し）
  const res = await fetch(new URL("/api/payroll/export-ledger-template", req.url), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ employeeId, year }),
  });

  // そのまま返す
  const buf = await res.arrayBuffer();
  const uint8 = new Uint8Array(buf);

  const headers = new Headers(res.headers);
  // 念のため Content-Length は付け直し
  headers.set("Content-Length", String(uint8.byteLength));
  // ブラウザキャッシュ防止（GET なので必須）
  headers.set("Cache-Control", "no-store, no-cache, must-revalidate");

  return new NextResponse(uint8, { status: res.status, headers });
}
