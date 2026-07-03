import type { ReactNode } from "react";
import global from "@/content/global";
import { Footer } from "./Footer";
import "./globals.css";

export const metadata = { title: global.siteName };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <Footer />
      </body>
    </html>
  );
}
