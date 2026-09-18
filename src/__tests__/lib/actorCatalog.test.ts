/**
 * Phase 33 D-07 — contract test for the canonical actor catalog.
 *
 * Pins five invariants on server/data/actor-catalog.ts so structural
 * drift (duplicate canonicals, orphan CAMEO codes, alias collisions)
 * fails the next vitest run loudly. Mitigates Threat T-33-02 (tampering
 * at the catalog code-path) — PR-time review covers semantic poisoning
 * (e.g. someone aliasing "IDF" → "ISIS" passes the contract but should
 * fail human review).
 *
 * Test design (mirrors src/__tests__/lib/colorBridge.test.ts byte-
 * identity-sentinel pattern + it.each table-driven CAMEO orphan check):
 *
 *   (a) D-07 a — no duplicate canonical names
 *   (b) D-07 b — no orphan CAMEO codes (every cameoCodes[] entry is
 *                present in the committed cameo-codes.json snapshot)
 *   (c) D-07 c — every alias resolves to exactly one CanonicalActor
 *                (strict referential equality via canonicalize())
 *   (d) D-07 d — canonicalize() is case-insensitive (idf, IDF, Idf all
 *                resolve to the same entry)
 *   (e) D-07 e — canonicalize('UNKNOWN_ALIAS_xxx') returns null
 *
 * Plus one supporting suite (well-formedness of ACTOR_LOOKUP) and the
 * Faction sentinel test (33-PATTERNS.md risk #5 mitigation — catalog's
 * local Faction literal must byte-match src/lib/factions.ts:5).
 *
 * Codebook is read via readFileSync (not JSON import) because
 * tsconfig.app.json's `include` is restricted to src/ and the catalog
 * imports a .planning/ path that path-alias resolution doesn't admit.
 * Mirrors the pattern in server/__tests__/lib/llmEvalHarness.adversarial
 * .test.ts (which reads .planning/eval/adversarial-injections.json via
 * the same approach).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect } from 'vitest';

import {
  ACTOR_CATALOG,
  ACTOR_LOOKUP,
  canonicalize,
  type CanonicalActor,
} from '../../../server/data/actor-catalog';

// __dirname shim for ESM test files (jsdom default env in vite.config.ts).
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Codebook is the single source of truth for orphan-check (D-07 b).
const codebookPath = resolve(__dirname, '../fixtures/cameo-codes.json');
const codebook = JSON.parse(readFileSync(codebookPath, 'utf-8')) as {
  version: string;
  actorCodes: Array<{ code: string; label: string; type: string }>;
};
const knownCodes = new Set(codebook.actorCodes.map((c) => c.code));

describe('Phase 33 actor catalog — no duplicate canonical names (D-07 a)', () => {
  it('every CanonicalActor.canonicalName is unique', () => {
    const names = ACTOR_CATALOG.map((a) => a.canonicalName);
    expect(new Set(names).size).toBe(names.length);
  });

  it('catalog has at least the D-06 baseline minimum of 25 entries', () => {
    expect(ACTOR_CATALOG.length).toBeGreaterThanOrEqual(25);
  });
});

describe('Phase 33 actor catalog — no orphan CAMEO codes (D-07 b)', () => {
  const allCodes = ACTOR_CATALOG.flatMap((a) => a.cameoCodes);

  it('catalog references at least one CAMEO code overall (guard against silent empty-input it.each pass)', () => {
    // If every catalog entry has an empty cameoCodes[] the it.each below
    // would silently pass on zero iterations. Phase 33 D-06 ships with at
    // least the country-military codes — assert ≥ 5 to be safe.
    expect(allCodes.length).toBeGreaterThanOrEqual(5);
  });

  it.each(allCodes)('CAMEO code %s is in committed codebook', (code) => {
    expect(knownCodes.has(code)).toBe(true);
  });

  it('codebook itself parses with the expected shape', () => {
    expect(codebook.version).toBe('GDELT-CAMEO-2026-05');
    expect(Array.isArray(codebook.actorCodes)).toBe(true);
    expect(codebook.actorCodes.length).toBeGreaterThanOrEqual(10);
  });
});

describe('Phase 33 actor catalog — every alias resolves to one canonical (D-07 c)', () => {
  it('every alias resolves to exactly one CanonicalActor (strict referential equality)', () => {
    for (const entry of ACTOR_CATALOG) {
      for (const alias of entry.aliases) {
        const resolved = canonicalize(alias);
        expect(resolved).toBe(entry);
      }
    }
  });

  it('every canonicalName resolves back to its own entry', () => {
    for (const entry of ACTOR_CATALOG) {
      const resolved = canonicalize(entry.canonicalName);
      expect(resolved).toBe(entry);
    }
  });
});

describe('Phase 33 actor catalog — canonicalize is case-insensitive (D-07 d)', () => {
  it('idf, IDF, Idf all resolve to the same entry', () => {
    const lower = canonicalize('idf');
    const upper = canonicalize('IDF');
    const mixed = canonicalize('Idf');
    expect(lower).not.toBeNull();
    expect(upper).toBe(lower);
    expect(mixed).toBe(lower);
  });

  it('irgc / IRGC / Irgc all resolve to the same entry', () => {
    const lower = canonicalize('irgc');
    const upper = canonicalize('IRGC');
    const mixed = canonicalize('Irgc');
    expect(lower).not.toBeNull();
    expect(upper).toBe(lower);
    expect(mixed).toBe(lower);
  });

  it('canonicalize trims surrounding whitespace before lookup', () => {
    expect(canonicalize('  idf  ')).toBe(canonicalize('idf'));
  });
});

describe('Phase 33 actor catalog — unknown alias returns null (D-07 e)', () => {
  it('canonicalize("UNKNOWN_ALIAS_xxx") returns null', () => {
    expect(canonicalize('UNKNOWN_ALIAS_xxx')).toBeNull();
  });

  it('canonicalize("") returns null after trim', () => {
    expect(canonicalize('')).toBeNull();
  });

  it('canonicalize whitespace-only string returns null after trim', () => {
    expect(canonicalize('   ')).toBeNull();
  });
});

describe('Phase 33 actor catalog — ACTOR_LOOKUP is well-formed (supporting invariant)', () => {
  it('every value in ACTOR_LOOKUP is a member of ACTOR_CATALOG', () => {
    for (const actor of ACTOR_LOOKUP.values()) {
      expect(ACTOR_CATALOG).toContain(actor as CanonicalActor);
    }
  });

  it('every key in ACTOR_LOOKUP is lowercase (case-insensitive contract)', () => {
    for (const key of ACTOR_LOOKUP.keys()) {
      expect(key).toBe(key.toLowerCase());
    }
  });
});

describe('Phase 33 actor catalog — Faction literal sentinel (PATTERNS risk #5)', () => {
  // The catalog cannot import `Faction` directly from src/lib/factions.ts
  // because factions.ts uses the `@/lib/colorBridge` path alias which is
  // not defined in tsconfig.server.json. As a mitigation, the catalog
  // declares `type Faction = 'us' | 'iran' | 'neutral'` locally with a
  // JSDoc note. This test asserts that the local literal stays in sync
  // with the upstream definition at src/lib/factions.ts:5 — drift fails
  // the next vitest run.
  it('catalog local Faction literal byte-matches src/lib/factions.ts Faction union', () => {
    const factionsPath = resolve(__dirname, '../../../src/lib/factions.ts');
    const catalogPath = resolve(__dirname, '../../../server/data/actor-catalog.ts');

    const factionsSrc = readFileSync(factionsPath, 'utf-8');
    const catalogSrc = readFileSync(catalogPath, 'utf-8');

    // Extract the right-hand side of `export type Faction = ...;`
    const factionsRe = /export\s+type\s+Faction\s*=\s*([^;]+);/;
    const catalogRe = /type\s+Faction\s*=\s*([^;]+);/;

    const factionsMatch = factionsSrc.match(factionsRe);
    const catalogMatch = catalogSrc.match(catalogRe);

    expect(factionsMatch).not.toBeNull();
    expect(catalogMatch).not.toBeNull();

    if (!factionsMatch || !catalogMatch) return; // satisfy TS narrowing

    const factionsLiteral = factionsMatch[1].replace(/\s+/g, ' ').trim();
    const catalogLiteral = catalogMatch[1].replace(/\s+/g, ' ').trim();

    expect(catalogLiteral).toBe(factionsLiteral);
  });
});
