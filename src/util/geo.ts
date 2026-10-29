// Spherical-earth navigation math. Distances in nautical miles, angles in degrees.

export interface LatLon {
  lat: number;
  lon: number;
}

export const EARTH_NM = 3440.065;
export const D2R = Math.PI / 180;
export const R2D = 180 / Math.PI;

export const norm360 = (a: number): number => ((a % 360) + 360) % 360;
export const norm180 = (a: number): number => {
  let x = norm360(a);
  if (x > 180) x -= 360;
  return x;
};
/** Signed smallest difference b - a in (-180, 180]. */
export const angDiff = (a: number, b: number): number => norm180(b - a);
export const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export function distance(a: LatLon, b: LatLon): number {
  const p1 = a.lat * D2R;
  const p2 = b.lat * D2R;
  const dp = p2 - p1;
  const dl = (b.lon - a.lon) * D2R;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(h))) * EARTH_NM;
}

/** Initial true bearing from a to b. */
export function bearing(a: LatLon, b: LatLon): number {
  const p1 = a.lat * D2R;
  const p2 = b.lat * D2R;
  const dl = (b.lon - a.lon) * D2R;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return norm360(Math.atan2(y, x) * R2D);
}

/** Final true bearing arriving at b on the great circle from a. */
export function finalBearing(a: LatLon, b: LatLon): number {
  return norm360(bearing(b, a) + 180);
}

export function destination(p: LatLon, brgTrue: number, distNm: number): LatLon {
  const d = distNm / EARTH_NM;
  const b = brgTrue * D2R;
  const p1 = p.lat * D2R;
  const l1 = p.lon * D2R;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return { lat: p2 * R2D, lon: norm180(l2 * R2D) };
}

/** Signed cross-track distance of p from great circle a->b (positive = right of course). */
export function crossTrack(a: LatLon, b: LatLon, p: LatLon): number {
  const d13 = distance(a, p) / EARTH_NM;
  const t13 = bearing(a, p) * D2R;
  const t12 = bearing(a, b) * D2R;
  return Math.asin(Math.sin(d13) * Math.sin(t13 - t12)) * EARTH_NM;
}

/** Along-track distance from a toward b of the point abeam p. */
export function alongTrack(a: LatLon, b: LatLon, p: LatLon): number {
  const d13 = distance(a, p) / EARTH_NM;
  const xt = crossTrack(a, b, p) / EARTH_NM;
  const c = Math.cos(d13) / Math.cos(xt);
  const at = Math.acos(clamp(c, -1, 1)) * EARTH_NM;
  const t13 = bearing(a, p);
  const t12 = bearing(a, b);
  return Math.abs(angDiff(t12, t13)) > 90 ? -at : at;
}

/** Signed cross track from a line defined by a point and a true course. */
export function crossTrackCourse(a: LatLon, crsTrue: number, p: LatLon): number {
  const d13 = distance(a, p) / EARTH_NM;
  const t13 = bearing(a, p) * D2R;
  return Math.asin(Math.sin(d13) * Math.sin(t13 - crsTrue * D2R)) * EARTH_NM;
}

export function alongTrackCourse(a: LatLon, crsTrue: number, p: LatLon): number {
  const d = distance(a, p);
  if (d < 1e-6) return 0;
  const rel = angDiff(crsTrue, bearing(a, p)) * D2R;
  return d * Math.cos(rel);
}

/** Intersection of two great circles given by point + true bearing. Returns the nearer forward intersection. */
export function intersection(p1: LatLon, brng1: number, p2: LatLon, brng2: number): LatLon | null {
  const f1 = p1.lat * D2R, l1 = p1.lon * D2R;
  const f2 = p2.lat * D2R, l2 = p2.lon * D2R;
  const t13 = brng1 * D2R, t23 = brng2 * D2R;
  const df = f2 - f1, dl = l2 - l1;
  const d12 = 2 * Math.asin(Math.sqrt(Math.sin(df / 2) ** 2 + Math.cos(f1) * Math.cos(f2) * Math.sin(dl / 2) ** 2));
  if (Math.abs(d12) < 1e-12) return { lat: p1.lat, lon: p1.lon };
  const cosTa = (Math.sin(f2) - Math.sin(f1) * Math.cos(d12)) / (Math.sin(d12) * Math.cos(f1));
  const cosTb = (Math.sin(f1) - Math.sin(f2) * Math.cos(d12)) / (Math.sin(d12) * Math.cos(f2));
  const ta = Math.acos(clamp(cosTa, -1, 1));
  const tb = Math.acos(clamp(cosTb, -1, 1));
  const t12 = Math.sin(l2 - l1) > 0 ? ta : 2 * Math.PI - ta;
  const t21 = Math.sin(l2 - l1) > 0 ? 2 * Math.PI - tb : tb;
  const a1 = t13 - t12;
  const a2 = t21 - t23;
  if (Math.sin(a1) === 0 && Math.sin(a2) === 0) return null;
  if (Math.sin(a1) * Math.sin(a2) < 0) return null;
  const cosA3 = -Math.cos(a1) * Math.cos(a2) + Math.sin(a1) * Math.sin(a2) * Math.cos(d12);
  const d13 = Math.atan2(Math.sin(d12) * Math.sin(a1) * Math.sin(a2), Math.cos(a2) + Math.cos(a1) * cosA3);
  const f3 = Math.asin(clamp(Math.sin(f1) * Math.cos(d13) + Math.cos(f1) * Math.sin(d13) * Math.cos(t13), -1, 1));
  const dl13 = Math.atan2(Math.sin(t13) * Math.sin(d13) * Math.cos(f1), Math.cos(d13) - Math.sin(f1) * Math.sin(f3));
  return { lat: f3 * R2D, lon: norm180((l1 + dl13) * R2D) };
}

/** Intersection of a course line from p with a circle around c of radius r (NM). Returns first forward point. */
export function courseCircleIntersection(p: LatLon, crsTrue: number, c: LatLon, r: number): LatLon | null {
  // Solve in a local flat projection around p (fine for terminal-area distances).
  const o = toLocal(p, c);
  const ux = Math.sin(crsTrue * D2R), uy = Math.cos(crsTrue * D2R);
  // Points p + t*u, |p + t u - c|^2 = r^2 with p at origin
  const b = -2 * (ux * o.x + uy * o.y);
  const cc = o.x * o.x + o.y * o.y - r * r;
  const disc = b * b - 4 * cc;
  if (disc < 0) return null;
  const s = Math.sqrt(disc);
  const t1 = (-b - s) / 2, t2 = (-b + s) / 2;
  let t = t1 > 0.01 ? t1 : t2 > 0.01 ? t2 : NaN;
  if (Number.isNaN(t)) return null;
  return fromLocal(p, { x: ux * t, y: uy * t });
}

export interface XY {
  x: number;
  y: number;
}

/** Local tangent-plane projection (x east, y north, NM). */
export function toLocal(origin: LatLon, p: LatLon): XY {
  const d = distance(origin, p);
  const b = bearing(origin, p) * D2R;
  return { x: d * Math.sin(b), y: d * Math.cos(b) };
}

export function fromLocal(origin: LatLon, v: XY): LatLon {
  const d = Math.hypot(v.x, v.y);
  if (d < 1e-9) return { lat: origin.lat, lon: origin.lon };
  return destination(origin, norm360(Math.atan2(v.x, v.y) * R2D), d);
}

export function interpolate(a: LatLon, b: LatLon, f: number): LatLon {
  const d = distance(a, b);
  if (d < 1e-9) return { lat: a.lat, lon: a.lon };
  return destination(a, bearing(a, b), d * f);
}

// ---------------------------------------------------------------------------
// Formatting (Collins style)

const pad = (n: number, w: number) => String(n).padStart(w, '0');

/** N39°51.7 */
export function fmtLat(lat: number, decimals = 1): string {
  const h = lat >= 0 ? 'N' : 'S';
  const a = Math.abs(lat);
  let d = Math.floor(a);
  let m = (a - d) * 60;
  m = Math.round(m * 10 ** decimals) / 10 ** decimals;
  if (m >= 60) { d += 1; m -= 60; }
  const ms = m.toFixed(decimals).padStart(decimals ? 3 + decimals : 2, '0');
  return `${h}${pad(d, 2)}°${ms}`;
}

/** W104°40.4 */
export function fmtLon(lon: number, decimals = 1): string {
  const h = lon >= 0 ? 'E' : 'W';
  const a = Math.abs(lon);
  let d = Math.floor(a);
  let m = (a - d) * 60;
  m = Math.round(m * 10 ** decimals) / 10 ** decimals;
  if (m >= 60) { d += 1; m -= 60; }
  const ms = m.toFixed(decimals).padStart(decimals ? 3 + decimals : 2, '0');
  return `${h}${pad(d, 3)}°${ms}`;
}

export const fmtLatLon = (p: LatLon, decimals = 1): string => `${fmtLat(p.lat, decimals)} ${fmtLon(p.lon, decimals)}`;

/**
 * Parse Collins lat/lon entries such as N3951.7W10440.4, N39W104, N3951W10440,
 * N39515W104404 (tenths implied) and N39°51.7 W104°40.4.
 */
export function parseLatLon(s: string): LatLon | null {
  const t = s.replace(/[°\s]/g, '').toUpperCase();
  const m = /^([NS])(\d{2})(\d{2}(?:\.\d+)?|\d{3})?([EW])(\d{3})(\d{2}(?:\.\d+)?|\d{3})?$/.exec(t);
  if (!m) return null;
  const mins = (x: string | undefined) => {
    if (!x) return 0;
    if (/^\d{3}$/.test(x)) return parseInt(x.slice(0, 2), 10) + parseInt(x[2], 10) / 10;
    return parseFloat(x);
  };
  const lat = (parseInt(m[2], 10) + mins(m[3]) / 60) * (m[1] === 'S' ? -1 : 1);
  const lon = (parseInt(m[5], 10) + mins(m[6]) / 60) * (m[4] === 'W' ? -1 : 1);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const mlat = mins(m[3]), mlon = mins(m[6]);
  if (mlat >= 60 || mlon >= 60) return null;
  return { lat, lon };
}
