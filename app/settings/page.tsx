// app/settings/page.tsx
import Link from "next/link";

export default function SettingsPage() {
  return (
    <main style={{ padding: 24, fontFamily: "system-ui, sans-serif" }}>
      <section style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 900, marginBottom: 8 }}>
          設定（会社共通ルール・確認用）
        </h1>

        <p style={{ fontSize: 13, color: "#555", lineHeight: 1.6 }}>
          このページは、給与計算に使用される
          <b> 割増率・36協定の上限・手当／控除テンプレ </b>
          などの
          <b>現在の会社共通ルールを確認するためのページ</b>です。
          <br />
          ※ 編集機能は今後、管理者向けに実装予定です。
        </p>
      </section>

      <section
        style={{
          border: "1px solid #ddd",
          borderRadius: 12,
          padding: 16,
          background: "#fff",
        }}
      >
        <h2 style={{ fontSize: 16, fontWeight: 900, marginBottom: 12 }}>
          現在の設定内容（確認）
        </h2>

        <ul style={{ fontSize: 13, lineHeight: 1.8, color: "#333", paddingLeft: 16 }}>
          <li>
            <b>割増率（法令）</b>
            <br />
            ・法定外残業：25%<br />
            ・月60時間超：50%<br />
            ・深夜（22:00〜5:00）：25%
          </li>

          <li style={{ marginTop: 10 }}>
            <b>36協定の上限</b>
            <br />
            ・月45時間 / 年360時間<br />
            ・特別条項：月75時間 / 年720時間（年6回まで）
          </li>

          <li style={{ marginTop: 10 }}>
            <b>手当・控除テンプレ</b>
            <br />
            ・給与計算画面での手入力を基本とし、将来テンプレ管理を予定
          </li>
        </ul>
      </section>
    </main>
  );
}

const panel: React.CSSProperties = {
  border: "1px solid #ddd",
  borderRadius: 14,
  padding: 14,
  marginTop: 14,
  background: "#fff",
};

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
