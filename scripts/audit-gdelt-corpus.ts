#!/usr/bin/env tsx
// CLI corpus-quality audit for the LLM-enriched event corpus (events:llm:v3).
// GDELT-MATCH-01 (Phase 38, Plan 03) — a Phase-22-style READ-ONLY audit that
// categorizes the live corpus into source-tier buckets, detects orphan events
// (no matching GDELT-DOC cluster), and sizes duplicate-source clusters.
//
// This is the HARD GATE for Plan 06: its findings size the GDELT-MATCH-02 dedup
// threshold, GDELT-MATCH-03 corroboration tuning, and GDELT-MATCH-04 composite
// weights. Per D-07 the audit is strictly non-destructive — it reads the corpus
// via cacheGetSafe only and NEVER writes back (no cacheSet / redis.set).
//
// Usage:
//   npx tsx scripts/audit-gdelt-corpus.ts                 # read live events:llm:v3 + news:feed
//   npx tsx scripts/audit-gdelt-corpus.ts --snapshot s.json  # read a captured snapshot instead
//   npx tsx scripts/audit-gdelt-corpus.ts -o gdelt-corpus-audit.json
//   npx tsx scripts/audit-gdelt-corpus.ts --help

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { groupGdeltRows, type EventGroup } from '../server/lib/eventGrouping.js';
import { getHighestTier, type SourceTier } from '../server/lib/sourceTiers.js';

import type { ConflictEventEntity, NewsCluster } from '../server/types.js';

// ----------------------------------------------------------------------------
// Pure logic (exported for unit testing — no Redis I/O lives here).
// ----------------------------------------------------------------------------

export interface TierBuckets {
  tier1: ConflictEventEntity[]; // high-confidence (gold)
  tier2: ConflictEventEntity[]; // neutral (silver)
  tier3: ConflictEventEntity[]; // low-confidence (bronze)
  unknown: ConflictEventEntity[]; // tier 3-equivalent / null (unknown source)
}

/** Collect all source URLs reachable on a single event. */
function eventSourceUrls(event: ConflictEventEntity): string[] {
  const urls: string[] = [];
  if (event.data.source) urls.push(event.data.source);
  return urls;
}

/**
 * Bucket each event by the HIGHEST tier of its source URLs.
 *   tier 1 → high-confidence, tier 2 → neutral, tier 3 → low-confidence,
 *   null → unknown (treated as low-confidence for sizing).
 */
export function bucketByTier(events: ConflictEventEntity[]): TierBuckets {
  const buckets: TierBuckets = { tier1: [], tier2: [], tier3: [], unknown: [] };

  for (const event of events) {
    const tier: SourceTier | null = getHighestTier(eventSourceUrls(event));
    if (tier === 1) buckets.tier1.push(event);
    else if (tier === 2) buckets.tier2.push(event);
    else if (tier === 3) buckets.tier3.push(event);
    else buckets.unknown.push(event);
  }

  return buckets;
}

const ORPHAN_GEO_RADIUS_KM = 50; // same scale as GROUP_RADIUS_KM
const ORPHAN_TEMPORAL_WINDOW_MS = 2 * 86_400_000; // ±2 days

/** Haversine distance in km (inlined to avoid cross-boundary import). */
function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Lowercase keyword tokens drawn from an event's location/notes for matching. */
function eventKeywordTokens(event: ConflictEventEntity): string[] {
  const text = `${event.data.locationName ?? ''} ${event.data.notes ?? ''}`.toLowerCase();
  return text.split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
}

/**
 * Orphan detection — an event is an orphan when NO GDELT-DOC cluster matches it
 * on all three gates: temporal (±2d) AND geographic (≤50km) AND keyword (≥1
 * shared token vs cluster article keywords). Mirrors the conservative three-gate
 * corroboration philosophy (do not match on coincidental same-region-same-day).
 */
export function detectOrphans(
  events: ConflictEventEntity[],
  clusters: NewsCluster[],
): ConflictEventEntity[] {
  // Pre-extract per-cluster geo/time/keyword signal (a cluster matches if ANY of
  // its articles satisfies the geo+keyword gates within the temporal window).
  const clusterSignals = clusters.map((c) => {
    const keywords = new Set<string>();
    for (const a of c.articles) {
      for (const k of a.keywords ?? []) keywords.add(k.toLowerCase());
    }
    return { cluster: c, keywords };
  });

  const orphans: ConflictEventEntity[] = [];

  for (const event of events) {
    const eventTokens = new Set(eventKeywordTokens(event));
    let matched = false;

    for (const { cluster, keywords } of clusterSignals) {
      // Temporal + geographic gates run against each article that carries coords.
      for (const article of cluster.articles) {
        if (Math.abs(article.publishedAt - event.timestamp) > ORPHAN_TEMPORAL_WINDOW_MS) continue;
        if (article.lat === undefined || article.lng === undefined) continue;
        if (haversineKm(article.lat, article.lng, event.lat, event.lng) > ORPHAN_GEO_RADIUS_KM)
          continue;

        // Keyword gate — at least one shared token between event + cluster.
        let sharedKeyword = false;
        for (const tok of eventTokens) {
          if (keywords.has(tok)) {
            sharedKeyword = true;
            break;
          }
        }
        if (!sharedKeyword) continue;

        matched = true;
        break;
      }
      if (matched) break;
    }

    if (!matched) orphans.push(event);
  }

  return orphans;
}

/**
 * Duplicate-source detection — group events via the existing GDELT batch-grouping
 * (same day-bucket AND CAMEO root AND ≤50km centroid) and report groups of size
 * ≥2 as duplicate-source candidates. NOTE (Pitfall 6): this is coarse
 * batch-grouping, NOT true dedup; Plan 02 (GDELT-MATCH-02) adds a tighter
 * AND-gate dedup pre-pass. This audit only SIZES the duplicate surface.
 */
export function detectDuplicateClusters(events: ConflictEventEntity[]): EventGroup[] {
  return groupGdeltRows(events).filter((g) => g.entities.length >= 2);
}

export interface CorpusAuditReport {
  generatedAt: string;
  total: number;
  tierCounts: { tier1: number; tier2: number; tier3: number; unknown: number };
  tierPercentages: { tier1: number; tier2: number; tier3: number; unknown: number };
  orphanCount: number;
  orphanRate: number; // orphans / total
  orphanIds: string[];
  duplicateClusterCount: number;
  duplicateEventCount: number; // sum of entities across duplicate clusters
  duplicateClusterSizeHistogram: Record<string, number>; // size → number of clusters
  largestDuplicateClusterSize: number;
}

function pct(part: number, total: number): number {
  return total === 0 ? 0 : Math.round((part / total) * 1000) / 10;
}

/** Assemble the full structured corpus-quality report (pure — no I/O). */
export function buildAuditReport(
  events: ConflictEventEntity[],
  clusters: NewsCluster[],
): CorpusAuditReport {
  const buckets = bucketByTier(events);
  const orphans = detectOrphans(events, clusters);
  const dupClusters = detectDuplicateClusters(events);

  const histogram: Record<string, number> = {};
  let duplicateEventCount = 0;
  let largest = 0;
  for (const g of dupClusters) {
    const size = g.entities.length;
    histogram[String(size)] = (histogram[String(size)] ?? 0) + 1;
    duplicateEventCount += size;
    if (size > largest) largest = size;
  }

  const total = events.length;

  return {
    generatedAt: new Date().toISOString(),
    total,
    tierCounts: {
      tier1: buckets.tier1.length,
      tier2: buckets.tier2.length,
      tier3: buckets.tier3.length,
      unknown: buckets.unknown.length,
    },
    tierPercentages: {
      tier1: pct(buckets.tier1.length, total),
      tier2: pct(buckets.tier2.length, total),
      tier3: pct(buckets.tier3.length, total),
      unknown: pct(buckets.unknown.length, total),
    },
    orphanCount: orphans.length,
    orphanRate: total === 0 ? 0 : Math.round((orphans.length / total) * 1000) / 1000,
    orphanIds: orphans.map((e) => e.id),
    duplicateClusterCount: dupClusters.length,
    duplicateEventCount,
    duplicateClusterSizeHistogram: histogram,
    largestDuplicateClusterSize: largest,
  };
}

/** Human-readable summary printer (analog of audit-events.ts printSummary). */
export function printSummary(report: CorpusAuditReport): void {
  console.log('\n--- GDELT Corpus Audit Summary ---');
  console.log(`Generated:      ${report.generatedAt}`);
  console.log(`Total events:   ${report.total}`);
  console.log('\nSource-tier buckets:');
  console.log(`  tier 1 (high):    ${report.tierCounts.tier1} (${report.tierPercentages.tier1}%)`);
  console.log(`  tier 2 (neutral): ${report.tierCounts.tier2} (${report.tierPercentages.tier2}%)`);
  console.log(`  tier 3 (low):     ${report.tierCounts.tier3} (${report.tierPercentages.tier3}%)`);
  console.log(
    `  unknown (null):   ${report.tierCounts.unknown} (${report.tierPercentages.unknown}%)`,
  );
  console.log(`\nOrphans (no DOC cluster): ${report.orphanCount} (${report.orphanRate * 100}%)`);
  console.log('\nDuplicate-source clusters (size >= 2):');
  console.log(`  clusters:       ${report.duplicateClusterCount}`);
  console.log(`  events in dups: ${report.duplicateEventCount}`);
  console.log(`  largest size:   ${report.largestDuplicateClusterSize}`);
  if (report.duplicateClusterCount > 0) {
    console.log('  size histogram:');
    const sizes = Object.keys(report.duplicateClusterSizeHistogram)
      .map((s) => parseInt(s, 10))
      .sort((a, b) => a - b);
    for (const size of sizes) {
      console.log(`    size ${size}: ${report.duplicateClusterSizeHistogram[String(size)]}`);
    }
  }
}

// ----------------------------------------------------------------------------
// CLI shell (I/O lives here; only runs when invoked directly, not on import).
// ----------------------------------------------------------------------------

interface CliArgs {
  help: boolean;
  outputPath: string;
  snapshotPath: string | null;
  fresh: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  let help = false;
  let outputPath = 'gdelt-corpus-audit.json';
  let snapshotPath: string | null = null;
  let fresh = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help' || args[i] === '-h') {
      help = true;
    } else if (args[i] === '-o' || args[i] === '--output') {
      outputPath = args[i + 1] ?? outputPath;
      i++;
    } else if (args[i] === '--snapshot') {
      snapshotPath = args[i + 1] ?? null;
      i++;
    } else if (args[i] === '--fresh') {
      fresh = true;
    }
  }

  return { help, outputPath, snapshotPath, fresh };
}

const HELP_TEXT = `
audit-gdelt-corpus — GDELT-MATCH-01 corpus-quality audit (READ-ONLY, non-destructive)

Categorizes the events:llm:v3 corpus into source-tier buckets, detects orphan
events (no matching news:feed DOC cluster), and sizes duplicate-source clusters.
The structured report sizes the Plan 06 dedup / corroboration / composite thresholds.

Usage:
  tsx scripts/audit-gdelt-corpus.ts [options]

Options:
  -o, --output <path>   Write the JSON report here (default gdelt-corpus-audit.json)
  --snapshot <path>     Read events + clusters from a captured JSON snapshot
                        ({ events: [...], clusters: [...] }) instead of live Redis
  --fresh               (reserved) force a live read even if a snapshot exists
  -h, --help            Show this help

The audit NEVER writes to Redis (D-07).
`;

interface Snapshot {
  events: ConflictEventEntity[];
  clusters: NewsCluster[];
}

/** Read the live corpus from Redis, degrading to empty arrays on unavailability. */
async function loadFromRedis(): Promise<Snapshot> {
  try {
    const { cacheGetSafe } = await import('../server/cache/redis.js');
    const eventsRes = await cacheGetSafe<ConflictEventEntity[]>('events:llm:v3', 0);
    const newsRes = await cacheGetSafe<NewsCluster[]>('news:feed', 0);
    return {
      events: eventsRes?.data ?? [],
      clusters: newsRes?.data ?? [],
    };
  } catch (err) {
    console.error(
      'Live Redis unavailable — degrading to empty corpus. Pass --snapshot <file> to audit a capture.',
      err instanceof Error ? err.message : err,
    );
    return { events: [], clusters: [] };
  }
}

/** Read a captured snapshot file ({ events, clusters }). */
function loadFromSnapshot(snapshotPath: string): Snapshot {
  const raw = JSON.parse(fs.readFileSync(snapshotPath, 'utf8')) as Partial<Snapshot>;
  return {
    events: raw.events ?? [],
    clusters: raw.clusters ?? [],
  };
}

async function main(): Promise<void> {
  const { help, outputPath, snapshotPath } = parseArgs(process.argv);

  if (help) {
    console.log(HELP_TEXT);
    process.exit(0);
  }

  const { events, clusters } = snapshotPath
    ? loadFromSnapshot(snapshotPath)
    : await loadFromRedis();

  if (events.length === 0) {
    console.error(
      'No events in corpus (live Redis empty/unavailable or empty snapshot). Report will reflect an empty corpus.',
    );
  }

  const report = buildAuditReport(events, clusters);

  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
  console.error(`Report written to ${path.resolve(outputPath)}`);

  printSummary(report);
  process.exit(0);
}

// Only run the CLI when executed directly (so test imports never trigger Redis I/O).
const isDirectRun =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  main().catch((err) => {
    console.error('Audit failed:', err);
    process.exit(1);
  });
}
