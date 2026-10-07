'use client';

import { useActionState, useEffect, useRef, useState, type ReactNode } from 'react';
import { ASSET_CLASSES } from '@/domain/trades/types';
import { emptyFormState, formValues, type FormState, type FormValues } from '../_lib/form';
import { StepUpField } from '../_lib/StepUpField';
import type { RiskPreview, SizeSuggestion } from './actions';

interface Props {
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  accounts: { id: number; name: string; baseCurrency: string }[];
  setups: { id: number; name: string }[];
  mode: 'create' | 'edit';
  initial?: FormValues;
  /** Edit mode: names of the fields that may still be changed. Others are shown but disabled. */
  editable?: readonly string[];
  submitLabel: string;
  /** Create mode: asks the server for the live risk verdict of the plan (saves nothing). */
  preview?: (values: FormValues) => Promise<RiskPreview>;
  /** Create mode: asks the server for the largest size inside the per-trade risk limit. */
  sizeHelper?: (values: FormValues) => Promise<SizeSuggestion>;
  /** A code was accepted in the last 5 minutes (so an override needs no new code). */
  stepUpFresh?: boolean;
}

export function TradeForm({
  action,
  accounts,
  setups,
  mode,
  initial = {},
  editable,
  submitLabel,
  preview,
  sizeHelper,
  stepUpFresh = false,
}: Props) {
  const [state, formAction, pending] = useActionState(action, emptyFormState);
  const formRef = useRef<HTMLFormElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [verdict, setVerdict] = useState<RiskPreview | null>(null);
  const [checking, setChecking] = useState(false);
  // true when the live check could not run (the server still judges the plan when you save)
  const [checkFailed, setCheckFailed] = useState(false);
  const [suggestion, setSuggestion] = useState<SizeSuggestion | null>(null);
  const [suggestionFailed, setSuggestionFailed] = useState(false);
  // currencies of the plan being checked: amounts of the verdict are in the ACCOUNT currency
  const [currencies, setCurrencies] = useState({ account: '', quote: '' });
  // only the newest reply may be shown: a slow reply for older values is ignored
  const request = useRef(0);

  // Live checks: a moment after you stop typing, ask the server (same engine, same rules).
  const refresh = () => {
    if (!formRef.current) return;
    const values = formValues(new FormData(formRef.current));
    const mine = ++request.current;
    setCurrencies({
      account: accounts.find((a) => String(a.id) === values.accountId)?.baseCurrency ?? '',
      quote: (values.quoteCurrency ?? '').trim().toUpperCase(),
    });
    if (preview) {
      setChecking(true);
      preview(values)
        .then((v) => {
          if (mine !== request.current) return;
          setVerdict(v);
          setCheckFailed(false);
        })
        .catch(() => {
          if (mine !== request.current) return;
          setVerdict(null); // never leave an old verdict next to new values
          setCheckFailed(true);
        })
        .finally(() => {
          if (mine === request.current) setChecking(false);
        });
    }
    if (sizeHelper) {
      // Nothing to suggest until an entry price is typed (no list of "missing" messages up front).
      const entry = values.status === 'open' ? values.entryPrice : values.plannedEntry;
      if (!entry || entry.trim() === '') {
        setSuggestion(null);
        setSuggestionFailed(false);
      } else {
        sizeHelper(values)
          .then((s) => {
            if (mine !== request.current) return;
            setSuggestion(s);
            setSuggestionFailed(false);
          })
          .catch(() => {
            if (mine !== request.current) return;
            setSuggestion(null);
            setSuggestionFailed(true);
          });
      }
    }
  };
  const scheduleRefresh = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(refresh, 400);
  };
  useEffect(() => {
    timer.current = setTimeout(refresh, 0); // asynchronous: nothing is set while rendering
    return () => clearTimeout(timer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const useSuggestedSize = () => {
    const input = formRef.current?.elements.namedItem('size');
    if (suggestion?.ok && suggestion.size && input instanceof HTMLInputElement) {
      input.value = suggestion.size;
      scheduleRefresh();
    }
  };

  const refused = state.needsOverride || (verdict !== null && !verdict.approved);
  const value = (name: string) => state.values[name] ?? initial[name] ?? '';
  const locked = (name: string) => mode === 'edit' && !editable?.includes(name);
  const field = (name: string) => ({
    id: `f-${name}`,
    name,
    defaultValue: value(name),
    disabled: locked(name),
  });
  const row = (name: string, label: string, input: ReactNode, hint?: string, wide = false) => (
    <div className={wide ? 'field wide' : 'field'}>
      <label htmlFor={`f-${name}`}>{label}</label>
      {input}
      {hint && <span className="field-hint">{hint}</span>}
    </div>
  );

  return (
    <form action={formAction} ref={formRef} onChange={scheduleRefresh} onInput={scheduleRefresh}>
      {state.errors.length > 0 && (
        <div role="alert" className="notice notice-alert">
          <strong>Please fix:</strong>
          <ul>
            {state.errors.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        </div>
      )}
      {/* Remount the inputs after a failed submit so they show what you typed. */}
      <div key={JSON.stringify(state.values)}>
        <fieldset>
          <legend>The trade</legend>
          <div className="form-grid">
            {mode === 'create' &&
              row(
                'accountId',
                'Account',
                <select {...field('accountId')} required>
                  <option value="">-- choose --</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} ({a.baseCurrency})
                    </option>
                  ))}
                </select>,
              )}
            {row(
              'symbol',
              'Symbol',
              <input {...field('symbol')} required maxLength={30} />,
              'for example BTCUSDT',
            )}
            {row(
              'assetClass',
              'Asset class',
              <select {...field('assetClass')} required>
                {ASSET_CLASSES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>,
            )}
            {row(
              'direction',
              'Direction',
              <select {...field('direction')} required>
                <option value="long">long (buy)</option>
                <option value="short">short (sell)</option>
              </select>,
            )}
            {mode === 'create' &&
              row(
                'status',
                'Status',
                <select {...field('status')}>
                  <option value="planned">planned (not taken yet)</option>
                  <option value="open">open (already taken)</option>
                </select>,
              )}
            {row(
              'setupId',
              'Setup',
              <select {...field('setupId')}>
                <option value="">(none)</option>
                {setups.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>,
            )}
            {row(
              'quoteCurrency',
              'Quote currency',
              <input {...field('quoteCurrency')} required maxLength={10} />,
              'for example USDT or USD',
            )}
          </div>
        </fieldset>

        <fieldset>
          <legend>Prices and size</legend>
          <div className="form-grid">
            {row(
              'plannedEntry',
              'Planned entry',
              <input {...field('plannedEntry')} required inputMode="decimal" />,
              'price',
            )}
            {row(
              'stopLoss',
              'Stop-loss (required)',
              <input {...field('stopLoss')} required inputMode="decimal" />,
              'Long: below the entry. Short: above it.',
            )}
            {row(
              'takeProfit',
              'Take-profit',
              <input {...field('takeProfit')} inputMode="decimal" />,
              'optional. Long: above the entry. Short: below it.',
            )}
            {row(
              'size',
              'Size',
              <input {...field('size')} required inputMode="decimal" />,
              'units of the asset (0.5 BTC, 10 shares)',
            )}
            {mode === 'create' && (
              <>
                {row(
                  'entryPrice',
                  'Entry price',
                  <input {...field('entryPrice')} inputMode="decimal" />,
                  'only if the status is open: the price you really got',
                )}
                {row(
                  'openedAt',
                  'Opened at',
                  <input {...field('openedAt')} type="datetime-local" />,
                  'only if the status is open (your local time)',
                )}
              </>
            )}
            {row(
              'fees',
              'Fees',
              <input {...field('fees')} inputMode="decimal" />,
              'amount, default 0',
            )}
            {row(
              'feesCurrency',
              'Fees currency',
              <input {...field('feesCurrency')} maxLength={10} />,
              'default: the quote currency',
            )}
          </div>
          {sizeHelper && (
            <div className="notice notice-note" aria-live="polite">
              <strong>Position-size helper</strong>
              {suggestionFailed ? (
                <p className="small">
                  The size helper could not run just now. You can still type a size yourself; the
                  risk engine judges the plan when you save.
                </p>
              ) : suggestion === null ? (
                <p className="small">
                  Type the entry price and the stop-loss to see the largest size inside your
                  per-trade limit.
                </p>
              ) : suggestion.ok ? (
                <>
                  <p>
                    The largest size inside your per-trade limit ({suggestion.riskPercent} % of
                    equity) is <strong>{suggestion.size}</strong>. Risk at the stop:{' '}
                    {suggestion.riskAmount} {currencies.account} ({suggestion.riskPercentUsed} % of
                    equity); trade value {suggestion.notional} {currencies.quote}.
                  </p>
                  <button type="button" className="secondary" onClick={useSuggestedSize}>
                    Use this size
                  </button>
                </>
              ) : (
                <ul>
                  {suggestion.problems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </fieldset>

        <fieldset>
          <legend>Notes</legend>
          <div className="form-grid">
            {row(
              'planNotes',
              'Plan notes',
              <textarea {...field('planNotes')} rows={3} maxLength={5000} />,
              undefined,
              true,
            )}
            {mode === 'edit' &&
              row(
                'reviewNotes',
                'Review notes',
                <textarea {...field('reviewNotes')} rows={3} maxLength={5000} />,
                undefined,
                true,
              )}
            {row(
              'emotion',
              'Emotion',
              <input {...field('emotion')} maxLength={200} />,
              'how did you feel?',
            )}
            {row(
              'screenshotPath',
              'Screenshot',
              <input {...field('screenshotPath')} maxLength={500} />,
              'a file path or an http(s) link (no upload)',
            )}
          </div>
        </fieldset>
      </div>

      {preview && (
        <section aria-live="polite" className="notice notice-note">
          <strong>Risk check{checking ? ' (checking…)' : ''}</strong>
          {checkFailed ? (
            <p role="alert">
              The live risk check could not run just now. It is NOT approving this plan: the risk
              engine still judges it when you save.
            </p>
          ) : verdict === null ? (
            <p>Fill in the plan to see the risk check.</p>
          ) : (
            <>
              <p>
                <strong>
                  {verdict.approved
                    ? 'The risk engine APPROVES this plan.'
                    : 'The risk engine REFUSES this plan. Reasons:'}
                </strong>
              </p>
              {verdict.violations.length > 0 && (
                <ul>
                  {verdict.violations.map((v) => (
                    <li key={v.code + v.message}>
                      <code>{v.code}</code> {v.message}
                    </li>
                  ))}
                </ul>
              )}
              {verdict.warnings.length > 0 && (
                <ul>
                  {verdict.warnings.map((w) => (
                    <li key={w.code}>
                      Note <code>{w.code}</code>: {w.message}
                    </li>
                  ))}
                </ul>
              )}
              <p className="small">
                Risk on this trade: {verdict.numbers.riskAmount ?? 'n/a'} {currencies.account} (
                {verdict.numbers.riskPercent ?? 'n/a'} % of equity {verdict.numbers.equity ?? 'n/a'}{' '}
                {currencies.account}){' | '}Open risk after:{' '}
                {verdict.numbers.openRiskAfter ?? 'n/a'} {currencies.account} (
                {verdict.numbers.openRiskAfterPercent ?? 'n/a'} %){' | '}Open trades after:{' '}
                {verdict.numbers.openTradesAfter} of {verdict.numbers.maxOpenTrades ?? 'n/a'}
                {' | '}Reward-to-risk: {verdict.numbers.rewardToRisk ?? 'n/a'}
              </p>
            </>
          )}
        </section>
      )}
      {preview && refused && (
        <section className="notice notice-alert">
          <strong>Log it anyway? (override)</strong>
          <p className="small">
            The journal may record a plan that breaks your rules, but it is flagged as an OVERRIDE
            forever. Real orders can never be overridden.
          </p>
          <div className="form-grid">
            <div className="field">
              <label htmlFor="f-overrideConfirm">Type OVERRIDE</label>
              <input id="f-overrideConfirm" name="overrideConfirm" autoComplete="off" />
            </div>
            <div className="field wide">
              <label htmlFor="f-overrideReason">Reason (at least 10 characters)</label>
              <input
                id="f-overrideReason"
                name="overrideReason"
                maxLength={500}
                autoComplete="off"
              />
            </div>
          </div>
          <StepUpField fresh={stepUpFresh} />
        </section>
      )}
      <button type="submit" disabled={pending}>
        {pending ? 'Saving…' : submitLabel}
      </button>
    </form>
  );
}
