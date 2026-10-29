// Magnetic variation (WMM2025) with a small cache. East variation is positive.
import { magvar as wmm } from 'magvar';
import { norm360 } from './geo';

const cache = new Map<string, number>();
const now = new Date();
const decYear = now.getUTCFullYear() + (now.getUTCMonth() * 30.4 + now.getUTCDate()) / 365.25;

export function magVar(lat: number, lon: number): number {
  const key = `${Math.round(lat * 4)}:${Math.round(lon * 4)}`;
  let v = cache.get(key);
  if (v === undefined) {
    try {
      v = wmm(lat, lon, 0, Math.min(Math.max(decYear, 2025.01), 2029.99));
    } catch {
      v = 0;
    }
    cache.set(key, v as number);
  }
  return v as number;
}

export const trueToMag = (trueDeg: number, lat: number, lon: number): number => norm360(trueDeg - magVar(lat, lon));
export const magToTrue = (magDeg: number, lat: number, lon: number): number => norm360(magDeg + magVar(lat, lon));
