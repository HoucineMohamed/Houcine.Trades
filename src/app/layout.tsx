import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Houcine.Trades',
  description: 'Private trading workspace',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          fontFamily: 'system-ui, sans-serif',
          background: '#0b0f14',
          color: '#e6edf3',
        }}
      >
        {children}
      </body>
    </html>
  );
}
