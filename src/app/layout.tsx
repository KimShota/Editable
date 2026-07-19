import type { Metadata } from "next";
import { ConditionalNav } from "./_components/ConditionalNav";
import "./globals.css";

export const metadata: Metadata = {
  title: "Editable",
  description: "Proven viral video formats, turned into fill-in-the-blank templates.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <div className="ambient" aria-hidden="true">
          <div className="ambient__mesh" />
          <div className="ambient__grain" />
        </div>
        <div className="app-shell">
          <ConditionalNav />
          {children}
        </div>
      </body>
    </html>
  );
}
