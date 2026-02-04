"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { calcLeaveAllowance } from "@/app/_lib/leave-allowance/engine";

function useIsNarrow(breakpointPx = 900) {
  const [isNarrow, setIsNarrow] = useState(false);

  useEffect(() => {
    const update = () => setIsNarrow(window.innerWidth < breakpointPx);
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [breakpointPx]);

  return isNarrow;
}

function daysInMonth(ym: string) {
  const [y, m] = ym.split("-").map((v) => Number(v));
  if (!y || !m) return 0;
  return new Date(y, m, 0).getDate(); // mは1-12
}

function toNum(v: string) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function ymShift(ym: string, diff: number) {
  const [y, m] = ym.split("-").map((v) => Number(v));
  if (!y || !m) return ym;
  const d = new Date(y, m - 1 + diff, 1);
  const yy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${yy}-${mm}`;
}

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

const labelWrap: React.CSSProperties = {
  display: "grid",
  gap: 6,
  marginBottom: 10,
};

const labelText: React.CSSProperties = { fontSize: 13, fontWeight: 700 };

const inputStyle: React.CSSProperties = {
  border: "1px solid #ccc",
  borderRadius: 10,
  padding: "10px 12px",
  fontSize: 14,
  outline: "none",
  width: "100%",
};

const help: React.CSSProperties = {
  fontSize: 12,
  color: "#666",
  marginTop: 6,
  lineHeight: 1.4,
};

const kpi: React.CSSProperties = {
  border: "1px solid #eee",
  borderRadius: 14,
  padding: 12,
  background: "#fafafa",
};

const kpiLabel: React.CSSProperties = { fontSize: 12, color: "#666", fontWeight: 800 };
const kpiValue: React.CSSProperties = { marginTop: 6, fontSize: 18, fontWeight: 900 };

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

function Kpi({ label, value }: { label: string; value: number }) {
  return (
    <div style={kpi}>
      <div style={kpiLabel}>{label}</div>
      <div style={kpiValue}>¥ {value.toLocaleString()}</div>
    </div>
  );
}

export default function LeaveAllowancePage() {
  const isNarrow = useIsNarrow(900);

  // 対象月（休業が発生した月）を起点に「直近3カ月」を作る
  const [targetYm, setTargetYm] = useState("2026-01");
  const m1 = useMemo(() => ymShift(targetYm, -3), [targetYm]);
  const m2 = useMemo(() => ymShift(targetYm, -2), [targetYm]);
  const m3 = useMemo(() => ymShift(targetYm, -1), [targetYm]);

  // 直近3カ月の入力（給与総額・出勤日数）
  const [pay1, setPay1] = useState(300000);
  const [att1, setAtt1] = useState(20);

  const [pay2, setPay2] = useState(200000);
  const [att2, setAtt2] = useState(25);

  const [pay3, setPay3] = useState(300000);
  const [att3, setAtt3] = useState(20);

  const [leaveDays, setLeaveDays] = useState(3);
  const rate = 0.6;

  const result = useMemo(() => {
    const months = [
      { ym: m1, payTotalYen: pay1, attendanceDays: att1, calendarDays: daysInMonth(m1) },
      { ym: m2, payTotalYen: pay2, attendanceDays: att2, calendarDays: daysInMonth(m2) },
      { ym: m3, payTotalYen: pay3, attendanceDays: att3, calendarDays: daysInMonth(m3) },
    ] as const;

    return calcLeaveAllowance({
      months,
      leaveDays,
      rate,
    });
  }, [m1, m2, m3, pay1, pay2, pay3, att1, att2, att3, leaveDays]);

  function sendToPayroll() {
    sessionStorage.setItem("leave_allowance_total_yen", String(result.allowanceTotalYen));
    sessionStorage.setItem("leave_allowance_target_ym", targetYm);
    sessionStorage.setItem("leave_allowance_audit_json", JSON.stringify(result.audit));
    location.href = "/payroll";
  }

  return (
    <main
      style={{
        padding: 24,
        fontFamily: "system-ui, sans-serif",
        maxWidth: 1100,
        margin: "0 auto",
      }}
    >
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
          alignItems: "flex-start",
        }}
      >
        <div style={{ minWidth: 260 }}>
          <h1 style={{ fontSize: 24, fontWeight: 900, margin: 0 }}>
            休業手当（平均賃金・Excel一致）
          </h1>
          <p style={{ color: "#555", marginTop: 8 }}>
            直近3カ月の「給与総額・暦日数・出勤日数」から、A/B を比較して高い方を採用 → ×0.6 → ×休業日数。
          </p>
       　S </div>

      　　</header>

      　　<section style={panel}>
       　 <h2 style={h2}>対象</h2>
       　 <label style={labelWrap}>
          <span style={labelText}>休業が発生した対象月（YYYY-MM）</span>
          <input value={targetYm} onChange={(e) => setTargetYm(e.target.value)} style={inputStyle} />
          <div style={help}>
            この月から「直近3カ月」を自動で作ります（{m1}, {m2}, {m3}）。
          </div>
        </label>
      </section>

      <section style={panel}>
        <h2 style={h2}>直近3カ月（手入力）</h2>

        <div
          style={{
            display: "grid",
            gap: 10,
            gridTemplateColumns: isNarrow ? "1fr" : "1fr 1fr 1fr",
          }}
        >
          <div>
            <div style={{ fontWeight: 900, marginBottom: 8 }}>{m1}</div>
            <Field label="給与総額（円）" value={pay1} setValue={setPay1} />
            <Field label="出勤日数（日）" value={att1} setValue={setAtt1} />
            <div style={help}>暦日数（自動）：{daysInMonth(m1)} 日</div>
          </div>

          <div>
            <div style={{ fontWeight: 900, marginBottom: 8 }}>{m2}</div>
            <Field label="給与総額（円）" value={pay2} setValue={setPay2} />
            <Field label="出勤日数（日）" value={att2} setValue={setAtt2} />
            <div style={help}>暦日数（自動）：{daysInMonth(m2)} 日</div>
          </div>

          <div>
            <div style={{ fontWeight: 900, marginBottom: 8 }}>{m3}</div>
            <Field label="給与総額（円）" value={pay3} setValue={setPay3} />
            <Field label="出勤日数（日）" value={att3} setValue={setAtt3} />
            <div style={help}>暦日数（自動）：{daysInMonth(m3)} 日</div>
          </div>
        </div>

        <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid #eee" }}>
          <h2 style={h2}>休業日数</h2>

          <div
            style={{
              display: "grid",
              gap: 10,
              gridTemplateColumns: isNarrow ? "1fr" : "1fr 1fr",
            }}
          >
            <Field label="実休業日数（日）" value={leaveDays} setValue={setLeaveDays} />
            <div />
          </div>

          <div style={help}>休業手当率：{rate * 100}%（固定）</div>
        </div>
      </section>

      <section style={panel}>
        <h2 style={h2}>結果</h2>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: isNarrow ? "1fr" : "1fr 1fr 1fr",
            gap: 10,
          }}
        >
          <Kpi label="平均賃金（日額）" value={result.adoptedDailyWageYen} />
          <Kpi label="休業手当（日額）" value={result.allowancePerDayYen} />
          <Kpi label="最終総額" value={result.allowanceTotalYen} />
        </div>

        <div style={{ marginTop: 12, color: "#333", fontSize: 13, lineHeight: 1.6 }}>
          <div>
            計算式A（日額）＝ SUM(給与総額) ÷ SUM(暦日数) ＝{" "}
            <b>¥ {result.audit.formulaA_dailyWage.toLocaleString()}</b>
          </div>
          <div>
            計算式B（日額）＝ (SUM(給与総額) ÷ SUM(出勤日数)) × 0.6 ＝{" "}
            <b>¥ {result.audit.formulaB_dailyWage.toLocaleString()}</b>
          </div>
          <div>
            採用（日額）＝ max(A,B) ＝{" "}
            <b>¥ {result.audit.adoptedDailyWage.toLocaleString()}</b>
          </div>
        </div>

        <div style={{ marginTop: 12, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <button onClick={sendToPayroll} style={{ ...btn, borderColor: "#111", fontWeight: 900 }}>
            給与計算へ反映（手当として渡す）
          </button>
          <div style={help}>sessionStorage に保存して /payroll に遷移します。</div>
        </div>

        <details style={{ marginTop: 12 }}>
          <summary style={{ cursor: "pointer", fontWeight: 900 }}>監査ログ（audit JSON）</summary>
          <pre
            style={{
              marginTop: 10,
              background: "#fafafa",
              padding: 12,
              borderRadius: 10,
              overflowX: "auto",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {JSON.stringify(result.audit, null, 2)}
          </pre>
        </details>
      </section>
    </main>
  );
}
