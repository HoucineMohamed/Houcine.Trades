import Link from 'next/link';
import { guardedPage } from './_lib/guard';

export default guardedPage(() => {
  return (
    <main className="narrow">
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
        <li>
          See numbers for your closed trades in <Link href="/stats">Stats</Link>.
        </li>
        <li>
          Set your safety limits and use the kill switch in <Link href="/risk">Risk</Link>.
        </li>
      </ol>
    </main>
  );
});
