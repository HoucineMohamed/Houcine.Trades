import Link from 'next/link';

export default function HomePage() {
  return (
    <main style={{ maxWidth: 640 }}>
      <h1>Houcine.Trades</h1>
      <p>
        Private trading workspace. Mode: <strong>paper</strong>.
      </p>
      <ol>
        <li>
          Create a paper account in <Link href="/accounts">Accounts</Link>.
        </li>
        <li>
          Optionally add strategy tags in <Link href="/setups">Setups</Link>.
        </li>
        <li>
          Log a trade in <Link href="/trades/new">New trade</Link>, then follow it in{' '}
          <Link href="/trades">Trades</Link>.
        </li>
      </ol>
    </main>
  );
}
