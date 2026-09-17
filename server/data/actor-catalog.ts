/**
 * Phase 33 D-04..D-06 — canonical actor catalog for the Iran conflict.
 *
 * Static-data module. Zero Redis, zero env, zero runtime config. Pattern
 * mirrors src/lib/factions.ts + src/lib/ethnicGroups.ts (typed const +
 * exported lookup; no I/O at module load beyond pure derivation). Consumed
 * by:
 *
 *   - server/lib/llmEventExtractor.v3.ts post-validate canonicalization
 *     (Plan 33-04 D-08 — server-side post-mapping is the canonicalization
 *     point; LLM prompt compliance is non-binding, this catalog is the
 *     single source of truth)
 *   - src/__tests__/lib/actorCatalog.test.ts contract assertions
 *     (Plan 33-02 D-07 — five invariants pinned at test time)
 *   - server/routes/operator-status.ts via shared classifier (Plan 33-06
 *     D-16, optional)
 *
 * CAMEO codes cross-reference the committed snapshot at
 *   src/__tests__/fixtures/cameo-codes.json
 * Orphan codes (cameoCodes[] entries not present in that snapshot) fail
 * the contract test loudly. If GDELT renames an actor code upstream, the
 * mismatch surfaces on the next vitest run — no auto-resync (see
 * 33-CONTEXT.md "Deferred Ideas").
 *
 * Cron-only-writer invariant unaffected: this module is static data; the
 * sole writer to events:llm:v3 remains the daily 04:00 UTC
 * /api/cron/refresh-events handler (anti-pattern #17).
 *
 * Cross-boundary import note (33-PATTERNS.md risk #5): the obvious
 * approach is `import type { Faction } from '../../src/lib/factions.js'`,
 * matching the server/lib/eventScoring.ts → src/lib/geo.js precedent.
 * However, factions.ts itself uses the `@/lib/colorBridge` path alias
 * which is defined in tsconfig.app.json but NOT tsconfig.server.json.
 * Pulling factions.ts into the server compile graph therefore breaks
 * the server typecheck (TS2307 unresolved `@/lib/colorBridge`).
 *
 * Mitigation per PATTERNS.md fallback strategy: duplicate the 3-string
 * union literal locally with a sentinel test ensuring byte-identity
 * with src/lib/factions.ts:5. The sentinel test lives in
 * src/__tests__/lib/actorCatalog.test.ts under the contract suite —
 * it reads both files via readFileSync and regex-extracts the Faction
 * literal, asserting equality. Drift fails the next vitest run.
 *
 * Keep in sync with src/lib/factions.ts:5 `export type Faction`.
 */
type Faction = 'us' | 'iran' | 'neutral';

/**
 * One canonical actor in the Iran-conflict-relevant set.
 *
 * - `canonicalName` is the operator-trusted long-form label
 *   (e.g. "Islamic Revolutionary Guard Corps", not "IRGC")
 * - `aliases` are LOWERCASE variants used by canonicalize() lookup.
 *   Include abbreviations, alternate spellings, and short forms.
 * - `cameoCodes` lists GDELT CAMEO actor codes that should also resolve
 *   to this canonical at audit time. EMPTY ARRAY is correct for actors
 *   GDELT does not name (e.g. sub-organizational units, named militias).
 *   Never invent codes — orphan codes fail the contract test (D-07 b).
 * - `affiliation` reuses the existing 3-way Faction enum from
 *   src/lib/factions.ts. Stored but not surfaced to the dashboard this
 *   phase per Discretion §6 ("reserved for future use").
 */
export interface CanonicalActor {
  canonicalName: string;
  aliases: string[];
  cameoCodes: string[];
  affiliation: Faction;
}

/**
 * Iran-conflict-relevant actors (D-06 baseline seed list). ~30-50 entries
 * covering the major belligerents + proxies + regional coalitions. Final
 * list is refined post-audit (Plan 33-01) but this baseline ships in
 * Phase 33 Wave 1 so downstream plans can integrate against a stable
 * module.
 *
 * Affiliation legend (3-way per Faction enum):
 *   'us'      = US-aligned (USA + GCC + Israel)
 *   'iran'    = Iran-aligned (Iran + Axis of Resistance + Syria)
 *   'neutral' = neither bloc (Russia / Turkey acting independently,
 *               Kurdish forces, etc.)
 */
export const ACTOR_CATALOG: ReadonlyArray<CanonicalActor> = [
  // US-aligned: Israel
  {
    canonicalName: 'Israeli Defense Forces',
    aliases: ['idf', 'israeli defense forces', 'israel defense forces', 'israeli army', 'tsahal'],
    cameoCodes: ['ISRMIL'],
    affiliation: 'us',
  },
  // US-aligned: United States
  {
    canonicalName: 'US Armed Forces',
    aliases: [
      'us armed forces',
      'united states military',
      'us military',
      'usmil',
      'american forces',
      'us forces',
    ],
    cameoCodes: ['USAMIL'],
    affiliation: 'us',
  },
  {
    canonicalName: 'US Central Command',
    aliases: ['uscentcom', 'centcom', 'us central command'],
    cameoCodes: [],
    affiliation: 'us',
  },
  {
    canonicalName: 'US Navy',
    aliases: ['us navy', 'united states navy', 'usn'],
    cameoCodes: [],
    affiliation: 'us',
  },
  {
    canonicalName: 'US Air Force',
    aliases: ['us air force', 'united states air force', 'usaf'],
    cameoCodes: [],
    affiliation: 'us',
  },
  {
    canonicalName: 'US Army',
    aliases: ['us army', 'united states army'],
    cameoCodes: [],
    affiliation: 'us',
  },
  // US-aligned: GCC + regional
  {
    canonicalName: 'Royal Saudi Air Force',
    aliases: ['royal saudi air force', 'rsaf', 'saudi air force'],
    cameoCodes: ['SAUMIL'],
    affiliation: 'us',
  },
  {
    canonicalName: 'Saudi-led Coalition',
    aliases: ['saudi-led coalition', 'saudi led coalition', 'arab coalition'],
    cameoCodes: [],
    affiliation: 'us',
  },
  // Iran-aligned: Iran state
  {
    canonicalName: 'Islamic Revolutionary Guard Corps',
    aliases: [
      'irgc',
      'islamic revolutionary guard corps',
      'iranian revolutionary guard corps',
      'revolutionary guard',
      'revolutionary guards',
      'sepah',
      'pasdaran',
    ],
    cameoCodes: [],
    affiliation: 'iran',
  },
  {
    canonicalName: 'IRGC Quds Force',
    aliases: ['irgc quds force', 'quds force', 'qods force', 'iranian quds force'],
    cameoCodes: [],
    affiliation: 'iran',
  },
  {
    canonicalName: 'IRGC Aerospace Force',
    aliases: ['irgc aerospace force', 'irgc aerospace', 'iranian aerospace force', 'irgc-asf'],
    cameoCodes: [],
    affiliation: 'iran',
  },
  {
    canonicalName: 'Iranian Armed Forces',
    aliases: [
      'iranian armed forces',
      'iran military',
      'iranian military',
      'artesh',
      'iranian army',
    ],
    cameoCodes: ['IRNMIL'],
    affiliation: 'iran',
  },
  // Iran-aligned: Lebanon
  {
    canonicalName: 'Hezbollah',
    aliases: ['hezbollah', 'hizbullah', 'hizballah', 'hizbollah', 'party of god'],
    cameoCodes: ['HZB'],
    affiliation: 'iran',
  },
  // Iran-aligned: Yemen
  {
    canonicalName: 'Houthis',
    aliases: ['houthis', 'ansar allah', 'ansarallah', 'houthi', 'houthi movement'],
    cameoCodes: [],
    affiliation: 'iran',
  },
  // Iran-aligned: Palestine
  {
    canonicalName: 'Hamas',
    aliases: ['hamas', 'islamic resistance movement', 'harakat al-muqawama al-islamiya'],
    cameoCodes: ['HMS'],
    affiliation: 'iran',
  },
  {
    canonicalName: 'Palestinian Islamic Jihad',
    aliases: ['palestinian islamic jihad', 'pij', 'islamic jihad'],
    cameoCodes: [],
    affiliation: 'iran',
  },
  // Iran-aligned: Iraq militias
  {
    canonicalName: 'Kataib Hezbollah',
    aliases: ['kataib hezbollah', 'kataʼib hezbollah', 'kataeb hezbollah', 'kh'],
    cameoCodes: [],
    affiliation: 'iran',
  },
  {
    canonicalName: 'Asaib Ahl al-Haq',
    aliases: ['asaib ahl al-haq', 'asaib ahl al haq', 'aah', 'league of the righteous'],
    cameoCodes: [],
    affiliation: 'iran',
  },
  {
    canonicalName: 'Harakat Hezbollah al-Nujaba',
    aliases: ['harakat hezbollah al-nujaba', 'harakat al-nujaba', 'al-nujaba', 'nujaba movement'],
    cameoCodes: [],
    affiliation: 'iran',
  },
  {
    canonicalName: 'Popular Mobilization Forces',
    aliases: [
      'popular mobilization forces',
      'popular mobilization units',
      'pmf',
      'pmu',
      'hashd al-shaabi',
      'al-hashd al-shaabi',
    ],
    cameoCodes: [],
    affiliation: 'iran',
  },
  // Iran-aligned: Syria
  {
    canonicalName: 'Syrian Arab Army',
    aliases: ['syrian arab army', 'saa', 'syrian army', 'assad forces'],
    cameoCodes: ['SYRMIL'],
    affiliation: 'iran',
  },
  // Neutral: Russia (active in region but not bloc-aligned for this taxonomy)
  {
    canonicalName: 'Russian Aerospace Forces',
    aliases: ['russian aerospace forces', 'russian air force', 'vks', 'rusaf'],
    cameoCodes: ['RUSMIL'],
    affiliation: 'neutral',
  },
  // Neutral: Turkey
  {
    canonicalName: 'Turkish Armed Forces',
    aliases: ['turkish armed forces', 'tsk', 'turkish military', 'turkish army'],
    cameoCodes: ['TURMIL'],
    affiliation: 'neutral',
  },
  // Neutral: Kurdish forces (independent of both blocs)
  {
    canonicalName: 'Syrian Democratic Forces',
    aliases: ['syrian democratic forces', 'sdf', 'qsd'],
    cameoCodes: [],
    affiliation: 'neutral',
  },
  {
    canonicalName: 'Peshmerga',
    aliases: ['peshmerga', 'kurdish peshmerga', 'kurdistan regional guard'],
    cameoCodes: [],
    affiliation: 'neutral',
  },
  {
    canonicalName: 'Kurdistan Workers Party',
    aliases: ['kurdistan workers party', 'pkk', 'kurdistan workers’ party'],
    cameoCodes: [],
    affiliation: 'neutral',
  },
];

/**
 * Module-load lookup table built with **longest-alias-wins** ordering
 * (Claude's Discretion §3 — prevents generic names like "forces" from
 * shadowing more specific canonicals when both happen to appear as
 * aliases). Implementation: sort all (canonicalName, alias) keys
 * ascending by length, then insert into the Map — shorter keys land
 * first, longer keys overwrite. If two CanonicalActors ever share a
 * literal alias of the same length, the LATER catalog entry wins
 * non-deterministically — the contract test (D-07 c) catches that as
 * an alias collision.
 *
 * Keys are lowercased on insertion; canonicalize() lowercases on
 * lookup → case-insensitive match (D-07 d).
 */
export const ACTOR_LOOKUP: ReadonlyMap<string, CanonicalActor> = (() => {
  const m = new Map<string, CanonicalActor>();
  const allKeys: Array<{ key: string; actor: CanonicalActor }> = [];
  for (const actor of ACTOR_CATALOG) {
    allKeys.push({ key: actor.canonicalName.toLowerCase(), actor });
    for (const alias of actor.aliases) {
      allKeys.push({ key: alias.toLowerCase(), actor });
    }
  }
  allKeys.sort((a, b) => a.key.length - b.key.length);
  for (const { key, actor } of allKeys) {
    m.set(key, actor);
  }
  return m;
})();

/**
 * Case-insensitive lookup: trim + lowercase the input, then read from
 * ACTOR_LOOKUP. Returns null on unknown alias (D-07 e).
 *
 * Whitespace-only or empty strings return null after trim — the empty
 * string is never a catalog key.
 */
export function canonicalize(name: string): CanonicalActor | null {
  const key = name.trim().toLowerCase();
  if (key.length === 0) return null;
  return ACTOR_LOOKUP.get(key) ?? null;
}

/**
 * Derived list of canonical names — mirrors src/lib/ethnicGroups.ts:149
 * `ETHNIC_GROUP_IDS` pattern. Useful for iteration consumers (e.g.
 * dashboard rendering, eval scoring).
 */
export const ACTOR_CANONICAL_NAMES: string[] = ACTOR_CATALOG.map((a) => a.canonicalName);
