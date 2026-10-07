import { listSetups } from '@/data/setups';
import { guardedPage } from '../_lib/guard';
import { createSetupAction } from './actions';

export default guardedPage(
  async (ctx, { searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) => {
    const { ok, error } = await searchParams;
    const setups = listSetups(ctx.db);
    return (
      <main>
        <div className="page-head">
          <h1>Setups</h1>
          <p className="lead">
            A setup is a strategy tag (for example &quot;Breakout&quot;). The Stats page groups your
            results by setup.
          </p>
        </div>
        {ok && (
          <p role="status" className="notice notice-ok">
            {ok}
          </p>
        )}
        {error && (
          <p role="alert" className="notice notice-alert">
            {error}
          </p>
        )}

        <section aria-labelledby="new-setup">
          <div className="section-head">
            <h2 id="new-setup">New setup</h2>
          </div>
          <form action={createSetupAction} className="panel">
            <div className="form-grid">
              <div className="field">
                <label htmlFor="s-name">Name</label>
                <input id="s-name" name="name" required maxLength={60} />
              </div>
              <div className="field wide">
                <label htmlFor="s-desc">Description</label>
                <input id="s-desc" name="description" maxLength={500} />
              </div>
            </div>
            <button type="submit">Create setup</button>
          </form>
        </section>

        <section aria-labelledby="your-setups">
          <div className="section-head">
            <h2 id="your-setups">Your setups</h2>
          </div>
          {setups.length === 0 ? (
            <p className="small">No setups yet.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Description</th>
                  </tr>
                </thead>
                <tbody>
                  {setups.map((s) => (
                    <tr key={s.id}>
                      <td>
                        <strong>{s.name}</strong>
                      </td>
                      <td>{s.description}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>
    );
  },
);
