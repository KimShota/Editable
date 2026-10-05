import type { Metadata } from "next";
import { ConditionalNav } from "./_components/ConditionalNav";
import { Nav } from "./_components/Nav";
import "./globals.css";

export const metadata: Metadata = {
  title: "Katalab",
  description: "An AI character your brand owns, posting proven viral formats every day. Built on the method that got its founder 200K followers.",
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
          <ConditionalNav>
            <Nav />
          </ConditionalNav>
          {children}
        </div>
      </body>
    </html>
  );
}
