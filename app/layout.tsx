import type { Metadata, Viewport } from "next";
import { defaultTheme } from "./themes";
import { Geist, Geist_Mono } from "next/font/google";
import "maplibre-gl/dist/maplibre-gl.css";
import "./globals.css";
import "./operations-theme.css";
import "./default-theme.css";
import "./responsive.css";
import "./array-grid.css";
import "./foundry-theme.css";
import "./issue-visibility.css";
import "./jade-theme.css";
import "./maintenance.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover" };

export const metadata: Metadata = {
  metadataBase: new URL(process.env.SOL_PUBLIC_URL || "http://localhost:3080"),
  title: "Sol Diagnostics",
  description: "Solar site diagnostics that identify performance issues and quantify estimated energy losses.",
  openGraph: {
    title: "Sol Diagnostics",
    description: "Detect issues. Quantify energy loss.",
    images: [{ url: "/og.png", width: 1731, height: 909, alt: "Sol Diagnostics solar performance diagnostics" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Sol Diagnostics",
    description: "Detect issues. Quantify energy loss.",
    images: ["/og.png"],
  },
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
    <html lang="en" data-theme={defaultTheme}>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
