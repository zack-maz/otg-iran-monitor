/**
 * GDELT-MATCH-03 — generalized three-gate OSINT corroboration.
 *
 * Generalizes the Phase-22 Bellingcat three-gate (`checkBellingcatCorroboration`
 * in `eventScoring.ts`) from Bellingcat-specific articles to ANY tier-1/2 OSINT
 * source carried in the `news:feed` GDELT-DOC clusters.
 *
 * A corroboration boost is granted ONLY when ALL THREE gates pass against the
 * same news article:
 *   1. TEMPORAL  — article publishedAt within ±CORROBORATION_TEMPORAL_WINDOW_MS
 *      of the event timestamp.
 *   2. GEOGRAPHIC — article lat/lng within CORROBORATION_GEO_RADIUS_KM (haversine)
 *      of the event coordinate.
 *   3. KEYWORD (STRICT) — at least CORROBORATION_MIN_KEYWORD_MATCHES SPECIFIC
 *      tokens overlap between the event (actors + specific location tokens) and
 *      the article title. Generic conflict/country tokens ("iran", "strike",
 *      "attack", ...) are EXCLUDED from the match set so a same-city-same-day
 *      coincidence cannot inflate the score (GDELT-MATCH-03 landmine).
 *
 * The boost is weighted by the corroborating source's tier (gold/silver/bronze)
 * via `sourceTiers.getSourceTier`: a tier-1 wire/OSINT corroborator earns more
 * than a tier-3 state-media one. When only 1-2 gates pass the boost is withheld
 * (returns `{ corroborated: false, boost: 0 }`).
 *
 * D-07: pure — no Redis, no I/O, no mutation. The caller decides how to apply
 * the boost (the composite rescore reads it; the raw corpus is never touched).
 *
 * @module corroboration
 */

import { haversineKm } from '../../src/lib/geo.js';

import { extractDomain, getSourceTier, type SourceTier } from './sourceTiers.js';

import type { ConflictEventEntity, NewsCluster } from '../types.js';

// ---- Three-gate constants (sized off the Phase-22 Bellingcat gate) ----
//
// GDELT-MATCH-03 sizing caveat (38-03-SUMMARY.md): the audit's orphan/
// corroboration baseline was UNUSABLE (empty `news:feed` in dev gave a 100%
// orphan artifact). These thresholds therefore mirror the proven Bellingcat
// three-gate (±24h, 200km, ≥2 keyword) CONSERVATIVELY and need a re-validation
// pass against a populated `news:feed` before any loosening.
const CORROBORATION_TEMPORAL_WINDOW_MS = 24 * 60 * 60 * 1000; // ±24h
const CORROBORATION_GEO_RADIUS_KM = 200;
const CORROBORATION_MIN_KEYWORD_MATCHES = 2;

// Per-tier boost weights — gold corroboration is worth more than bronze.
const TIER_BOOST: Record<SourceTier, number> = {
  1: 0.25, // gold (wire services + OSINT)
  2: 0.15, // silver (major outlets)
  3: 0.08, // bronze (regional/state media)
};
// Corroboration from an unknown-tier source still counts (it is a real
// independent mention) but earns the smallest boost.
const UNKNOWN_TIER_BOOST = 0.05;

/**
 * Generic tokens that must NOT, on their own, satisfy the keyword gate. These
 * are the high-frequency country/conflict words that appear in nearly every
 * conflict headline — matching on them produces same-city-same-day false
 * positives. The strict gate counts ONLY specific tokens (actors + place names)
 * after removing these.
 */
const GENERIC_STOPWORDS = new Set([
  'iran',
  'iranian',
  'israel',
  'israeli',
  'us',
  'usa',
  'united',
  'states',
  'strike',
  'strikes',
  'attack',
  'attacks',
  'war',
  'forces',
  'military',
  'conflict',
  'reports',
  'news',
  'said',
  'near',
  'over',
  'amid',
  'after',
  'the',
  'and',
  'for',
  'with',
]);

/** Tokenize a string into lowercase alphanumeric words ≥3 chars. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3);
}

/**
 * Build the STRICT match-token set for an event: actor names + specific location
 * tokens (city/landmark from locationName), minus generic stopwords. These are
 * the tokens that must appear in the corroborating article title.
 */
function specificEventTokens(event: ConflictEventEntity): Set<string> {
  const sources: string[] = [];
  if (event.data.actors && event.data.actors.length > 0) {
    sources.push(...event.data.actors);
  }
  if (event.data.actor1) sources.push(event.data.actor1);
  if (event.data.actor2) sources.push(event.data.actor2);
  if (event.data.locationName) sources.push(event.data.locationName);

  const tokens = new Set<string>();
  for (const src of sources) {
    for (const tok of tokenize(src)) {
      if (!GENERIC_STOPWORDS.has(tok)) tokens.add(tok);
    }
  }
  return tokens;
}

export interface CorroborationResult {
  corroborated: boolean;
  /** Additive confidence boost (0 when not corroborated). */
  boost: number;
  /** Best corroborating source tier (1/2/3), or null if unknown-tier. */
  tier: SourceTier | null;
}

/**
 * Check whether an event is corroborated by any tier-1/2/3 OSINT article in the
 * `news:feed` clusters using the strict three-gate. Returns the highest boost
 * found (best tier wins) or `{ corroborated: false, boost: 0, tier: null }`.
 */
export function checkCorroboration(
  event: ConflictEventEntity,
  clusters: NewsCluster[],
): CorroborationResult {
  const eventTokens = specificEventTokens(event);
  // No specific tokens to match on → cannot strictly corroborate.
  if (eventTokens.size === 0) {
    return { corroborated: false, boost: 0, tier: null };
  }

  let bestBoost = 0;
  let bestTier: SourceTier | null = null;
  let corroborated = false;

  for (const cluster of clusters) {
    for (const article of cluster.articles) {
      // Gate 1 — temporal.
      if (Math.abs(article.publishedAt - event.timestamp) > CORROBORATION_TEMPORAL_WINDOW_MS) {
        continue;
      }

      // Gate 2 — geographic (requires coordinates).
      if (article.lat == null || article.lng == null) continue;
      if (
        haversineKm(event.lat, event.lng, article.lat, article.lng) > CORROBORATION_GEO_RADIUS_KM
      ) {
        continue;
      }

      // Gate 3 — STRICT keyword (specific actor/place tokens only).
      const titleTokens = new Set(tokenize(article.title));
      let matches = 0;
      for (const tok of eventTokens) {
        if (titleTokens.has(tok)) matches++;
      }
      if (matches < CORROBORATION_MIN_KEYWORD_MATCHES) continue;

      // All three gates passed — weight by the article's source tier.
      const domain = article.domain ?? (article.url ? extractDomain(article.url) : '');
      const tier = getSourceTier(article.source ?? '', domain || undefined);
      const boost = tier !== null ? TIER_BOOST[tier] : UNKNOWN_TIER_BOOST;

      corroborated = true;
      if (boost > bestBoost) {
        bestBoost = boost;
        bestTier = tier;
      }
    }
  }

  return { corroborated, boost: bestBoost, tier: bestTier };
}
