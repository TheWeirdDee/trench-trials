import type { Metadata, Viewport } from 'next';
import '@fontsource-variable/manrope';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/600.css';
import './globals.css';

export const metadata: Metadata = {
  title: 'Trench Trials — Decision-bias training for crypto traders',
  description:
    'Trench Trials measures how revealing a token’s identity changes a trader’s decision. Choose blind using Nansen onchain signals, see the tickers, then see what recognition gained or cost you.',
  icons: { icon: '/icon.svg' },
};

export const viewport: Viewport = {
  themeColor: '#050505',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-canvas font-sans text-cream antialiased">{children}</body>
    </html>
  );
}
