// @vitest-environment node
/**
 * Redis-key registry drift gate.
 *
 * Parses `docs/redis-keys.md` (the single key registry) AND the codebase for
 * Redis-key string literals, then asserts every documented key is referenced in
 * code and every code-referenced key is documented. Drift fails `vitest run`.
 *
 * Why `// @vitest-environment node`: the default vitest env is `jsdom`, but this
 * test does fs walks across the repo.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect } from 'vitest';

// __dirname shim for ESM test files.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Three levels up from src/__tests__/lib/ → repo root.
const REPO_ROOT = resolve(__dirname, '../../..');
const REDIS_KEYS_MD = resolve(REPO_ROOT, 'docs/redis-keys.md');

/**
 * Phase 35 D-02 exemption list. Each entry MUST cite the surface (`file:line` or
 * "test fixture" / "historical-fallback probe") so future readers can audit the
 * exemption without re-greping. Empty-at-phase-close is the IDEAL state per D-02 —
 * the entries below cover real historical / test-fixture / non-Redis-key strings
 * that the grep regex captures but should not gate the registry.
 *
 * EXEMPT_KEYS semantics:
 *   - Membership is decided by `codeKey.startsWith(entry.key)` (prefix match).
 *   - An exempt key is excluded BOTH from the documented-key→code direction
 *     AND from the code-key→documented direction.
 */
const EXEMPT_KEYS: ReadonlyArray<{ key: string; reason: string }> = [
  {
    key: 'events:llm-pipeline-audit',
    reason:
      'retired key; survives only in code comments (redis.ts, llmEventExtractor.v3.ts, trendHistory.ts). No writer or reader.',
  },
  {
    key: 'news:gdelt',
    reason:
      'retired key name; mentioned in a healthSources.ts comment explaining that readers now use `news:feed`.',
  },
  {
    key: 'dashboard:auth-key',
    reason: 'browser localStorage key in src/lib/dashboardAuth.ts, not a Redis key.',
  },
  {
    key: 'events:llm:v2',
    reason:
      "historical-fallback probe in server/routes/health.ts:315 (`fallbackKeys: ['events:llm:v2', 'events:llm']`); v1/v2 retired Phase 29 but the probe survives for the legacy-chain operator dashboard. Documented retirement in ADR-0010.",
  },
  {
    key: 'events:llm',
    reason:
      'sibling of events:llm:v2 — same health.ts:315 fallbackKeys probe. Phase 29 v1 retirement; surfaced as a literal in the probe array.',
  },
  {
    key: 'cron:refresh-events',
    reason:
      'operatorAudit.ts:56 + urlLiveness.ts:826 — `bearerFingerprint: "cron:refresh-events"` is a hard-coded fingerprint sentinel, NOT a Redis key. The regex captures it because the prefix happens to look like a key. Not a registry concern.',
  },
  {
    key: 'sites:v2',
    reason:
      'migration-cleanup probe in server/routes/sites.ts:34,53 — cold-fill rollout from Phase 27.3.1 Plan 11 G4. The v2 key is unread/dead (per healthSources.ts:17 comment); listed here for surveillance during retirement.',
  },
  {
    key: 'water:facilities:v2',
    reason:
      'migration-cleanup probe in server/routes/water.ts:50,113 — cold-fill rollout from the same Phase. Dead after deploy; listed for surveillance.',
  },
  {
    key: 'water:facilities:v3',
    reason:
      'migration-cleanup probe; dead after the Phase 42 v4 deploy (name-aware dedup behavior bump). The prior canonical key now ages out under its hard TTL; listed for surveillance during retirement.',
  },
  {
    key: 'water:facilities',
    reason:
      'transitional bare-prefix string in server/routes/water.ts (used as a redis-store debug probe in test fixtures); not the canonical key (`water:facilities:v4` is canonical).',
  },
];

/** Top-level Redis prefix families. Order matches docs/redis-keys.md. */
const KEY_PREFIX_FAMILIES: string[] = [
  'events:',
  'flights:',
  'ships:',
  'sites:',
  'water:',
  'news:',
  'markets:',
  'weather:',
  'geocode:',
  'llm:',
  'cron:',
  'operator:',
  'audit:',
  'dashboard:',
  'ratelimit:',
];

/**
 * Matches a Redis-key-shaped literal inside a backtick (markdown code span):
 *   `events:llm:v3` → captures `events:llm:v3`
 *   `events:llm:v3:lineage:{eventId}` → captures `events:llm:v3:lineage:{eventId}`
 *
 * `.` is included in the character class because some keys carry `:v3.partial`-style
 * adornments in historical docs; `{` `}` admit placeholder fragments.
 */
const BACKTICK_KEY_RE =
  /`((?:events|flights|ships|sites|water|news|markets|weather|geocode|llm|cron|operator|audit|dashboard|ratelimit):[a-zA-Z0-9:_{}.-]+)`/g;

/**
 * Matches a Redis-key-shaped string literal in TS source:
 *   'events:llm:v3'
 *   "events:llm:v3"
 *   `events:llm:v3:lineage:${eventId}`  (captures up to the `${` boundary → `events:llm:v3:lineage:`)
 *
 * Bracket-stripping logic in `extractKeysFromMarkdown` normalises the doc side so
 * both sides match on the prefix portion only.
 */
const CODE_KEY_RE =
  /['"`]((?:events|flights|ships|sites|water|news|markets|weather|geocode|llm|cron|operator|audit|dashboard|ratelimit):[a-zA-Z0-9:_-]*)/g;

/**
 * Strip placeholder fragments (`{...}` and `<...>`), collapse runs of `::` produced
 * by stripping a placeholder mid-key, and strip any trailing `:`. After normalisation
 * `llm:tokens:{provider}:YYYY-MM-DD` → `llm:tokens` (date suffix is also placeholder-ish
 * — `YYYY-MM-DD` is literal in docs but the value is a runtime date, so we collapse
 * adjacent `::` and trim the literal-date tail by stripping anything that looks like
 * `YYYY-MM-DD` too).
 */
function normaliseKey(raw: string): string {
  return raw
    .replace(/\{[^}]+\}/g, '') // {eventId}, {range}, {hash}, etc.
    .replace(/<[^>]+>/g, '') // <name> umbrella shorthand (e.g. cron:lastTick:<name>)
    .replace(/:YYYY-MM-DD/gi, '') // literal date placeholder in docs
    .replace(/:+/g, ':') // collapse `::` runs left by placeholder strip
    .replace(/:+$/, ''); // trailing `:`
}

/**
 * Two normalised keys are "equivalent" if either is a prefix of the other (joined on
 * `:` boundaries). e.g. a documented umbrella `flights` matches `flights:opensky`
 * (specific row in redis-keys.md); `cron:lastTick` matches `cron:lastTick:warm`.
 */
function keysEquivalent(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length === 0 || b.length === 0) return false;
  return a.startsWith(b + ':') || b.startsWith(a + ':');
}

function setHasEquivalent(haystack: ReadonlySet<string>, needle: string): boolean {
  for (const h of haystack) if (keysEquivalent(h, needle)) return true;
  return false;
}

/** Read a markdown file and harvest every backticked Redis-key literal. */
function extractKeysFromMarkdown(path: string): Set<string> {
  const src = readFileSync(path, 'utf-8');

  const keys = new Set<string>();
  for (const m of src.matchAll(BACKTICK_KEY_RE)) {
    const k = normaliseKey(m[1]);
    if (k.length > 0) keys.add(k);
  }
  return keys;
}

/**
 * Recursively walk a directory collecting .ts / .tsx files. Skips:
 *   - node_modules / dist / .git (vendor + build output)
 *   - __tests__ directories (test fixtures contain hardcoded key-shaped literals
 *     like `geocode:33.25,44.25` that the CODE_KEY_RE captures as truncated
 *     `geocode:33` orphans — production registry only, please)
 *   - Files ending in .test.ts / .test.tsx / .spec.ts / .spec.tsx (same reason)
 *
 * Production Redis-key writers MUST live in non-test code. If a key is only
 * referenced from a test file, that's a regression — the test file pretends
 * to be a writer but no production caller exists. The drift gate flags that
 * as documented-without-code-reference, which is the correct failure mode.
 */
function walkTsFiles(dir: string, acc: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const name of entries) {
    if (name === 'node_modules' || name === 'dist' || name === '.git') continue;
    if (name === '__tests__') continue;
    const full = join(dir, name);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      walkTsFiles(full, acc);
    } else if (
      (name.endsWith('.ts') || name.endsWith('.tsx')) &&
      !name.endsWith('.test.ts') &&
      !name.endsWith('.test.tsx') &&
      !name.endsWith('.spec.ts') &&
      !name.endsWith('.spec.tsx')
    ) {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * Grep server/ + src/ for Redis-key literals. Returns a Map<key, Set<filePath>> so
 * failure messages can cite the first few file paths where a drifted key was found.
 */
function extractKeysFromCode(): Map<string, Set<string>> {
  const files = [
    ...walkTsFiles(resolve(REPO_ROOT, 'server')),
    ...walkTsFiles(resolve(REPO_ROOT, 'src')),
  ];
  const out = new Map<string, Set<string>>();
  for (const file of files) {
    let src: string;
    try {
      src = readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    for (const m of src.matchAll(CODE_KEY_RE)) {
      const raw = m[1];
      // Strip trailing `:` only if it is a template-literal prefix (e.g.
      // `events:url-liveness:` from `\`events:url-liveness:${eventId}\``).
      const k = raw.endsWith(':') ? raw : raw;
      if (k.length === 0) continue;
      let bucket = out.get(k);
      if (!bucket) {
        bucket = new Set<string>();
        out.set(k, bucket);
      }
      bucket.add(file);
    }
  }
  return out;
}

// Module-level computations — run once for the whole suite.
const redisKeysDoc = extractKeysFromMarkdown(REDIS_KEYS_MD);
const codeKeys = extractKeysFromCode();

/**
 * A code key "matches" a documented key iff their normalised forms are equivalent
 * (prefix-equivalent on `:` boundaries). e.g. `events:url-liveness:` (code, from
 * `\`events:url-liveness:${id}\``) matches `events:url-liveness` (doc, normalised
 * from `events:url-liveness:{eventId}`).
 */
function isCodeKeyDocumented(codeKey: string, documented: ReadonlySet<string>): boolean {
  const normCode = normaliseKey(codeKey);
  return setHasEquivalent(documented, normCode);
}

function isExempt(codeKey: string): boolean {
  const normCode = normaliseKey(codeKey);
  return EXEMPT_KEYS.some((e) => keysEquivalent(normCode, normaliseKey(e.key)));
}

describe('Redis-key registry drift gate', () => {
  it('KEY_PREFIX_FAMILIES guard — regex stays in lockstep with documented families', () => {
    // Cheap sanity check so a future contributor who renames a family in the regex
    // also updates the list. Otherwise an entire family could silently fall out of
    // scope and the drift gate would pass on zero coverage.
    expect(KEY_PREFIX_FAMILIES.length).toBe(15);
    for (const fam of KEY_PREFIX_FAMILIES) {
      expect(BACKTICK_KEY_RE.source).toContain(fam.replace(':', ''));
      expect(CODE_KEY_RE.source).toContain(fam.replace(':', ''));
    }
  });

  it('registry has at least 10 documented keys (guard against silent empty-input it.each pass)', () => {
    // If the markdown parser returned an empty set, the it.each below would silently
    // pass on zero iterations. Phase 35 ships with ≥ 20 documented keys post-D-14 —
    // assert ≥ 10 to be safe.
    expect(redisKeysDoc.size).toBeGreaterThanOrEqual(10);
    expect(redisKeysDoc.size).toBeGreaterThanOrEqual(10);
  });

  describe('documented-key → code reference (no orphans in docs)', () => {
    it.each([...redisKeysDoc])('documented key %s has ≥1 code reference', (key) => {
      if (isExempt(key)) return;
      // Doc keys are already normalised (no `{}`). The code key may have a trailing
      // `:` from a template-literal prefix, so we accept either an exact match or a
      // prefix-match in either direction.
      let found = false;
      for (const codeKey of codeKeys.keys()) {
        const normCode = codeKey.replace(/:$/, '');
        if (normCode === key || normCode.startsWith(key + ':') || key.startsWith(normCode + ':')) {
          found = true;
          break;
        }
      }
      expect(found, `Documented key '${key}' has no code reference in server/ or src/`).toBe(true);
    });
  });

  describe('code-key → documentation (no undocumented drift)', () => {
    it('every code key matches a documented key (or is exempt)', () => {
      const documented = redisKeysDoc;
      const orphans: Array<{ key: string; refs: string[] }> = [];
      for (const [codeKey, refs] of codeKeys) {
        if (isExempt(codeKey)) continue;
        if (!isCodeKeyDocumented(codeKey, documented)) {
          orphans.push({
            key: codeKey,
            refs: [...refs].slice(0, 3).map((r) => r.replace(REPO_ROOT + '/', '')),
          });
        }
      }
      if (orphans.length > 0) {
        const detail = orphans
          .map((o) => `  - '${o.key}' (first refs: ${o.refs.join(', ')})`)
          .join('\n');
        expect.fail(
          `Found ${orphans.length} code key(s) not documented in docs/redis-keys.md (and not in EXEMPT_KEYS):\n${detail}`,
        );
      }
    });
  });
});
