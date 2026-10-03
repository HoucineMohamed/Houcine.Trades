import { listSetups } from '@/data/setups';
import { requireDb } from '../_lib/db';
import { createSetupAction } from './actions';

export default async function SetupsPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const { ok, error } = await searchParams;
  const setups = listSetups(await requireDb());
  return (
    <main>
      <h1>Setups</h1>
      <p>A setup is a strategy tag (for example &quot;Breakout&quot;) used later for statistics.</p>
      {ok && <p role="status">✅ {ok}</p>}
      {error && <p role="alert">❌ {error}</p>}

      <h2>New setup</h2>
      <form action={createSetupAction}>
        <p>
          <label>
            Name <input name="name" required maxLength={60} />
          </label>
        </p>
        <p>
          <label>
            Description <input name="description" maxLength={500} size={60} />
          </label>
        </p>
        <button type="submit">Create setup</button>
      </form>

      <h2>Your setups</h2>
      {setups.length === 0 ? (
        <p>No setups yet.</p>
      ) : (
        <ul>
          {setups.map((s) => (
            <li key={s.id}>
              <strong>{s.name}</strong> {s.description && <>- {s.description}</>}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
