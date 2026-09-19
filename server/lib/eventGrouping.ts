import type { ConflictEventEntity } from '../types.js';

/** Haversine distance in km (inlined to avoid cross-boundary import from client src/) */
function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const GROUP_RADIUS_KM = 50;
const MS_PER_DAY = 86_400_000;

// ---------------------------------------------------------------------------
// GDELT-MATCH-02 — high-confidence pre-enrichment dedup thresholds.
//
// Sized by the GDELT-MATCH-01 audit (38-03-SUMMARY.md): the coarse day +
// CAMEO-root + ≤50km grouping already collapses ~53% of the corpus, but that
// is BATCH-grouping for enrichment, NOT true dedup (Pitfall 6). The audit's
// size-2 cohort (81 of 134 clusters) is the conservative high-confidence
// duplicate target; the size 6–9 long tail is likely genuine multi-strike
// activity and MUST be preserved. We therefore gate dedup far tighter than the
// 50km batch radius and require near-identical titles. Defaults are the
// conservative end of the audit's recommendation (a missed dedup is cheaper
// than a wrongly-merged distinct event).
// ---------------------------------------------------------------------------
const DEDUP_RADIUS_KM = 5; // tighter than GROUP_RADIUS_KM (audit conservative end)
const DEDUP_TITLE_JACCARD = 0.85; // audit-recommended high-confidence floor

export interface EventGroup {
  key: string;
  entities: ConflictEventEntity[];
  centroidLat: number;
  centroidLng: number;
  primaryCameo: string;
  timestamp: number;
  totalMentions: number;
  totalSources: number;
  sourceUrls: string[];
}

/** Extract CAMEO root code (first 2 chars) from a CAMEO event code */
function cameoRoot(cameoCode: string): string {
  return cameoCode.slice(0, 2);
}

/** Get the day bucket for a timestamp */
function dayBucket(timestamp: number): number {
  return Math.floor(timestamp / MS_PER_DAY);
}

/** Recompute centroid from entities */
function computeCentroid(entities: ConflictEventEntity[]): { lat: number; lng: number } {
  let latSum = 0;
  let lngSum = 0;
  for (const e of entities) {
    latSum += e.lat;
    lngSum += e.lng;
  }
  return { lat: latSum / entities.length, lng: lngSum / entities.length };
}

/** Canonical actor-pair key — order-independent so A→B and B→A match. */
function actorPairKey(e: ConflictEventEntity): string {
  const a = (e.data.actor1 ?? '').trim().toLowerCase();
  const b = (e.data.actor2 ?? '').trim().toLowerCase();
  return [a, b].sort().join('|');
}

/** Tokenize a title/notes string into a set of lowercase alphanumeric words. */
function titleTokens(e: ConflictEventEntity): Set<string> {
  const text = `${e.label ?? ''} ${e.data.notes ?? ''}`;
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .filter((t) => t.length > 0),
  );
}

/** Jaccard similarity between two token sets (1 when both empty). */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Mention/source weight used to pick the canonical row when collapsing. */
function dedupWeight(e: ConflictEventEntity): number {
  return (e.data.numMentions ?? 0) * 10 + (e.data.numSources ?? 0);
}

/**
 * GDELT-MATCH-02 — high-confidence pre-enrichment dedup pass.
 *
 * DISTINCT from `groupGdeltRows` (the coarse 50km batch-grouping for
 * enrichment). This pass runs BEFORE LLM enrichment and collapses a set of raw
 * GDELT mentions to ONE canonical row ONLY when a conservative AND-gate passes:
 *   - same canonical actor pair (order-independent), AND
 *   - same CAMEO root code, AND
 *   - same day-bucket, AND
 *   - within DEDUP_RADIUS_KM (5km — tighter than GROUP_RADIUS_KM), AND
 *   - title/notes token Jaccard ≥ DEDUP_TITLE_JACCARD (0.85).
 *
 * The canonical row kept per collapse is the highest-weight mention
 * (numMentions×10 + numSources) so the strongest-sourced row survives.
 *
 * D-07 / Pitfall 6: this is a PURE read-and-filter — it returns a new array and
 * NEVER mutates the input entities or the raw `events:gdelt` cache. It prefers
 * UNDER-collapsing (the size 6–9 multi-strike tail is preserved) over wrongly
 * merging distinct events.
 */
export function dedupHighConfidence(entities: ConflictEventEntity[]): ConflictEventEntity[] {
  // Stable: process highest-weight rows first so they become the canonical kept
  // row for their cluster; ties fall back to earliest timestamp.
  const ordered = [...entities].sort((a, b) => {
    const w = dedupWeight(b) - dedupWeight(a);
    return w !== 0 ? w : a.timestamp - b.timestamp;
  });

  const kept: ConflictEventEntity[] = [];
  const keptTokens: Set<string>[] = [];

  for (const entity of ordered) {
    const entityDay = dayBucket(entity.timestamp);
    const entityRoot = cameoRoot(entity.data.cameoCode);
    const entityActors = actorPairKey(entity);
    const tokens = titleTokens(entity);

    let isDuplicate = false;
    for (let i = 0; i < kept.length; i++) {
      const candidate = kept[i]!;
      if (dayBucket(candidate.timestamp) !== entityDay) continue;
      if (cameoRoot(candidate.data.cameoCode) !== entityRoot) continue;
      if (actorPairKey(candidate) !== entityActors) continue;
      if (haversineKm(candidate.lat, candidate.lng, entity.lat, entity.lng) > DEDUP_RADIUS_KM)
        continue;
      // WR-03: jaccard(∅, ∅) === 1, so two rows whose title+notes yield empty
      // token sets would pass the similarity gate on zero textual evidence and
      // over-collapse. Treat empty-vs-empty as NOT a duplicate — prefer
      // under-collapsing (D-07 / Pitfall 6).
      if (keptTokens[i]!.size === 0 && tokens.size === 0) continue;
      if (jaccard(keptTokens[i]!, tokens) < DEDUP_TITLE_JACCARD) continue;

      // All gates passed — this is a high-confidence duplicate of an already
      // kept (higher-or-equal-weight) canonical row. Drop it.
      isDuplicate = true;
      break;
    }

    if (!isDuplicate) {
      kept.push(entity);
      keptTokens.push(tokens);
    }
  }

  return kept;
}

/**
 * Group raw GDELT conflict event entities by real-world event.
 *
 * Algorithm: For each entity (sorted by timestamp), find an existing group where:
 *   - Same day (Math.floor(timestamp / 86400000))
 *   - Same CAMEO root code (first 2 chars of cameoCode)
 *   - Group centroid within 50km (haversine)
 *
 * If match found, add to group and recompute centroid. Otherwise, create new group.
 */
export function groupGdeltRows(entities: ConflictEventEntity[]): EventGroup[] {
  // Sort by timestamp ascending
  const sorted = [...entities].sort((a, b) => a.timestamp - b.timestamp);
  const groups: EventGroup[] = [];

  for (const entity of sorted) {
    const entityDay = dayBucket(entity.timestamp);
    const entityRoot = cameoRoot(entity.data.cameoCode);

    // Find a matching group
    let matched = false;
    for (const group of groups) {
      const groupDay = dayBucket(group.timestamp);
      if (groupDay !== entityDay) continue;
      if (cameoRoot(group.primaryCameo) !== entityRoot) continue;
      if (
        haversineKm(group.centroidLat, group.centroidLng, entity.lat, entity.lng) > GROUP_RADIUS_KM
      )
        continue;

      // Match found — add to group
      group.entities.push(entity);
      const centroid = computeCentroid(group.entities);
      group.centroidLat = centroid.lat;
      group.centroidLng = centroid.lng;
      group.totalMentions += entity.data.numMentions ?? 0;
      group.totalSources += entity.data.numSources ?? 0;
      if (entity.data.source) {
        group.sourceUrls.push(entity.data.source);
      }
      if (entity.timestamp < group.timestamp) {
        group.timestamp = entity.timestamp;
      }
      matched = true;
      break;
    }

    if (!matched) {
      // Create new group
      groups.push({
        key: '', // assigned below, once membership is final
        entities: [entity],
        centroidLat: entity.lat,
        centroidLng: entity.lng,
        primaryCameo: entity.data.cameoCode,
        timestamp: entity.timestamp,
        totalMentions: entity.data.numMentions ?? 0,
        totalSources: entity.data.numSources ?? 0,
        sourceUrls: entity.data.source ? [entity.data.source] : [],
      });
    }
  }

  // The key is derived from content — day, CAMEO root and the lowest GDELT
  // event id in the group — never from the group's position in this pass. The
  // corpus is re-sampled between runs, and a positional index shifts every
  // later key as soon as one earlier row appears: the pipeline's "only new
  // groups" diff then misses, and merge-by-id writes one event's enrichment
  // over another's.
  for (const group of groups) {
    const day = dayBucket(group.timestamp);
    const root = cameoRoot(group.primaryCameo);
    group.key = `grp-${day}-${root}-${lowestEntityId(group.entities)}`;
  }

  return groups;
}

/** Lowest member id, numeric where the id is `gdelt-<GlobalEventID>`. */
function lowestEntityId(entities: ConflictEventEntity[]): string {
  let best = '';
  let bestNum = Number.POSITIVE_INFINITY;
  for (const e of entities) {
    const bare = e.id.replace(/^gdelt-/, '');
    const num = Number(bare);
    if (Number.isFinite(num)) {
      if (num < bestNum) {
        bestNum = num;
        best = bare;
      }
    } else if (bestNum === Number.POSITIVE_INFINITY && (best === '' || bare < best)) {
      best = bare;
    }
  }
  return best;
}

/** Id of the enriched entity the LLM pipeline writes for a group. */
export function enrichedIdForGroup(groupKey: string): string {
  return `llm-v3-${groupKey}`;
}

/**
 * The events to serve while the enriched cache covers only part of the corpus:
 * every enriched event, plus the raw rows of each group that has no enriched
 * event yet.
 *
 * The pipeline fills `events:llm:v3` a wave at a time, most severe groups
 * first, over several runs. Serving the enriched cache alone (the behaviour
 * when a run wrote the whole corpus at once) would shrink the map to the first
 * wave — 30 events in place of ~1,000 — until the corpus is covered. Pure:
 * nothing here calls the LLM or writes a cache, so it is safe on the read path.
 */
export function fillWithRawEvents(
  enriched: ConflictEventEntity[],
  raw: ConflictEventEntity[],
): ConflictEventEntity[] {
  if (raw.length === 0) return enriched;
  if (enriched.length === 0) return raw;
  const enrichedIds = new Set(enriched.map((e) => e.id));
  const uncovered: ConflictEventEntity[] = [];
  for (const group of groupGdeltRows(dedupHighConfidence(raw))) {
    if (!enrichedIds.has(enrichedIdForGroup(group.key))) uncovered.push(...group.entities);
  }
  return [...enriched, ...uncovered];
}
