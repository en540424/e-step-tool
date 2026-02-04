"use client";

import React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

const btnBase: React.CSSProperties = {
  border: "1px solid #ccc",
  borderRadius: 10,
  padding: "8px 12px",
  background: "#fff",
  cursor: "pointer",
  textDecoration: "none",
  color: "#111",
  display: "inline-block",
  fontWeight: 800,
  fontSize: 14,
};

function NavLink({
  href,
  label,
}: {
  href: string;
  label: string;
}) {
  const pathname = usePathname() || "/";
  const active =
    pathname === href || (href !== "/" && pathname.startsWith(href));

  const style: React.CSSProperties = {
    ...btnBase,
    borderColor: active ? "#111" : "#ccc",
    background: active ? "#f3f3f3" : "#fff",
  };

  return (
    <Link href={href} style={style}>
      {label}
    </Link>
  );
}

const navItems = [
  { label: "従業員", href: "/employees" },
  { label: "給与計算", href: "/payroll" },
  { label: "休業手当", href: "/leave-allowance" },
  { label: "設定", href: "/settings" },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        minHeight: "100dvh",
        background: "#f7f7f8",
      }}
    >
      <header
        style={{
          position: "sticky",
          top: 0,
          zIndex: 10,
          background: "rgba(247,247,248,0.92)",
          backdropFilter: "blur(8px)",
          borderBottom: "1px solid #e5e5e5",
        }}
      >
        <div
          style={{
            maxWidth: 1100,
            margin: "0 auto",
            padding: "14px 24px",
            display: "flex",
            justifyContent: "space-between",
            gap: 12,
            flexWrap: "wrap",
            alignItems: "center",
          }}
        >
          <div style={{ display: "grid", gap: 4, minWidth: 220 }}>
            <div style={{ fontWeight: 900, fontSize: 16, lineHeight: 1.2 }}>
              E-STEP 給与計算
            </div>
            <div style={{ fontSize: 12, color: "#666" }}>
              入力 → 計算/確認 → 保存/出力
            </div>
          </div>

          <nav style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {navItems.map((item) => (
              <NavLink key={item.href} href={item.href} label={item.label} />
            ))}
          </nav>
        </div>
      </header>

      <main
        style={{
          maxWidth: 1100,
          margin: "0 auto",
          padding: "18px 24px 40px",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        {children}
      </main>

      <footer
        style={{
          maxWidth: 1100,
          margin: "0 auto",
          padding: "16px 24px 28px",
          color: "#777",
          fontSize: 12,
        }}
      >
        © E-STEP TOOL
      </footer>
    </div>
  );
}
