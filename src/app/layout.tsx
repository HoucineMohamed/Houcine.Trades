import Link from 'next/link';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { DatabaseNotReadyError } from '@/data/client';
import { requireDb } from './_lib/db';

export const metadata: Metadata = {
  title: 'Houcine.Trades',
  description: 'Private trading workspace',
};

async function databaseProblem(): Promise<string | null> {
  try {
    await requireDb();
    return null;
  } catch (error) {
    if (error instanceof DatabaseNotReadyError) return error.message;
    throw error;
  }
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const problem = await databaseProblem();
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
        <div style={{ background: '#5c1d1d', padding: '0.5rem 1rem' }} role="alert">
          <strong>LOCALHOST ONLY.</strong> This app has no login yet (module 4). Never deploy it or
          expose it to a network until authentication exists. Paper mode only.
        </div>
        <nav style={{ display: 'flex', gap: '1rem', padding: '0.75rem 1rem' }}>
          <Link href="/">Home</Link>
          <Link href="/trades">Trades</Link>
          <Link href="/trades/new">New trade</Link>
          <Link href="/stats">Stats</Link>
          <Link href="/risk">Risk</Link>
          <Link href="/accounts">Accounts</Link>
          <Link href="/setups">Setups</Link>
        </nav>
        <div style={{ padding: '0 1rem 3rem' }}>
          {problem ? (
            <main>
              <h1>Database not set up</h1>
              <p>{problem}</p>
            </main>
          ) : (
            children
          )}
        </div>
      </body>
    </html>
  );
}
