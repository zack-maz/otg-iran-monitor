// @vitest-environment node
import { describe, it, expect } from 'vitest';

import type { ConflictEventEntity, NewsArticle, NewsCluster } from '../../types.js';

/**
 * GDELT-MATCH-03 — generalized three-gate OSINT corroboration.
 *
 * Generalizes the Phase-22 Bellingcat three-gate (temporal AND geographic AND
 * keyword) from Bellingcat-specific to ANY tier-1/2 OSINT source in
 * `news:feed`. A boost is granted ONLY on a genuine 3-gate match; coincidental
 * same-city-same-day matches (only 1-2 gates pass) are withheld.
 *
 * The keyword gate is STRICT: an actor or specific-action token must match,
 * NOT a generic "Iran"/"strike" — this prevents same-city-same-day false
 * positives from inflating the score.
 */

function makeEvent(overrides: Partial<ConflictEventEntity> = {}): ConflictEventEntity {
  return {
    id: overrides.id ?? 'evt-1',
    type: overrides.type ?? 'airstrike',
    lat: overrides.lat ?? 33.3,
    lng: overrides.lng ?? 44.4,
    timestamp: overrides.timestamp ?? Date.UTC(2026, 4, 1, 6, 0, 0),
    label: overrides.label ?? 'US airstrike on IRGC compound in Baghdad',
    data: {
      eventType: 'Aerial weapons',
      subEventType: 'CAMEO 195',
      fatalities: 3,
      actor1: 'UNITED STATES',
      actor2: 'IRAN',
      notes: 'US airstrike on IRGC compound in Baghdad',
      source: 'https://gdelt.example/a',
      goldsteinScale: -10,
      locationName: 'Baghdad, Iraq',
      cameoCode: '195',
      actors: ['UNITED STATES', 'IRGC'],
      ...overrides.data,
    },
  };
}

function makeArticle(overrides: Partial<NewsArticle> = {}): NewsArticle {
  return {
    id: overrides.id ?? 'art-1',
    title: overrides.title ?? 'IRGC compound struck by US forces near Baghdad',
    url: overrides.url ?? 'https://reuters.com/world/strike',
    source: overrides.source ?? 'Reuters',
    domain: overrides.domain ?? 'reuters.com',
    publishedAt: overrides.publishedAt ?? Date.UTC(2026, 4, 1, 8, 0, 0),
    lat: overrides.lat ?? 33.31,
    lng: overrides.lng ?? 44.41,
    keywords: overrides.keywords ?? [],
    ...overrides,
  };
}

function makeCluster(articles: NewsArticle[]): NewsCluster {
  const primary = articles[0]!;
  return {
    id: primary.id,
    primaryArticle: primary,
    articles,
    firstSeen: Math.min(...articles.map((a) => a.publishedAt)),
    lastUpdated: Math.max(...articles.map((a) => a.publishedAt)),
  };
}

describe('checkCorroboration (GDELT-MATCH-03)', () => {
  it('boosts on a genuine 3-gate match (temporal + geo + strict keyword/actor)', async () => {
    const { checkCorroboration } = await import('../../lib/corroboration.js');

    const event = makeEvent();
    const clusters = [makeCluster([makeArticle()])];

    const result = checkCorroboration(event, clusters);
    expect(result.corroborated).toBe(true);
    expect(result.boost).toBeGreaterThan(0);
  });

  it('withholds boost when only 2 gates pass (same city/day but different actor)', async () => {
    const { checkCorroboration } = await import('../../lib/corroboration.js');

    const event = makeEvent();
    // Temporal + geo pass, but the article is about a DIFFERENT actor/action —
    // no actor or specific-action token overlap (generic "Baghdad" alone must
    // NOT corroborate).
    const clusters = [
      makeCluster([
        makeArticle({
          title: 'Flooding displaces thousands across Baghdad province',
          publishedAt: Date.UTC(2026, 4, 1, 9, 0, 0),
          lat: 33.31,
          lng: 44.41,
        }),
      ]),
    ];

    const result = checkCorroboration(event, clusters);
    expect(result.corroborated).toBe(false);
    expect(result.boost).toBe(0);
  });

  it('withholds boost when temporal gate fails (matching content, wrong day)', async () => {
    const { checkCorroboration } = await import('../../lib/corroboration.js');

    const event = makeEvent();
    const clusters = [
      makeCluster([
        makeArticle({
          // 5 days later — outside the temporal window.
          publishedAt: Date.UTC(2026, 4, 6, 8, 0, 0),
        }),
      ]),
    ];

    const result = checkCorroboration(event, clusters);
    expect(result.corroborated).toBe(false);
  });

  it('withholds boost when geographic gate fails (matching content, far away)', async () => {
    const { checkCorroboration } = await import('../../lib/corroboration.js');

    const event = makeEvent();
    const clusters = [
      makeCluster([
        makeArticle({
          // Far from Baghdad (Tehran ~35.7, 51.4) — geo gate fails.
          lat: 35.7,
          lng: 51.4,
        }),
      ]),
    ];

    const result = checkCorroboration(event, clusters);
    expect(result.corroborated).toBe(false);
  });

  it('weights a tier-1 corroborating source higher than a tier-3 one', async () => {
    const { checkCorroboration } = await import('../../lib/corroboration.js');

    const event = makeEvent();
    const tier1 = checkCorroboration(event, [
      makeCluster([makeArticle({ domain: 'reuters.com' })]),
    ]);
    const tier3 = checkCorroboration(event, [
      makeCluster([makeArticle({ domain: 'tehrantimes.com', source: 'Tehran Times' })]),
    ]);

    expect(tier1.corroborated).toBe(true);
    expect(tier3.corroborated).toBe(true);
    expect(tier1.boost).toBeGreaterThan(tier3.boost);
  });

  it('the keyword gate is strict — generic "Iran"/"strike" alone does NOT corroborate', async () => {
    const { checkCorroboration } = await import('../../lib/corroboration.js');

    const event = makeEvent();
    const clusters = [
      makeCluster([
        makeArticle({
          // Only generic tokens overlap (Iran, strike) — no actor (IRGC, US) or
          // specific landmark match. Strict gate withholds.
          title: 'Iran reacts to strike threats in regional standoff',
          lat: 33.31,
          lng: 44.41,
          publishedAt: Date.UTC(2026, 4, 1, 9, 0, 0),
        }),
      ]),
    ];

    const result = checkCorroboration(event, clusters);
    expect(result.corroborated).toBe(false);
  });
});
