import type { ReviewChecks } from '@/data/analyst';
import { AI_COMMENTARY_LABEL, type AnalystKind, type AnalystOutput } from '@/domain/analyst';

/**
 * Shows an analyst answer as ESCAPED PLAIN TEXT only: React escapes every string, nothing here
 * renders HTML, markdown, links or images. The label and the checks always travel with it.
 */

function List({ title, items }: { title: string; items: readonly string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="ai-section">
      <h3>{title}</h3>
      <ul className="ai-list">
        {items.map((t, i) => (
          <li key={i}>{t}</li>
        ))}
      </ul>
    </div>
  );
}

function Text({ title, text }: { title: string; text: string }) {
  if (text === '') return null;
  return (
    <div className="ai-section">
      <h3>{title}</h3>
      <p className="ai-text">{text}</p>
    </div>
  );
}

function Body({ kind, output }: { kind: AnalystKind; output: AnalystOutput }) {
  if (kind === 'plan_review' && 'conflicts' in output) {
    return (
      <>
        <Text title="Explanation" text={output.explanation} />
        <List title="Questions a careful trader would ask" items={output.questions} />
        <List
          title="Points that conflict with your saved rules or the verdict"
          items={output.conflicts}
        />
      </>
    );
  }
  if (kind === 'weekly_review' && 'patterns' in output) {
    return (
      <>
        <Text title="Summary" text={output.summary} />
        <List title="Observed patterns" items={output.patterns} />
        <List title="Recurring mistakes" items={output.mistakes} />
        <List title="Rule-breaking (overrides)" items={output.rule_breaking} />
        <List title="What the data cannot show" items={output.data_limits} />
        <List title="Questions for next week" items={output.questions} />
      </>
    );
  }
  if (kind === 'tutor' && 'key_points' in output) {
    return (
      <>
        <Text title="Explanation" text={output.explanation} />
        <Text title="Example with your own numbers" text={output.example} />
        <List title="Key points" items={output.key_points} />
      </>
    );
  }
  return <p className="na">The stored answer does not match its kind and is not shown.</p>;
}

export function AnalystOutputView({
  kind,
  output,
  checks,
  fromStore = false,
  createdAt,
}: {
  kind: AnalystKind;
  output: AnalystOutput;
  checks: ReviewChecks | null;
  fromStore?: boolean;
  createdAt?: string;
}) {
  return (
    <div className="panel">
      <p>
        <span className="badge badge-note">AI commentary</span> {AI_COMMENTARY_LABEL}.
      </p>
      {fromStore && (
        <p className="small" role="status">
          This is a stored answer
          {createdAt ? ` from ${createdAt.slice(0, 16).replace('T', ' ')} UTC` : ''}. Nothing new
          was sent and nothing was paid for it.
        </p>
      )}
      {checks === null ? (
        <p role="alert" className="notice notice-alert">
          The checks stored with this answer could not be read, so its figures are not verified.
        </p>
      ) : (
        <>
          {checks.instructionHits.length > 0 && (
            <div role="alert" className="notice notice-note">
              <strong>Wording check:</strong> some sentences read like a trade instruction. They are
              shown so you can read them, but the AI cannot decide anything: the risk engine has the
              final say.
              <ul>
                {checks.instructionHits.map((h, i) => (
                  <li key={i}>{h}</li>
                ))}
              </ul>
            </div>
          )}
          {checks.unverified.length > 0 && (
            <div role="alert" className="notice notice-alert">
              <strong>Flagged:</strong> {checks.unverified.length} cited figure
              {checks.unverified.length === 1 ? ' was' : 's were'} not found in the data that was
              sent. Those numbers are unverified.
            </div>
          )}
          {checks.truncated && (
            <p className="notice notice-note">
              Some text was cut before sending (it is marked in the data). The answer may miss
              details.
            </p>
          )}
        </>
      )}
      <Body kind={kind} output={output} />
      {checks !== null && (checks.verified.length > 0 || checks.unverified.length > 0) && (
        <div className="ai-section">
          <h3>Figures quoted</h3>
          <ul className="ai-figures">
            {checks.verified.map((f, i) => (
              <li key={`v${i}`}>
                {f.label}: <strong>{f.value}</strong> <span className="badge">verified</span>
              </li>
            ))}
            {checks.unverified.map((f, i) => (
              <li key={`u${i}`}>
                {f.label}: <strong>{f.value}</strong>{' '}
                <span className="badge badge-unverified">unverified</span>
              </li>
            ))}
          </ul>
          <p className="small">
            Verified means the exact text of the figure appears in the data that was sent.
          </p>
        </div>
      )}
    </div>
  );
}
