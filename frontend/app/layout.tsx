import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Callahan CI — AI-Native CI/CD Platform",
  description: "Open-source, serverless CI/CD with built-in AI agents. Run locally in under 60 seconds.",
  keywords: ["CI/CD", "DevOps", "AI", "Jenkins", "GitHub Actions", "serverless", "open source"],
  authors: [{ name: "Callahan CI" }],
  openGraph: {
    title: "Callahan CI",
    description: "AI-native, serverless CI/CD. Local-first. Zero cloud required.",
    type: "website",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="antialiased bg-background text-foreground">
        {children}
      </body>
    </html>
  );
}
