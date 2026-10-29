// CDU formatting and entry parsing.
import type { AltCstr, SpdCstr } from '../fms/types';

export function fmtAlt(alt: number, transAlt = 18000): string {
  const a = Math.round(alt);
  if (a >= transAlt) return 'FL' + String(Math.round(a / 100)).padStart(3, '0');
  return String(Math.round(a / 10) * 10);
}

export function fmtCstrAlt(c: AltCstr, transAlt = 18000): string {
  const f = (x: number) => (x >= transAlt ? fmtAlt(x, transAlt) : String(Math.round(x)));
  switch (c.t) {
    case 'AT': return f(c.a1);
    case 'AB': return f(c.a1) + 'A';
    case 'BL': return f(c.a1) + 'B';
    case 'WIN': {
      const s = `${f(c.a2!)}A${f(c.a1)}B`;
      return s.length > 12 ? `${Math.round(c.a2! / 100)}A${Math.round(c.a1 / 100)}B` : s;
    }
  }
}

export function fmtCstrSpd(c: SpdCstr): string {
  return String(c.kt) + (c.t === 'AB' ? 'A' : c.t === 'BL' ? '' : '');
}

export const fmtMach = (m: number): string => '.' + String(Math.round(m * 100)).padStart(2, '0');

export function fmtSpdMach(ias: number, mach?: number): string {
  return mach ? `${Math.round(ias)}/${fmtMach(mach)}` : String(Math.round(ias));
}

export function fmtCrs(deg: number): string {
  let d = Math.round(deg) % 360;
  if (d <= 0) d += 360;
  return String(d).padStart(3, '0') + '°';
}

export function fmtDist(nm: number): string {
  if (!Number.isFinite(nm)) return '----';
  if (nm < 99.95) return nm.toFixed(1);
  return String(Math.round(nm));
}

/** H:MM from seconds. */
export function fmtEte(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '-:--';
  const m = Math.round(sec / 60);
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
}

/** HHMM (UTC, seconds of day). */
export function fmtZulu(sec: number): string {
  const s = ((sec % 86400) + 86400) % 86400;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${String(h).padStart(2, '0')}${String(m).padStart(2, '0')}`;
}

export const fmtFuelK = (lb: number): string => (Math.max(0, lb) / 1000).toFixed(1);

export function fmtWind(w: { dir: number; spd: number } | null): string {
  if (!w) return '---°/---';
  return `${String(Math.round(w.dir) % 360 || 360).padStart(3, '0')}°/${String(Math.round(w.spd)).padStart(3, ' ')}`;
}

export function fmtTemp(c: number): string {
  const r = Math.round(c);
  return `${r >= 0 ? '+' : ''}${r}°C`;
}

export function fmtDate(d: Date): string {
  const mon = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'][d.getUTCMonth()];
  return `${String(d.getUTCDate()).padStart(2, '0')}${mon}${String(d.getUTCFullYear()).slice(2)}`;
}

export function fmtIsoDate(iso: string): string {
  const [y, m, d] = iso.split('-').map((x) => parseInt(x, 10));
  return fmtDate(new Date(Date.UTC(y, m - 1, d)));
}

// ---------------------------------------------------------------------------
// Parsing

/** Altitude: 350 / FL350 -> 35000; 5000 -> 5000; 1-3 digits are hundreds of feet. */
export function parseAlt(s: string): number | null {
  const t = s.trim().toUpperCase();
  let m = /^FL(\d{1,3})$/.exec(t);
  if (m) return parseInt(m[1], 10) * 100;
  m = /^(\d{1,5})$/.exec(t);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const v = m[1].length <= 3 ? n * 100 : n;
  return v >= -1000 && v <= 45000 ? v : null;
}

/** Constraint entries: 10000, 10000A, FL230B, 190A230B, 9000A11000B. */
export function parseAltCstr(s: string): AltCstr | null {
  const t = s.trim().toUpperCase();
  let m = /^(FL)?(\d{1,5})A(FL)?(\d{1,5})B$/.exec(t);
  if (m) {
    const lo = parseAlt((m[1] ?? '') + m[2]);
    const hi = parseAlt((m[3] ?? '') + m[4]);
    if (lo == null || hi == null || lo >= hi) return null;
    return { t: 'WIN', a1: hi, a2: lo };
  }
  m = /^((?:FL)?\d{1,5})([AB])?$/.exec(t);
  if (!m) return null;
  const a = parseAlt(m[1]);
  if (a == null) return null;
  return { t: m[2] === 'A' ? 'AB' : m[2] === 'B' ? 'BL' : 'AT', a1: a };
}

/** Speed entries 250, .74, M.74, 0.74 */
export function parseSpeed(s: string): { ias?: number; mach?: number } | null {
  const t = s.trim().toUpperCase().replace(/^M/, '');
  if (/^0?\.\d{1,3}$/.test(t)) {
    const m = parseFloat(t);
    return m >= 0.3 && m <= 0.9 ? { mach: m } : null;
  }
  if (/^\d{2,3}$/.test(t)) {
    const v = parseInt(t, 10);
    return v >= 100 && v <= 350 ? { ias: v } : null;
  }
  return null;
}

/** "SPD/ALT" field: 250/10000A, 250/, /FL230, 250 */
export function parseSpdAlt(s: string): { spd?: SpdCstr | null; alt?: AltCstr | null } | null {
  const t = s.trim().toUpperCase();
  const [a, b] = t.includes('/') ? t.split('/') : [t, undefined];
  const out: { spd?: SpdCstr | null; alt?: AltCstr | null } = {};
  if (b === undefined) {
    // A value without a slash is an altitude (speeds must be entered as 250/)
    const c = parseAltCstr(a);
    if (!c) return null;
    out.alt = c;
    return out;
  }
  if (a) {
    const v = /^(\d{3})([AB])?$/.exec(a);
    if (!v) return null;
    const kt = parseInt(v[1], 10);
    if (kt < 100 || kt > 350) return null;
    out.spd = { t: v[2] === 'A' ? 'AB' : 'BL', kt };
  }
  if (b) {
    const c = parseAltCstr(b);
    if (!c) return null;
    out.alt = c;
  }
  return out;
}

/** Wind "270/45" (direction true/magnetic as entered). */
export function parseWind(s: string): { dir: number; spd: number } | null {
  const m = /^(\d{1,3})\/(\d{1,3})$/.exec(s.trim());
  if (!m) return null;
  const dir = parseInt(m[1], 10), spd = parseInt(m[2], 10);
  if (dir > 360 || spd > 250) return null;
  return { dir: dir % 360, spd };
}

export function parseTemp(s: string): number | null {
  const t = s.trim().toUpperCase().replace(/^M/, '-').replace(/C$/, '');
  if (!/^[+-]?\d{1,2}$/.test(t)) return null;
  const v = parseInt(t, 10);
  return v >= -60 && v <= 55 ? v : null;
}

/** Weights in lb; values below 200 are thousands (e.g. 12.5 -> 12500). */
export function parseWeight(s: string, max = 100000): number | null {
  const t = s.trim();
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(t)) return null;
  let v = parseFloat(t);
  if (v < 200) v *= 1000;
  v = Math.round(v);
  return v >= 0 && v <= max ? v : null;
}

export function parseCourse(s: string): number | null {
  const t = s.trim().replace(/°$/, '');
  if (!/^\d{1,3}$/.test(t)) return null;
  const v = parseInt(t, 10);
  return v >= 0 && v <= 360 ? v % 360 || 360 : null;
}

export function parseFreq(s: string, min: number, max: number, decimals = 3): number | null {
  const t = s.trim();
  if (!/^\d{3}(\.\d{1,3})?$|^\d{2,3}\.\d{1,3}$|^\d{3,4}$/.test(t)) return null;
  let v = parseFloat(t);
  if (/^\d{4,5}$/.test(t) && v > max) v = v / 100;
  v = Math.round(v * 10 ** decimals) / 10 ** decimals;
  return v >= min && v <= max ? v : null;
}

/** HHMM -> seconds of day */
export function parseZulu(s: string): number | null {
  const m = /^(\d{2})(\d{2})Z?$/.exec(s.trim().toUpperCase());
  if (!m) return null;
  const h = parseInt(m[1], 10), mi = parseInt(m[2], 10);
  if (h > 23 || mi > 59) return null;
  return h * 3600 + mi * 60;
}

export const padL = (s: string, n: number): string => s.padStart(n, ' ');
export const padR = (s: string, n: number): string => s.padEnd(n, ' ');
