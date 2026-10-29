// Vertical profile and time/fuel predictions along the flight plan.
import { LatLon, destination, bearing, distance, norm360 } from '../util/geo';
import { casToMach, machToTas, casToTas, crossoverAlt } from '../util/atmos';
import type { FlightPlan } from './flightplan';
import type { FPLeg, PathSeg } from './types';
import { climbRate, climbFuelFlow, cruiseFuelFlow, descentFuelFlow, approachFuelFlow } from './perf';
import { segLength } from './geometry';

export interface Wind {
  dir: number;
  spd: number;
}

export interface PerfParams {
  crzAlt: number;
  isaDev: number;
  clbIas: number;
  clbMach: number;
  clbLimIas: number;
  clbLimAlt: number;
  crzMach: number;
  desMach: number;
  desIas: number;
  desLimIas: number;
  desLimAlt: number;
  vpa: number;
  winds: { clb: Wind; crz: Wind; des: Wind };
  gw: number;
  fuel: number;
  vapp: number;
}

export interface ProfilePoint {
  s: number;
  alt: number;
}

export interface PseudoWpt {
  kind: 'TOC' | 'TOD' | 'SC';
  dist: number;
  pos: LatLon;
  ete: number;
  legIdx: number;
}

export interface Predictions {
  valid: boolean;
  toc?: PseudoWpt;
  tod?: PseudoWpt;
  /** Descent path: altitude as a function of along-track distance from the aircraft. */
  path: ProfilePoint[];
  /** Index of the last leg included (runway / destination). */
  lastIdx: number;
  destDist: number;
  destEte: number;
  destFuel: number;
  totalFuelBurn: number;
  unable: boolean;
  /** Along-track position of each leg end (from aircraft). */
  legEnd: Map<number, number>;
}

const FT_PER_NM = 6076.12;

/** Point located `back` NM before the end of a leg, following its geometry backward. */
export function pointBeforeLegEnd(leg: FPLeg, back: number): LatLon | null {
  const g = leg.geo;
  if (!g) return null;
  let remain = back;
  for (let k = g.segs.length - 1; k >= 0; k--) {
    const s = g.segs[k];
    const len = segLength(s);
    if (remain <= len) return pointOnSeg(s, len - remain);
    remain -= len;
  }
  return g.segs.length ? g.segs[0].a : g.end;
}

export function pointOnSeg(s: PathSeg, d: number): LatLon {
  if (s.type === 'line') {
    const len = distance(s.a, s.b);
    if (len < 1e-6) return s.a;
    return destination(s.a, bearing(s.a, s.b), Math.min(d, len));
  }
  const ang = (d / s.r) * (180 / Math.PI) * Math.sign(s.sweep);
  return destination(s.c, norm360(s.start + ang), s.r);
}

function windComponent(w: Wind, trk: number): number {
  // positive = tailwind
  return -w.spd * Math.cos(((w.dir - trk) * Math.PI) / 180);
}

function cstrCap(l: FPLeg): number | null {
  if (!l.alt) return null;
  if (l.alt.t === 'BL' || l.alt.t === 'AT') return l.alt.a1;
  if (l.alt.t === 'WIN') return l.alt.a1;
  return null;
}
function cstrFloor(l: FPLeg): number | null {
  if (!l.alt) return null;
  if (l.alt.t === 'AB' || l.alt.t === 'AT') return l.alt.a1;
  if (l.alt.t === 'WIN') return l.alt.a2 ?? null;
  return null;
}

export interface PredInput {
  plan: FlightPlan;
  perf: PerfParams;
  acAlt: number;
  airborne: boolean;
  activeDtg: number | null;
  now: number; // seconds of day UTC
  originElev: number;
  destElev: number;
}

export function computePredictions(inp: PredInput): Predictions {
  const { plan, perf } = inp;
  const legs = plan.legs;
  const res: Predictions = { valid: false, path: [], lastIdx: -1, destDist: 0, destEte: 0, destFuel: perf.fuel, totalFuelBurn: 0, unable: false, legEnd: new Map() };
  if (legs.length < 2) return res;

  // ---- Along-track positions of leg ends
  const start = inp.airborne ? Math.max(1, plan.activeIdx) : 1;
  let last = legs.length - 1;
  for (let i = start; i < legs.length; i++) {
    if (legs[i].seg === 'MAP' && !plan.missedActive) { last = i - 1; break; }
  }
  while (last > start && legs[last].pt === 'DISCO') last--;
  res.lastIdx = last;
  const sEnd: number[] = new Array(legs.length).fill(NaN);
  let s = 0;
  for (let i = start; i <= last; i++) {
    const l = legs[i];
    let len = (l.geo?.length ?? 0) + (l.geo?.discoGap ?? 0);
    if (i === plan.activeIdx && inp.airborne && inp.activeDtg != null) len = inp.activeDtg;
    s += len;
    sEnd[i] = s;
    res.legEnd.set(i, s);
  }
  const S = s;
  res.destDist = S;
  if (S <= 0.01) return res;

  // ---- Descent path (backward from the end)
  const lastLeg = legs[last];
  let hEnd = inp.destElev + 1000;
  if (lastLeg?.fix?.rwy) hEnd = lastLeg.fix.rwy.elev + (lastLeg.fix.rwy.tch || 50);
  else if (lastLeg?.alt) hEnd = lastLeg.alt.a1;
  const crz = perf.crzAlt > 0 ? perf.crzAlt : 0;
  const tanG = (deg: number) => Math.tan((Math.abs(deg) * Math.PI) / 180);
  const lastClimbIdx = plan.lastOf('SID');
  const firstDescentIdx = (() => {
    // Descent constraints: STAR and approach segments, or any constraint in the last 40% of the route
    for (let i = start; i <= last; i++) {
      const l = legs[i];
      if (l.seg === 'STAR' || l.seg === 'APP') return i;
      if (l.seg === 'ENR' && l.alt && sEnd[i] > S * 0.6 && i > lastClimbIdx) return i;
    }
    return last;
  })();
  const H: number[] = new Array(legs.length).fill(NaN);
  H[last] = hEnd;
  let tod: { s: number } | null = null;
  const path: ProfilePoint[] = [{ s: S, alt: hEnd }];
  for (let i = last; i > start - 1; i--) {
    const l = legs[i];
    const len = sEnd[i] - (i > start ? sEnd[i - 1] : 0);
    const ang = l.vpa && (l.seg === 'APP') ? l.vpa : perf.vpa;
    let hPrev = H[i] + tanG(ang) * len * FT_PER_NM;
    const prev = legs[i - 1];
    if (prev && i - 1 >= firstDescentIdx && i - 1 >= start) {
      const cap = cstrCap(prev);
      const floor = cstrFloor(prev);
      if (cap != null && hPrev > cap) hPrev = cap;
      if (floor != null && hPrev < floor) {
        const grad = (floor - H[i]) / Math.max(0.1, len * FT_PER_NM);
        if (Math.atan(grad) * 180 / Math.PI > Math.abs(perf.vpa) + 1.5) res.unable = true;
        hPrev = floor;
      }
    }
    if (crz && hPrev >= crz && !tod) {
      // TOD lies within this leg
      const climb = crz - H[i];
      const slope = (hPrev - H[i]) / Math.max(1e-6, len);
      const back = slope > 0 ? climb / slope : len;
      tod = { s: sEnd[i] - back };
      path.unshift({ s: tod.s, alt: crz });
      hPrev = crz;
      H[i - 1] = crz;
      break;
    }
    const sPrev = i > start ? sEnd[i - 1] : 0;
    H[i - 1] = hPrev;
    path.unshift({ s: sPrev, alt: hPrev });
  }
  if (!tod && path.length && path[0].s > 0) path.unshift({ s: 0, alt: path[0].alt });
  res.path = path;
  const descentAlt = (x: number): number => {
    if (tod && x <= tod.s) return crz;
    for (let k = 1; k < path.length; k++) {
      if (x <= path[k].s) {
        const a = path[k - 1], b = path[k];
        const f = (x - a.s) / Math.max(1e-6, b.s - a.s);
        return a.alt + (b.alt - a.alt) * f;
      }
    }
    return path[path.length - 1].alt;
  };

  // ---- Forward integration (climb, cruise, descent)
  const isa = perf.isaDev;
  const xover = crossoverAlt(perf.clbIas, perf.clbMach);
  const xoverDes = crossoverAlt(perf.desIas, perf.desMach);
  let h = inp.airborne ? inp.acAlt : inp.originElev;
  let t = 0;
  let fuel = perf.fuel;
  let gw = perf.gw;
  let toc: { s: number; t: number } | null = null;
  let todT = 0;
  // Climb caps from constraints ahead
  const capAt = (x: number): number => {
    let cap = crz || 41000;
    for (let i = start; i <= last; i++) {
      if (sEnd[i] < x - 0.01) continue;
      if (i >= firstDescentIdx) break;
      const c = cstrCap(legs[i]);
      if (c != null && c < cap && c >= h - 50) { cap = c; break; }
    }
    return cap;
  };

  let legI = start;
  let x = 0;
  const step = 2;
  let reachedCrz = h >= crz - 50;
  let phaseDesc = false;
  let desSpdCap = 999;
  let capLeg = -1;
  while (x < S - 1e-6) {
    while (legI < last && sEnd[legI] <= x + 1e-6) legI++;
    const l = legs[legI];
    const segEnd = Math.min(sEnd[legI], x + step);
    const ds = Math.max(1e-4, segEnd - x);
    const mid = x + ds / 2;
    const trk = l.geo ? l.geo.crsIn : 0;
    const hDes = descentAlt(mid);
    let phase: 'CLB' | 'CRZ' | 'DES';
    if (tod && mid >= tod.s) phase = 'DES';
    else if (!tod && hDes < h - 100 && h > hEnd + 100) phase = 'DES';
    else if (!reachedCrz && h < crz - 50) phase = 'CLB';
    else phase = 'CRZ';
    if (phase === 'DES' && !phaseDesc) { phaseDesc = true; todT = t; }
    let ias: number, mach: number, tas: number, ff: number, gs: number;
    const inApp = l.seg === 'APP' || l.seg === 'MAP';
    if (phase === 'CLB') {
      ias = h < perf.clbLimAlt ? perf.clbLimIas : perf.clbIas;
      if (l.spd && l.spd.t !== 'AB') ias = Math.min(ias, l.spd.kt);
      mach = h > xover ? perf.clbMach : casToMach(ias, h);
      tas = machToTas(mach, h, isa);
      ff = climbFuelFlow(h, gw);
      gs = Math.max(80, tas + windComponent(perf.winds.clb, trk));
      const roc = climbRate(h, gw, isa);
      const cap = Math.min(capAt(mid), crz || 41000, hDes);
      const dh = Math.min(roc * (ds / gs) * 60, Math.max(0, cap - h));
      h += dh;
      if (h >= crz - 50 && !reachedCrz) {
        reachedCrz = true;
        toc = { s: segEnd, t: t + (ds / gs) * 3600 };
      }
    } else if (phase === 'CRZ') {
      if (h < xover) { ias = perf.clbIas; mach = casToMach(ias, h); }
      else { mach = perf.crzMach; ias = machToCasSafe(mach, h); }
      tas = machToTas(mach, h, isa);
      ff = cruiseFuelFlow(h, mach, gw, isa);
      gs = Math.max(80, tas + windComponent(perf.winds.crz, trk));
    } else {
      if (inApp) ias = l.faf || legBeyondFaf(plan, legI) ? perf.vapp + 10 : 180;
      else if (h < perf.desLimAlt + 1000) ias = perf.desLimIas;
      else ias = perf.desIas;
      // Speed constraints in descent hold until the destination once crossed
      if (l.spd && l.spd.t !== 'AB') ias = Math.min(ias, l.spd.kt);
      ias = Math.min(ias, desSpdCap);
      mach = casToMach(ias, h);
      if (h > xoverDes && !inApp && desSpdCap > 400) { mach = perf.desMach; ias = machToCasSafe(mach, h); }
      tas = machToTas(mach, h, isa);
      ff = inApp ? approachFuelFlow() : descentFuelFlow(h);
      gs = Math.max(80, tas + windComponent(perf.winds.des, trk));
      h = Math.min(h, descentAlt(segEnd));
    }
    const dt = (ds / gs) * 3600;
    t += dt;
    fuel -= (ff * dt) / 3600;
    gw -= (ff * dt) / 3600;
    x = segEnd;
    if (Math.abs(sEnd[legI] - x) < 1e-6) {
      l.pred = { dist: sEnd[legI], ete: t, alt: Math.round(h), spd: Math.round(ias), mach, fuel: Math.max(0, fuel) };
      if (phase === 'DES' && l.spd && l.spd.t !== 'AB' && capLeg !== legI) { desSpdCap = Math.min(desSpdCap, l.spd.kt); capLeg = legI; }
    }
  }
  // Fill legs that had zero length
  for (let i = start; i <= last; i++) {
    if (!legs[i].pred && i > start) legs[i].pred = legs[i - 1].pred ? { ...legs[i - 1].pred! } : undefined;
  }
  for (let i = last + 1; i < legs.length; i++) legs[i].pred = undefined;
  for (let i = 0; i < start; i++) legs[i].pred = undefined;

  res.destEte = t;
  res.destFuel = fuel;
  res.totalFuelBurn = perf.fuel - fuel;
  if (toc) {
    const p = locate(plan, sEnd, start, last, toc.s);
    if (p) res.toc = { kind: 'TOC', dist: toc.s, pos: p.pos, ete: toc.t, legIdx: p.leg };
  }
  if (tod) {
    const p = locate(plan, sEnd, start, last, tod.s);
    if (p) res.tod = { kind: 'TOD', dist: tod.s, pos: p.pos, ete: todT, legIdx: p.leg };
  }
  res.valid = true;
  return res;
}

function machToCasSafe(m: number, h: number): number {
  // machToCas is imported lazily to avoid a cycle
  const qcp = Math.pow(1 + 0.2 * m * m, 3.5) - 1;
  const d = h < 36089 ? Math.pow(1 - 6.8755856e-6 * h, 5.2558797) : 0.2233609 * Math.exp(-4.806346e-5 * (h - 36089));
  return 661.4786 * Math.sqrt(5 * (Math.pow(qcp * d + 1, 2 / 7) - 1));
}

function legBeyondFaf(plan: FlightPlan, idx: number): boolean {
  for (let i = idx - 1; i >= 0; i--) {
    const l = plan.legs[i];
    if (l.seg !== 'APP') return false;
    if (l.faf) return true;
  }
  return false;
}

function locate(plan: FlightPlan, sEnd: number[], start: number, last: number, sx: number): { pos: LatLon; leg: number } | null {
  for (let i = start; i <= last; i++) {
    if (sEnd[i] >= sx - 1e-6) {
      const p = pointBeforeLegEnd(plan.legs[i], sEnd[i] - sx);
      return p ? { pos: p, leg: i } : null;
    }
  }
  return null;
}

export { casToTas };
