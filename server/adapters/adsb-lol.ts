import { IRAN_CENTER, ADSB_RADIUS_NM, OUTBOUND_USER_AGENT } from '../config.js';
import { logger } from '../lib/logger.js';
import { RateLimitError } from '../types.js';

import { normalizeAircraft } from './adsb-v2-normalize.js';

import type { FlightEntity } from '../types.js';
import type { AdsbResponse } from './adsb-v2-normalize.js';

const log = logger.child({ module: 'adsb-lol' });

const BASE_URL = 'https://api.adsb.lol';
const FETCH_TIMEOUT = 10_000;

export async function fetchFlights(): Promise<FlightEntity[]> {
  const start = Date.now();

  const url = `${BASE_URL}/v2/lat/${IRAN_CENTER.lat}/lon/${IRAN_CENTER.lon}/dist/${ADSB_RADIUS_NM}`;

  const res = await fetch(url, {
    headers: { 'User-Agent': OUTBOUND_USER_AGENT },
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });

  if (res.status === 429) {
    throw new RateLimitError('adsb.lol rate limit exceeded');
  }

  if (!res.ok) {
    throw new Error(`adsb.lol API error: ${res.status}`);
  }

  const data = (await res.json()) as AdsbResponse;
  const aircraft = data.ac ?? [];

  const flights = aircraft.map(normalizeAircraft).filter((f): f is FlightEntity => f !== null);

  log.info({ count: flights.length, durationMs: Date.now() - start }, 'fetched flights');
  return flights;
}
