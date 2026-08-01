import type { Metadata } from "next";
import Script from "next/script";
import "./globals.css";

const themeScript = `
  try {
    const mode = localStorage.getItem("capybara-theme") || "system";
    const resolved = mode === "system"
      ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
      : mode;
    document.documentElement.dataset.themeMode = mode;
    document.documentElement.dataset.theme = resolved;
    document.documentElement.style.colorScheme = resolved;
    const locale = localStorage.getItem("capybara-locale") || "zh-CN";
    document.documentElement.dataset.locale = locale;
    document.documentElement.lang = locale;
  } catch (_) {}
`;

export const metadata: Metadata = {
  title: "Capybara",
  description: "Capybara agent development workspace",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="zh-CN"
      className="h-full antialiased"
      suppressHydrationWarning
    >
      <head>
        <Script id="capybara-theme" strategy="beforeInteractive">
          {themeScript}
        </Script>
      </head>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
