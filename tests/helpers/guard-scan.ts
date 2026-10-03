import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

/**
 * Finds every page, route handler and server action under src/app and reports the ones that are
 * not wrapped by the shared guard. Used by tests/auth/guard-coverage.test.ts.
 */

export type EntryKind = 'page' | 'route' | 'action';

export interface Entry {
  kind: EntryKind;
  /** Path relative to the repository root. */
  file: string;
  exportName: string;
  /** The wrapper function it is wrapped in, or null when it is not wrapped. */
  wrapper: string | null;
}

export interface Scan {
  entries: Entry[];
  problems: string[];
}

const WRAPPERS: Record<EntryKind, string[]> = {
  page: ['guardedPage', 'publicPage'],
  route: ['guardedRoute'],
  action: ['guardedAction', 'publicAction'],
};
const HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const hasExport = (node: ts.Node) =>
  ts.canHaveModifiers(node) &&
  (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
const hasDefault = (node: ts.Node) =>
  ts.canHaveModifiers(node) &&
  (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);

/** `guardedX(...)` -> "guardedX", anything else -> null. */
function wrapperOf(expr: ts.Expression | undefined): string | null {
  if (!expr) return null;
  let e = expr;
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e)) {
    e = e.expression;
  }
  return ts.isCallExpression(e) && ts.isIdentifier(e.expression) ? e.expression.text : null;
}

function isUseServer(sf: ts.SourceFile): boolean {
  for (const st of sf.statements) {
    if (ts.isExpressionStatement(st) && ts.isStringLiteral(st.expression)) {
      if (st.expression.text === 'use server') return true;
    } else break;
  }
  return false;
}

function containsInlineUseServer(sf: ts.SourceFile): boolean {
  let found = false;
  const visit = (node: ts.Node, depth: number) => {
    if (
      depth > 1 &&
      ts.isExpressionStatement(node) &&
      ts.isStringLiteral(node.expression) &&
      node.expression.text === 'use server'
    ) {
      found = true;
    }
    ts.forEachChild(node, (c) => visit(c, depth + 1));
  };
  visit(sf, 0);
  return found;
}

/** Scans source text. `file` is only used to decide the kind and for messages. */
export function scanSource(file: string, source: string): Scan {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const base = path.basename(file).replace(/\.(tsx?|jsx?)$/, '');
  const entries: Entry[] = [];
  const problems: string[] = [];
  const kindOfFile: EntryKind | null =
    base === 'page' ? 'page' : base === 'route' ? 'route' : isUseServer(sf) ? 'action' : null;

  if (containsInlineUseServer(sf)) {
    problems.push(
      `${file}: inline 'use server' functions are not allowed (use a guarded action file)`,
    );
  }
  if (base === 'layout' || base === 'template' || base === 'default' || base === 'loading') {
    for (const st of sf.statements) {
      if (
        ts.isImportDeclaration(st) &&
        ts.isStringLiteral(st.moduleSpecifier) &&
        /^@\/(data|auth)(\/|$)/.test(st.moduleSpecifier.text)
      ) {
        problems.push(
          `${file}: layouts must not touch data or auth (import ${st.moduleSpecifier.text})`,
        );
      }
    }
  }
  if (!kindOfFile) return { entries, problems };

  const record = (name: string, wrapper: string | null) => {
    entries.push({ kind: kindOfFile, file, exportName: name, wrapper });
    if (!wrapper || !WRAPPERS[kindOfFile].includes(wrapper)) {
      problems.push(`${file}: "${name}" is not wrapped by ${WRAPPERS[kindOfFile].join(' / ')}`);
    }
  };

  for (const st of sf.statements) {
    if (ts.isExportDeclaration(st)) {
      problems.push(`${file}: re-exports are not allowed in a ${kindOfFile} file`);
    } else if (ts.isExportAssignment(st)) {
      record('default', wrapperOf(st.expression));
    } else if (ts.isFunctionDeclaration(st) && hasExport(st)) {
      record(hasDefault(st) ? 'default' : (st.name?.text ?? 'default'), null);
    } else if (ts.isClassDeclaration(st) && hasExport(st)) {
      record(st.name?.text ?? 'default', null);
    } else if (ts.isVariableStatement(st) && hasExport(st)) {
      for (const d of st.declarationList.declarations) {
        const name = ts.isIdentifier(d.name) ? d.name.text : '(pattern)';
        // Route files may export config values (dynamic, revalidate...): only HTTP methods are handlers.
        if (kindOfFile === 'route' && !HTTP_METHODS.includes(name)) continue;
        record(name, wrapperOf(d.initializer));
      }
    }
  }

  if (kindOfFile === 'page' && !entries.some((e) => e.exportName === 'default')) {
    problems.push(`${file}: a page must have a default export`);
  }
  if (kindOfFile === 'action') {
    // Wrapped action functions must be imported from the guard module, not redefined locally.
    for (const e of entries) {
      const imported = sf.statements.some(
        (s) =>
          ts.isImportDeclaration(s) &&
          ts.isStringLiteral(s.moduleSpecifier) &&
          /_lib\/guard-core$/.test(s.moduleSpecifier.text) &&
          s.importClause?.namedBindings !== undefined &&
          ts.isNamedImports(s.importClause.namedBindings) &&
          s.importClause.namedBindings.elements.some((el) => el.name.text === e.wrapper),
      );
      if (e.wrapper && !imported) {
        problems.push(`${file}: ${e.wrapper} must be imported from the shared guard`);
      }
    }
  }
  if (kindOfFile === 'page') {
    for (const e of entries) {
      const imported = sf.statements.some(
        (s) =>
          ts.isImportDeclaration(s) &&
          ts.isStringLiteral(s.moduleSpecifier) &&
          /_lib\/guard$/.test(s.moduleSpecifier.text) &&
          s.importClause?.namedBindings !== undefined &&
          ts.isNamedImports(s.importClause.namedBindings) &&
          s.importClause.namedBindings.elements.some((el) => el.name.text === e.wrapper),
      );
      if (e.wrapper && !imported) {
        problems.push(`${file}: ${e.wrapper} must be imported from the shared guard`);
      }
    }
  }
  return { entries, problems };
}

/** Scans the real src/app tree and also rejects ways around the App Router guard. */
export function scanApp(root: string): Scan {
  const entries: Entry[] = [];
  const problems: string[] = [];
  const appDir = path.join(root, 'src', 'app');
  for (const full of walk(appDir)) {
    if (!/\.(ts|tsx|js|jsx)$/.test(full) || /\.test\.(ts|tsx)$/.test(full)) continue;
    const rel = path.relative(root, full);
    const scan = scanSource(rel, fs.readFileSync(full, 'utf8'));
    entries.push(...scan.entries);
    problems.push(...scan.problems);
  }
  for (const forbidden of ['pages', 'src/pages', 'middleware.ts', 'src/middleware.ts']) {
    if (fs.existsSync(path.join(root, forbidden))) {
      problems.push(
        `${forbidden} exists: only the App Router with guarded entry points is allowed`,
      );
    }
  }
  if (!fs.existsSync(path.join(root, 'src', 'proxy.ts'))) problems.push('src/proxy.ts is missing');
  return { entries, problems };
}

/** The ONLY entry points allowed to be public: the sign-in page and the sign-in action. */
export const PUBLIC_ENTRIES: ReadonlySet<string> = new Set([
  'src/app/login/page.tsx#default',
  'src/app/login/actions.ts#loginAction',
]);
