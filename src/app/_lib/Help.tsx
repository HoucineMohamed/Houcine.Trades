import { Fragment } from 'react';
import { getHelp, type HelpKey } from './help';
import { inlineTokens, type Block } from './help-parse';

function Inline({ text }: { text: string }) {
  return (
    <>
      {inlineTokens(text).map((t, i) => {
        if (t.type === 'code') return <code key={i}>{t.text}</code>;
        if (t.type === 'strong') return <strong key={i}>{t.text}</strong>;
        if (t.type === 'em') return <em key={i}>{t.text}</em>;
        return <Fragment key={i}>{t.text}</Fragment>;
      })}
    </>
  );
}

function Blocks({ blocks }: { blocks: Block[] }) {
  return (
    <>
      {blocks.map((b, i) =>
        b.type === 'paragraph' ? (
          <p key={i}>
            <Inline text={b.text} />
          </p>
        ) : (
          <ul key={i}>
            {b.items.map((item, j) => (
              <li key={j}>
                <Inline text={item} />
              </li>
            ))}
          </ul>
        ),
      )}
    </>
  );
}

/**
 * A small "What does this mean?" disclosure, filled from the docs. Works without JavaScript
 * (native <details>). Shows nothing, and never fails, if the text is missing.
 */
export function Help({ id, label = 'What does this mean?' }: { id: HelpKey; label?: string }) {
  const blocks = getHelp(id);
  if (!blocks) return null;
  return (
    <details className="help">
      <summary>{label}</summary>
      <div className="help-body">
        <Blocks blocks={blocks} />
      </div>
    </details>
  );
}
