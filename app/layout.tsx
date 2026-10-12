import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "文风 · 让喜欢的文字留下来",
  description: "你的私人文字收藏夹。提取抖音分享文案，整理灵感，收藏值得重读的句子。",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="antialiased">{children}</body>
    </html>
  );
}
