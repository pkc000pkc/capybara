import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Capybara Workbench",
  description: "Capybara V2 user workbench",
};

export default function WorkbenchLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
