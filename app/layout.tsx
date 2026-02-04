import React from "react";
import "./globals.css";
import { AppShell } from "./_components/AppShell";

export const metadata = {
  title: "E-STEP 給与計算",
  description: "E-STEP TOOL",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
