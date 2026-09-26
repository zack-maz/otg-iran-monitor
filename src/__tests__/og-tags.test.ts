/**
 * Wave-0 RED stub — REVEAL-SITE-03 social-share / OG-tag contract.
 *
 * Reads the real `index.html` and asserts the OG/Twitter/description meta tags
 * that Plan 06 adds. RED because the current head (charset/favicon/viewport/
 * title only) has none of these. Goes GREEN when Plan 06 inserts the static
 * tag block.
 *
 * Crawlers read raw HTML (no SSR), so these tags MUST live statically in
 * index.html with ABSOLUTE vercel.app URLs (D-09) and 1200x630 dims.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const html = readFileSync(resolve(__dirname, '../../index.html'), 'utf8');
const ABS = 'https://motg-iran.vercel.app';

describe('index.html OG / Twitter tags (REVEAL-SITE-03)', () => {
  it('has og:type / og:title / og:description / og:url', () => {
    expect(html).toMatch(/property=["']og:type["']/);
    expect(html).toMatch(/property=["']og:title["']/);
    expect(html).toMatch(/property=["']og:description["']/);
    expect(html).toMatch(/property=["']og:url["']/);
  });

  it('has og:image with 1200x630 dimensions', () => {
    expect(html).toMatch(/property=["']og:image["']/);
    expect(html).toMatch(/property=["']og:image:width["']\s+content=["']1200["']/);
    expect(html).toMatch(/property=["']og:image:height["']\s+content=["']630["']/);
  });

  it('has twitter:card=summary_large_image + twitter:image', () => {
    expect(html).toMatch(/name=["']twitter:card["']\s+content=["']summary_large_image["']/);
    expect(html).toMatch(/name=["']twitter:image["']/);
  });

  it('has a name="description" meta tag', () => {
    expect(html).toMatch(/name=["']description["']/);
  });

  it('og:url uses the absolute vercel.app origin (D-09)', () => {
    const m = html.match(/property=["']og:url["']\s+content=["']([^"']+)["']/);
    expect(m, 'og:url meta present').not.toBeNull();
    expect(m?.[1]).toMatch(new RegExp(`^${ABS.replace(/[.]/g, '[.]')}`));
  });

  it('og:image uses the absolute served screenshots path (Vite strips public/)', () => {
    const m = html.match(/property=["']og:image["']\s+content=["']([^"']+)["']/);
    expect(m, 'og:image meta present').not.toBeNull();
    // served path = /screenshots/... (NOT /public/screenshots/...)
    expect(m?.[1]).toBe(`${ABS}/screenshots/og-card.png`);
  });
});
