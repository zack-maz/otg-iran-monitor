// @vitest-environment node
/**
 * Phase 33 Plan 33-05 Task 1 (RED) — fixture-shape contract for
 * `server/data/eval/ground-truth-events.json` after the D-14 backfill.
 *
 * Pattern: real on-disk JSON read, mirroring
 * `server/__tests__/lib/llmEvalHarness.adversarial.test.ts:77-90` (the
 * existing fixture-shape verification idiom — readFileSync + JSON.parse +
 * structural assertions).
 *
 * Asserted invariants:
 *   1. At least 30 of the 50 ground-truth events carry a non-null
 *      `expectedActor1: string` (D-14 backfill target).
 *   2. When the additive-optional `expectedActor{1,2}` fields are present,
 *      they are either a string OR explicit null (NOT undefined-but-typed
 *      as something else). Schema is additive — events with the field
 *      absent entirely still pass.
 *
 * The fixture itself is intentionally NOT mocked here; this is a wire-
 * level contract test that runs against the committed file.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, it, expect } from 'vitest';

describe('ground-truth-events.json D-14 expectedActor backfill', () => {
  const fixturePath = resolve(__dirname, '../../data/eval/ground-truth-events.json');
  const raw = readFileSync(fixturePath, 'utf-8');
  const file = JSON.parse(raw) as {
    version: number;
    events: Array<{
      id: string;
      expectedActor1?: string | null;
      expectedActor2?: string | null;
    }>;
  };

  it('has ≥30 of 50 events with non-null expectedActor1 (D-14 target)', () => {
    const backfilled = file.events.filter((e) => typeof e.expectedActor1 === 'string').length;
    expect(backfilled).toBeGreaterThanOrEqual(30);
  });

  it('expectedActor1/2 are string|null|undefined (additive-optional)', () => {
    for (const e of file.events) {
      if ('expectedActor1' in e) {
        expect(typeof e.expectedActor1 === 'string' || e.expectedActor1 === null).toBe(true);
      }
      if ('expectedActor2' in e) {
        expect(typeof e.expectedActor2 === 'string' || e.expectedActor2 === null).toBe(true);
      }
    }
  });
});
