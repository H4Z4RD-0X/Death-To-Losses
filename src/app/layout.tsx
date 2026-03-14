import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import Script from "next/script";
import "./globals.css";

export const viewport: Viewport = {
  themeColor: "#0a0a0b",
  width: "device-width",
  initialScale: 1,
};

export const metadata: Metadata = {
  title: "Death to Losses - Smart Money Option Chain Tracker",
  description: "Advanced live option chain tracker identifying FII/PRO vs Retail traps. Decode smart money flow with real-time participant analysis and Nifty/BankNifty levels.",
  keywords: ["option chain", "smart money tracker", "FII DII data", "Nifty live option chain", "options trading traps", "retail vs pro trading", "Indian stock market analysis"],
  authors: [{ name: "Death to Losses Team" }],
  openGraph: {
    title: "Death to Losses - Decode Smart Money in Options",
    description: "Stop being the liquidity. Track FII/PRO positions in real-time and avoid retail traps.",
    url: "https://deathtolosses.com",
    siteName: "Death to Losses",
    images: [
      {
        url: "/og-image.png",
        width: 1200,
        height: 630,
        alt: "Death to Losses App Preview",
      },
    ],
    locale: "en_IN",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Death to Losses - Stop Being the Liquidity",
    description: "Live Smart Money Tracker for Nifty/BankNifty. See where FIIs and PROs are actually positioned.",
    images: ["/og-image.png"],
  },
  robots: {
    index: true,
    follow: true,
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    "name": "Death to Losses",
    "operatingSystem": "Web",
    "applicationCategory": "FinanceApplication",
    "offers": {
      "@type": "Offer",
      "price": "0",
      "priceCurrency": "INR"
    },
    "description": "Smart Money Option Chain Tracker identifying institutional positioning vs retail traps."
  };

  return (
    <html lang="en">
      <head>
        <Script
          id="json-ld"
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
