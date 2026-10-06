import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import { parseBlocks, parseSections, parseTableRows, type Block } from './help-parse';

/**
 * "What does this mean?" texts. The docs are the single source: each key below names a heading in
 * docs/stats-glossary.md or docs/risk-rules.md (optionally a row of the table under it). A test
 * fails if a key no longer matches the docs or a text contains advice wording.
 */

export type DocFile = 'stats-glossary' | 'risk-rules';

export interface HelpSource {
  file: DocFile;
  heading: string;
  /** Use a row of the table under the heading instead of its paragraphs. */
  row?: string;
}

const S = (heading: string): HelpSource => ({ file: 'stats-glossary', heading });
const R = (heading: string, row?: string): HelpSource => ({ file: 'risk-rules', heading, row });
const RULES = 'What the engine checks on every plan';
const HALTS = 'Halts (the kill switch)';

export const HELP: Record<string, HelpSource> = {
  // stats
  closedTrades: S('Closed trades, wins, losses, breakevens'),
  winRate: S('Win rate (%)'),
  pnl: S('Gross P&L (before fees), total fees, net P&L (after fees)'),
  winnersLosers: S('Total winners and total losers'),
  averages: S('Average win and average loss'),
  largest: S('Largest win and largest loss'),
  averageR: S('Average R (before fees)'),
  expectancyR: S('Expectancy in R (after fees)'),
  expectancyMoney: S('Expectancy in money per trade'),
  profitFactor: S('Profit factor'),
  payoff: S('Payoff ratio'),
  streaks: S('Longest winning streak and longest losing streak'),
  equityCurve: S('Equity curve'),
  maxDrawdown: S('Max drawdown (amount and %)'),
  baseCurrency: S('Account base currency'),
  breakdowns: S('Breakdowns'),
  sampleSize: S('Why 30 trades?'),
  notAvailable: S('When a number is "n/a"'),
  rMultiple: S('R-multiple (R)'),
  initialRisk: S('Initial risk'),
  initialStop: S('Initial stop-loss and the current stop-loss'),
  netPnl: S('Net P&L (profit and loss after fees)'),
  fees: S('Fees'),
  outcome: S('Win, loss, breakeven'),
  // risk
  equity: R('Equity (what the percentages are measured against)'),
  utcDay: R('The UTC day'),
  halts: R(HALTS),
  haltHit: R('What "hit" means for a halt'),
  drawdownDetails: R('Drawdown details'),
  sizeCalculator: R('The position-size calculator'),
  ceilings: R('Hard ceilings'),
  loosening: R('Tightening is immediate, loosening takes 24 hours'),
  overrides: R('The journal and overrides'),
  warnings: R('Warnings (never a refusal)'),
  ruleMaxRisk: R(RULES, 'Max risk per trade'),
  ruleOpenRisk: R(RULES, 'Max total open risk'),
  ruleOpenTrades: R(RULES, 'Max open trades'),
  ruleStop: R(RULES, 'Stop-loss required'),
  ruleCurrency: R(RULES, 'Currency check'),
};

export type HelpKey = keyof typeof HELP;

function readDoc(file: DocFile): string | null {
  try {
    return fs.readFileSync(path.join(process.cwd(), 'docs', `${file}.md`), 'utf8');
  } catch {
    return null;
  }
}

/** Resolves one source against the doc text. Pure apart from the file read. */
export function resolveHelp(source: HelpSource, markdown: string): Block[] | null {
  const section = parseSections(markdown).find((s) => s.title === source.heading);
  if (!section) return null;
  if (source.row !== undefined) {
    const row = parseTableRows(section.lines).find((r) => r.key === source.row);
    if (!row || row.cells.length < 3) return null;
    return [
      { type: 'paragraph', text: row.cells[1] as string },
      { type: 'paragraph', text: `Why it exists: ${row.cells[2] as string}` },
    ];
  }
  const blocks = parseBlocks(section.lines);
  return blocks.length > 0 ? blocks : null;
}

/** The help blocks for a key, or null when the docs do not (or no longer) contain them. */
export function getHelp(key: HelpKey): Block[] | null {
  const source = HELP[key];
  if (!source) return null;
  const doc = readDoc(source.file);
  return doc === null ? null : resolveHelp(source, doc);
}

/** For tests: every key with the blocks it resolves to. */
export function allHelp(): { key: string; blocks: Block[] | null }[] {
  return Object.keys(HELP).map((key) => ({ key, blocks: getHelp(key) }));
}
