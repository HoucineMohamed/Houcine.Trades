/** What must never appear in a page: inline styles, scripts, and anything fetched from elsewhere. */
export function unsafeThings(html: string): string[] {
  const found: string[] = [];
  if (/\sstyle\s*=/i.test(html)) found.push('an inline style attribute');
  // a <p> cannot contain blocks: the browser would close it early and hydration would fail
  if (
    /<p[\s>](?:(?!<\/p>)[\s\S])*?<(details|div|ul|ol|table|section|figure|form|h[1-6])[\s>]/i.test(
      html,
    )
  )
    found.push('a block element inside a <p>');
  if (/<style[\s>]/i.test(html)) found.push('a <style> element');
  if (/<script[\s>]/i.test(html)) found.push('a <script> element');
  if (/\son[a-z]+\s*=/i.test(html)) found.push('an inline event handler');
  for (const tag of [
    'img',
    'iframe',
    'object',
    'embed',
    'link',
    'video',
    'audio',
    'source',
    'form',
  ] as const) {
    if (tag === 'form') continue; // forms are fine; checked below for their action
    if (new RegExp(`<${tag}[\\s>/]`, 'i').test(html)) found.push(`a <${tag}> element`);
  }
  for (const m of html.matchAll(
    /\s(href|src|action|srcset|data|poster|formaction)\s*=\s*"([^"]*)"/gi,
  )) {
    const value = (m[2] ?? '').trim();
    if (/^(https?:)?\/\//i.test(value))
      found.push(`an external URL in ${m[1]}: ${value.slice(0, 60)}`);
    if (/^(javascript|data|vbscript):/i.test(value)) found.push(`a ${value.split(':')[0]}: URL`);
  }
  return found;
}
