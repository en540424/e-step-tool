"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { getSupabaseClient } from "@/app/_lib/supabase/client";
import type { EmploymentType } from "@/app/_lib/payroll/types";

type EmployeeRow = {
  id: string;
  code: string | null;
  name: string;
  employment_type: EmploymentType; // "monthly" | "daily" | "hourly"
  base_salary_yen: number;
  daily_wage_yen: number;
  hourly_rate_yen: number | null; // numeric
  fixed_ot_allowance_yen: number;
  fixed_ot_hours: number; // numeric
  effective_from: string; // YYYY-MM-DD
  is_active: boolean;
  created_at?: string;
  updated_at?: string;
};

function toNum(v: string, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function todayYYYYMMDD() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export default function EmployeesPage() {
  const sb = useMemo(() => getSupabaseClient(), []);

  const [loading, setLoading] = useState(true);
  const [bootError, setBootError] = useState<string | null>(null);
  const [rows, setRows] = useState<EmployeeRow[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");

  const selected = useMemo(
    () => rows.find((r) => r.id === selectedId) ?? null,
    [rows, selectedId]
  );

  // フォームは string で保持（入力が安定）
  const [form, setForm] = useState({
    id: "",
    code: "",
    name: "",
    employment_type: "monthly" as EmploymentType,
    base_salary_yen: "0",
    daily_wage_yen: "0",
    hourly_rate_yen: "",
    fixed_ot_allowance_yen: "0",
    fixed_ot_hours: "0",
    effective_from: todayYYYYMMDD(),
    is_active: true,
  });

  const [message, setMessage] = useState<string | null>(null);
  const [warn, setWarn] = useState<string | null>(null);

  const [showDeleted, setShowDeleted] = useState(false);

  // 削除2段確認
  const [deleteStep, setDeleteStep] = useState<0 | 1 | 2>(0);
  const [deleteTarget, setDeleteTarget] = useState<EmployeeRow | null>(null);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");

  // 復元確認
  const [restoreTarget, setRestoreTarget] = useState<EmployeeRow | null>(null);

  function flash(msg: string) {
    setMessage(msg);
    setTimeout(() => setMessage(null), 1500);
  }

  async function reload() {
    if (!sb) return;
    setBootError(null);
    setLoading(true);

    const q = sb
      .from("employees")
      .select(
        "id,code,name,employment_type,base_salary_yen,daily_wage_yen,hourly_rate_yen,fixed_ot_allowance_yen,fixed_ot_hours,effective_from,is_active,created_at,updated_at"
      )
      .order("name");

    const { data, error } = showDeleted
      ? await q // 全件
      : await q.eq("is_active", true); // 有効のみ

    setLoading(false);

    if (error) {
      setBootError(error.message);
      return;
    }
    setRows((data ?? []) as any);
  }

  // 初期ロード
  useEffect(() => {
    (async () => {
      if (!sb) {
        setLoading(false);
        setBootError("Supabase 未設定です（.env.local を設定して再起動してください）");
        return;
      }
      await reload();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sb]);

  // showDeleted 変更時に再読み込み
  useEffect(() => {
    if (sb && !loading) reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showDeleted]);

  // 選択→フォーム反映
  useEffect(() => {
    if (!selected) return;

    setForm({
      id: selected.id,
      code: selected.code ?? "",
      name: selected.name ?? "",
      employment_type: (selected.employment_type ?? "monthly") as EmploymentType,
      base_salary_yen: String(selected.base_salary_yen ?? 0),
      daily_wage_yen: String(selected.daily_wage_yen ?? 0),
      hourly_rate_yen: selected.hourly_rate_yen == null ? "" : String(selected.hourly_rate_yen),
      fixed_ot_allowance_yen: String(selected.fixed_ot_allowance_yen ?? 0),
      fixed_ot_hours: String(selected.fixed_ot_hours ?? 0),
      effective_from: selected.effective_from ?? todayYYYYMMDD(),
      is_active: Boolean(selected.is_active),
    });

    setWarn(null);
  }, [selected]);

  // ✅ 黄色警告：monthly/daily なのに残業単価(hourly_rate_yen)が空
  useEffect(() => {
    const empType = form.employment_type;
    const hr = toNum(form.hourly_rate_yen || "0", 0);

    if ((empType === "monthly" || empType === "daily") && hr <= 0) {
      setWarn("⚠ 月給/日給なのに『残業単価（hourly_rate_yen）』が未入力です。残業計算に必要です。");
      return;
    }
    setWarn(null);
  }, [form.employment_type, form.hourly_rate_yen]);

  function newEmployee() {
    setSelectedId("");
    setForm({
      id: "",
      code: "",
      name: "",
      employment_type: "monthly",
      base_salary_yen: "0",
      daily_wage_yen: "0",
      hourly_rate_yen: "",
      fixed_ot_allowance_yen: "0",
      fixed_ot_hours: "0",
      effective_from: todayYYYYMMDD(),
      is_active: true,
    });
    setWarn(null);
    flash("新規作成モード");
  }

  async function save() {
    if (!sb) return alert("Supabase 未設定です（.env.local を確認）");
    if (!form.name.trim()) return alert("氏名を入力してください");

    // 最低限の確認
    if (form.employment_type === "monthly" && toNum(form.base_salary_yen) <= 0) {
      if (!confirm("月給が 0 円です。保存しますか？")) return;
    }
    if (form.employment_type === "hourly" && toNum(form.hourly_rate_yen || "0") <= 0) {
      if (!confirm("時給が 0 円です。保存しますか？")) return;
    }

    const payload: Partial<EmployeeRow> = {
      id: form.id || undefined,
      code: form.code.trim() ? form.code.trim() : null,
      name: form.name.trim(),
      employment_type: form.employment_type,
      base_salary_yen: toNum(form.base_salary_yen, 0),
      daily_wage_yen: toNum(form.daily_wage_yen, 0),
      hourly_rate_yen: form.hourly_rate_yen.trim() ? Number(form.hourly_rate_yen) : null,
      fixed_ot_allowance_yen: toNum(form.fixed_ot_allowance_yen, 0),
      fixed_ot_hours: Number(form.fixed_ot_hours || 0),
      effective_from: form.effective_from || todayYYYYMMDD(),
      is_active: Boolean(form.is_active),
    };

    const { data, error } = await sb
      .from("employees")
      .upsert(payload as any, { onConflict: "id" })
      .select("id")
      .maybeSingle();

    if (error) return alert(`保存エラー: ${error.message}`);

    if (!form.id && data?.id) setSelectedId(data.id);

    await reload();
    flash("保存しました");
  }

  async function softDeleteEmployee(emp: EmployeeRow, reason?: string) {
    if (!sb) return;
    const { error } = await sb
      .from("employees")
      .update({
        is_active: false,
        deleted_at: new Date().toISOString(),
        deleted_reason: reason ?? null,
      })
      .eq("id", emp.id);

    if (error) alert(`削除エラー: ${error.message}`);
  }

  async function restoreEmployee(emp: EmployeeRow) {
    if (!sb) return;
    const { error } = await sb
      .from("employees")
      .update({
        is_active: true,
        deleted_at: null,
        deleted_reason: null,
      })
      .eq("id", emp.id);

    if (error) alert(`復元エラー: ${error.message}`);
  }

  async function toggleActive(next: boolean) {
    if (!sb) return;
    if (!form.id) return alert("従業員を選択してください");

    const { error } = await sb.from("employees").update({ is_active: next }).eq("id", form.id);
    if (error) return alert(`更新エラー: ${error.message}`);

    setForm((p) => ({ ...p, is_active: next }));
    await reload();
    flash(next ? "有効にしました" : "無効にしました");
  }

  return (
    <main style={{ padding: 24, fontFamily: "system-ui, sans-serif" }}>
      
      　{!sb && (
        <section style={panel}>
          <div style={{ color: "#a40000", fontWeight: 900 }}>Supabase 未設定です</div>
          <div style={{ color: "#555", marginTop: 8, lineHeight: 1.6 }}>
            <div>`.env.local` に以下を設定して dev サーバを再起動：</div>
            <pre style={{ background: "#fafafa", padding: 12, borderRadius: 10, overflowX: "auto" }}>
{`NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...`}
            </pre>
          </div>
        </section>
      )}

      {sb && bootError && (
        <section style={errorBox}>
          <div style={{ fontWeight: 900 }}>読み込みエラー</div>
          <div style={{ marginTop: 6 }}>{bootError}</div>
        </section>
      )}

      {message && <div style={{ ...panel, borderColor: "#111" }}>{message}</div>}

      {sb && loading && <section style={panel}>読み込み中…</section>}

      {sb && !loading && !bootError && (
        <div style={{ display: "grid", gridTemplateColumns: "360px 1fr", gap: 12, marginTop: 12 }}>
          {/* 左：一覧 */}
          <section style={panel}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button type="button" style={btn} onClick={newEmployee}>＋ 新規</button>
              <button type="button" style={btn} onClick={reload}>↻ 再読込</button>
            </div>

            <div style={{ marginTop: 12 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, marginBottom: 8 }}>
                <input
                  type="checkbox"
                  checked={showDeleted}
                  onChange={(e) => setShowDeleted(e.target.checked)}
                />
                削除済みも表示
              </label>

              <div style={{ fontSize: 12, color: "#666", fontWeight: 800 }}>従業員一覧</div>

              <select
                value={selectedId}
                onChange={(e) => setSelectedId(e.target.value)}
                style={{ ...input, width: "100%", marginTop: 6 }}
              >
                <option value="">選択してください</option>
                {rows.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name} {r.is_active ? "" : "（削除済）"}
                  </option>
                ))}
              </select>

              <div style={{ marginTop: 10, fontSize: 12, color: "#666" }}>
                件数：{rows.length}
              </div>
            </div>
          </section>

          {/* 右：編集 */}
          <section style={panel}>
            <h2 style={h2}>雇用条件（通知書の内容）</h2>

            {warn && (
              <div style={warnBox}>{warn}</div>
            )}

            <div style={{ display: "grid", gap: 10, gridTemplateColumns: "1fr 1fr" }}>
              <label style={labelWrap}>
                <span style={labelText}>社員コード（任意）</span>
                <input
                  value={form.code}
                  onChange={(e) => setForm((p) => ({ ...p, code: e.target.value }))}
                  style={input}
                  placeholder="例：E001"
                />
              </label>

              <label style={labelWrap}>
                <span style={labelText}>氏名</span>
                <input
                  value={form.name}
                  onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                  style={input}
                  placeholder="例：テスト従業員"
                />
              </label>

              <label style={labelWrap}>
                <span style={labelText}>雇用形態</span>
                <select
                  value={form.employment_type}
                  onChange={(e) =>
                    setForm((p) => ({ ...p, employment_type: e.target.value as EmploymentType }))
                  }
                  style={input}
                >
                  <option value="monthly">月給</option>
                  <option value="daily">日給</option>
                  <option value="hourly">時給</option>
                </select>
              </label>

              <label style={labelWrap}>
                <span style={labelText}>適用開始日</span>
                <input
                  value={form.effective_from}
                  onChange={(e) => setForm((p) => ({ ...p, effective_from: e.target.value }))}
                  style={input}
                  placeholder="YYYY-MM-DD"
                />
              </label>
            </div>

            <hr style={{ margin: "14px 0", border: "none", borderTop: "1px solid #eee" }} />

            <h2 style={h2}>基本給・単価</h2>

            <div style={{ display: "grid", gap: 10, gridTemplateColumns: "1fr 1fr" }}>
              <label style={labelWrap}>
                <span style={labelText}>月給（円）</span>
                <input
                  inputMode="numeric"
                  value={form.base_salary_yen}
                  onChange={(e) => setForm((p) => ({ ...p, base_salary_yen: e.target.value }))}
                  style={input}
                  disabled={form.employment_type !== "monthly"}
                />
              </label>

              <label style={labelWrap}>
                <span style={labelText}>日給（円）</span>
                <input
                  inputMode="numeric"
                  value={form.daily_wage_yen}
                  onChange={(e) => setForm((p) => ({ ...p, daily_wage_yen: e.target.value }))}
                  style={input}
                  disabled={form.employment_type !== "daily"}
                />
              </label>

              <label style={labelWrap}>
                <span style={labelText}>残業単価（hourly_rate_yen）（円/時）</span>
                <input
                  inputMode="numeric"
                  value={form.hourly_rate_yen}
                  onChange={(e) => setForm((p) => ({ ...p, hourly_rate_yen: e.target.value }))}
                  style={input}
                  placeholder="例：1958"
                />
                <div style={help}>
                  ✅ あなたの方針：残業割増計算専用（monthly/daily はここ必須）
                </div>
              </label>
            </div>

            <hr style={{ margin: "14px 0", border: "none", borderTop: "1px solid #eee" }} />

            <h2 style={h2}>固定残業（通知書の内容）</h2>

            <div style={{ display: "grid", gap: 10, gridTemplateColumns: "1fr 1fr" }}>
              <label style={labelWrap}>
                <span style={labelText}>固定残業代（円）</span>
                <input
                  inputMode="numeric"
                  value={form.fixed_ot_allowance_yen}
                  onChange={(e) => setForm((p) => ({ ...p, fixed_ot_allowance_yen: e.target.value }))}
                  style={input}
                />
              </label>

              <label style={labelWrap}>
                <span style={labelText}>固定残業時間（時間）</span>
                <input
                  inputMode="numeric"
                  value={form.fixed_ot_hours}
                  onChange={(e) => setForm((p) => ({ ...p, fixed_ot_hours: e.target.value }))}
                  style={input}
                />
              </label>
            </div>

            <hr style={{ margin: "14px 0", border: "none", borderTop: "1px solid #eee" }} />

            <h2 style={h2}>状態</h2>

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button type="button" style={primaryBtn} onClick={save}>
                保存（employees）
              </button>

              {selected?.is_active && (
                <button
                  type="button"
                  style={{ ...btn, borderColor: "#a40000", color: "#a40000" }}
                  onClick={() => {
                    setDeleteTarget(selected);
                    setDeleteStep(1);
                    setDeleteConfirmText("");
                  }}
                >
                  削除
                </button>
              )}

              {selected && !selected.is_active && (
                <button
                  type="button"
                  style={{ ...btn, borderColor: "#111", fontWeight: 900 }}
                  onClick={() => setRestoreTarget(selected)}
                >
                  復元
                </button>
              )}
            </div>

            <div style={{ marginTop: 10, fontSize: 12, color: "#666", lineHeight: 1.6 }}>
              <div>✅ 運用ルール：</div>
              <div>・ここは「通知書のベース」を登録する場所</div>
              <div>・手当/控除などの追加は Payroll 画面で月次入力して仕上げる</div>
            </div>
          </section>
        </div>
      )}

      {/* --- 削除確認モーダル（2段） --- */}
      {deleteStep > 0 && deleteTarget && (
        <div style={modalBackdrop}>
          <div style={modalCard}>
            <div style={{ fontWeight: 900, fontSize: 16 }}>
              {deleteStep === 1 ? "削除の確認" : "最終確認"}
            </div>

            {deleteStep === 1 && (
              <>
                <p style={{ marginTop: 10, color: "#333", lineHeight: 1.6 }}>
                  「{deleteTarget.name}」を削除します。<br />
                  ※ データは消えず、一覧から非表示（復元可能）になります。
                </p>

                <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                  <button
                    type="button"
                    style={btn}
                    onClick={() => {
                      setDeleteStep(0);
                      setDeleteTarget(null);
                    }}
                  >
                    キャンセル
                  </button>
                  <button
                    type="button"
                    style={{ ...btn, borderColor: "#a40000", color: "#a40000", fontWeight: 900 }}
                    onClick={() => setDeleteStep(2)}
                  >
                    削除に進む
                  </button>
                </div>
              </>
            )}

            {deleteStep === 2 && (
              <>
                <p style={{ marginTop: 10, color: "#333", lineHeight: 1.6 }}>
                  誤操作防止のため、下に <b>氏名</b> を入力してください。<br />
                  入力が一致したら削除を実行します。
                </p>

                <input
                  style={{ ...input, marginTop: 10, width: "100%" }}
                  placeholder={`「${deleteTarget.name}」と入力`}
                  value={deleteConfirmText}
                  onChange={(e) => setDeleteConfirmText(e.target.value)}
                />

                <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                  <button
                    type="button"
                    style={btn}
                    onClick={() => setDeleteStep(1)}
                  >
                    戻る
                  </button>

                  <button
                    type="button"
                    style={{
                      ...btn,
                      borderColor: "#a40000",
                      color: "#a40000",
                      fontWeight: 900,
                      opacity: deleteConfirmText === deleteTarget.name ? 1 : 0.5,
                      cursor: deleteConfirmText === deleteTarget.name ? "pointer" : "not-allowed",
                    }}
                    disabled={deleteConfirmText !== deleteTarget.name}
                    onClick={async () => {
                      await softDeleteEmployee(deleteTarget);
                      setDeleteStep(0);
                      setDeleteTarget(null);
                      setDeleteConfirmText("");
                      setSelectedId("");
                      newEmployee();
                      await reload();
                      flash("削除しました（復元可能）");
                    }}
                  >
                    削除する
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* --- 復元確認モーダル --- */}
      {restoreTarget && (
        <div style={modalBackdrop}>
          <div style={modalCard}>
            <div style={{ fontWeight: 900, fontSize: 16 }}>復元の確認</div>
            <p style={{ marginTop: 10, color: "#333", lineHeight: 1.6 }}>
              「{restoreTarget.name}」を復元します。<br />
              ※ 雇用条件・単価などはそのまま戻ります。
            </p>

            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <button type="button" style={btn} onClick={() => setRestoreTarget(null)}>
                キャンセル
              </button>
              <button
                type="button"
                style={{ ...btn, borderColor: "#111", fontWeight: 900 }}
                onClick={async () => {
                  await restoreEmployee(restoreTarget);
                  setRestoreTarget(null);
                  await reload();
                  flash("復元しました");
                }}
              >
                復元する
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

/* styles */
const panel: React.CSSProperties = {
  border: "1px solid #ddd",
  borderRadius: 14,
  padding: 14,
  marginTop: 14,
  background: "#fff",
};
const h2: React.CSSProperties = { margin: 0, marginBottom: 12, fontSize: 16, fontWeight: 900 };
const btn: React.CSSProperties = {
  border: "1px solid #ccc",
  borderRadius: 10,
  padding: "8px 12px",
  background: "#fff",
  cursor: "pointer",
  textDecoration: "none",
  color: "#111",
  display: "inline-block",
  fontWeight: 700,
};
const primaryBtn: React.CSSProperties = { ...btn, borderColor: "#111", fontWeight: 900 };
const labelWrap: React.CSSProperties = { display: "grid", gap: 6 };
const labelText: React.CSSProperties = { fontSize: 13, fontWeight: 800 };
const input: React.CSSProperties = {
  border: "1px solid #ccc",
  borderRadius: 10,
  padding: "10px 12px",
  fontSize: 14,
  outline: "none",
};
const help: React.CSSProperties = { fontSize: 12, color: "#666", marginTop: 4, lineHeight: 1.4 };
const errorBox: React.CSSProperties = {
  border: "1px solid #f0caca",
  background: "#fff7f7",
  borderRadius: 10,
  padding: "10px 12px",
  color: "#a40000",
  fontSize: 13,
};
const warnBox: React.CSSProperties = {
  border: "1px solid #f3e6a1",
  background: "#fffbe6",
  borderRadius: 10,
  padding: "10px 12px",
  color: "#6b5200",
  fontSize: 13,
  fontWeight: 800,
  marginBottom: 10,
};
const modalBackdrop: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.35)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 16,
  zIndex: 50,
};
const modalCard: React.CSSProperties = {
  width: "min(520px, 100%)",
  background: "#fff",
  borderRadius: 14,
  border: "1px solid #ddd",
  padding: 14,
};
