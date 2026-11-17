import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";

// Self-hosted so the app works offline. Limited to Arabic-script code points, so
// Persian uses Vazirmatn while Latin text keeps the system UI font.
const vazirmatn = localFont({
  src: "./fonts/vazirmatn-arabic.woff2",
  weight: "100 900",
  variable: "--font-vazirmatn",
  display: "swap",
  adjustFontFallback: false,
  declarations: [
    { prop: "unicode-range", value: "U+0600-06FF, U+0750-077F, U+0870-08FF, U+200C-200E, U+FB50-FDFF, U+FE70-FEFC" },
  ],
});

export const metadata: Metadata = {
  title: "Qwen Chat",
  description: "Chat with a local Qwen model through Ollama",
};

export const viewport: Viewport = {
  themeColor: "#212121",
  colorScheme: "dark",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${vazirmatn.variable} antialiased`}>
      <body>{children}</body>
    </html>
  );
}
