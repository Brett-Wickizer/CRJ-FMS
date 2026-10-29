// Converts flight plan legs (ARINC 424 path terminators) into path geometry.
import {
  LatLon, bearing, finalBearing, destination, distance, norm360, angDiff, intersection,
  crossTrackCourse, alongTrackCourse, courseCircleIntersection, toLocal, fromLocal, D2R,
} from '../util/geo';
import { magToTrue } from '../util/magvar';
import type { FlightPlan } from './flightplan';
import { legCourseTrue, isHold } from './flightplan';
import type { FPLeg, LegGeo, PathSeg } from './types';

export interface GeoContext {
  acPos?: LatLon;
  acTrack?: number;
  acAlt?: number;
  airborne: boolean;
  /** Expected climb gradient for altitude-terminated legs (ft per NM). */
  climbGrad: number;
  /** Groundspeed used for hold/turn radius (kt). */
  holdTas: number;
  originElev: number;
}

const lineSeg = (a: LatLon, b: LatLon): PathSeg => ({ type: 'line', a, b });

function lineGeo(a: LatLon, b: LatLon, endIsFix = true): LegGeo {
  const len = distance(a, b);
  const crs = len > 0.01 ? bearing(a, b) : 0;
  return { start: a, end: b, segs: len > 0.01 ? [lineSeg(a, b)] : [], length: len, crsIn: crs, crsOut: len > 0.01 ? finalBearing(a, b) : crs, endIsFix };
}

function polyGeo(pts: LatLon[], endIsFix = true): LegGeo {
  const segs: PathSeg[] = [];
  let len = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = distance(pts[i - 1], pts[i]);
    if (d < 0.01) continue;
    segs.push(lineSeg(pts[i - 1], pts[i]));
    len += d;
  }
  const first = segs[0] as any;
  const last = segs[segs.length - 1] as any;
  return {
    start: pts[0], end: pts[pts.length - 1], segs, length: len,
    crsIn: first ? bearing(first.a, first.b) : 0,
    crsOut: last ? finalBearing(last.a, last.b) : 0,
    endIsFix,
  };
}

export function arcSeg(c: LatLon, r: number, startBrg: number, endBrg: number, dir: 'L' | 'R'): PathSeg & { type: 'arc' } {
  let sweep = dir === 'R' ? norm360(endBrg - startBrg) : -norm360(startBrg - endBrg);
  if (Math.abs(sweep) < 0.01) sweep = 0;
  return { type: 'arc', c, r, start: startBrg, sweep, a: destination(c, startBrg, r), b: destination(c, endBrg, r) };
}

export const segLength = (s: PathSeg): number => (s.type === 'line' ? distance(s.a, s.b) : (Math.abs(s.sweep) * D2R) * s.r);

function arcGeo(c: LatLon, r: number, startBrg: number, endBrg: number, dir: 'L' | 'R', lead?: LatLon): LegGeo {
  const arc = arcSeg(c, r, startBrg, endBrg, dir);
  const segs: PathSeg[] = [];
  let len = 0;
  if (lead && distance(lead, arc.a) > 0.05) {
    segs.push(lineSeg(lead, arc.a));
    len += distance(lead, arc.a);
  }
  segs.push(arc);
  len += segLength(arc);
  const sgn = dir === 'R' ? 90 : -90;
  return {
    start: lead ?? arc.a, end: arc.b, segs, length: len,
    crsIn: lead && segs.length > 1 ? bearing(lead, arc.a) : norm360(startBrg + sgn),
    crsOut: norm360(endBrg + sgn), endIsFix: true,
  };
}

/** Racetrack for a hold: inbound leg ends at the fix. */
export function holdRacetrack(fix: LatLon, inboundTrue: number, turn: 'L' | 'R', legNm: number, radius: number): PathSeg[] {
  const side = turn === 'R' ? 90 : -90;
  const outbound = norm360(inboundTrue + 180);
  const inStart = destination(fix, outbound, legNm);
  const c1 = destination(fix, inboundTrue + side, radius);
  const outStart = destination(fix, inboundTrue + side, 2 * radius);
  const outEnd = destination(outStart, outbound, legNm);
  const c2 = destination(inStart, inboundTrue + side, radius);
  const dir = turn;
  const a1 = arcSeg(c1, radius, bearing(c1, fix), bearing(c1, outStart), dir);
  const a2 = arcSeg(c2, radius, bearing(c2, outEnd), bearing(c2, inStart), dir);
  // Force full half turns
  a1.sweep = dir === 'R' ? 180 : -180;
  a2.sweep = dir === 'R' ? 180 : -180;
  return [lineSeg(inStart, fix), a1, lineSeg(outStart, outEnd), a2];
}

export function holdLegLength(leg: FPLeg, tas: number, alt: number): number {
  const h = leg.hold;
  if (!h) return 4;
  if (h.legDist) return h.legDist;
  const t = h.legTime ?? (alt > 14000 ? 1.5 : 1.0);
  return (tas * t) / 60;
}

/** Bank angle used for path planning (leaves margin below the autopilot limit). */
export const planBank = (alt: number): number => (alt > 31000 ? 12 : 20);

export const turnRadius = (tas: number, bankDeg = 25): number => {
  // Standard rate or bank-limited, whichever gives the larger radius
  const rStd = tas / (20 * Math.PI) / 3; // 3 deg/s
  const v = tas * 0.514444;
  const rBank = (v * v) / (9.80665 * Math.tan(bankDeg * D2R)) / 1852;
  return Math.max(rStd, rBank);
};

/** Compute geometry for all legs of a flight plan. */
export function computeGeometry(plan: FlightPlan, ctx: GeoContext): void {
  const legs = plan.legs;
  let cur: LatLon | null = null;
  let curCrs = 0;
  let alt = ctx.originElev;
  let gapFrom: LatLon | null = null;

  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    if (leg.pt === 'DISCO') {
      leg.geo = undefined;
      if (cur) gapFrom = cur;
      cur = null;
      continue;
    }
    const isActive = i === plan.activeIdx;
    if (isActive && ctx.airborne && ctx.acAlt != null) alt = Math.max(alt, ctx.acAlt);
    let start: LatLon | null = cur;
    if (leg.ppos && i >= plan.activeIdx) start = leg.ppos;
    const geo = legGeometry(leg, legs[i + 1], start, curCrs, alt, ctx, isActive);
    leg.geo = geo;
    if (geo && gapFrom) {
      geo.discoGap = distance(gapFrom, geo.start);
      gapFrom = null;
    }
    if (geo) {
      if (geo.endAlt != null) alt = geo.endAlt;
      else if (leg.alt && leg.seg === 'SID') alt = Math.max(alt, leg.alt.a1);
      cur = geo.end;
      curCrs = geo.crsOut;
    }
  }
}

function legGeometry(leg: FPLeg, next: FPLeg | undefined, start: LatLon | null, curCrs: number, alt: number, ctx: GeoContext, isActive: boolean): LegGeo | undefined {
  const fix = leg.fix;
  const crsT = (at: LatLon) => legCourseTrue(leg, at) ?? curCrs;
  switch (leg.pt) {
    case 'IF': {
      if (!fix) return undefined;
      return { start: fix, end: fix, segs: [], length: 0, crsIn: curCrs, crsOut: curCrs, endIsFix: true };
    }
    case 'TF':
    case 'DF': {
      if (!fix) return undefined;
      if (!start) return { start: fix, end: fix, segs: [], length: 0, crsIn: curCrs, crsOut: curCrs, endIsFix: true };
      return lineGeo(start, fix);
    }
    case 'CF': {
      if (!fix) return undefined;
      const c = crsT(fix);
      if (!start) return { start: fix, end: fix, segs: [], length: 0, crsIn: c, crsOut: c, endIsFix: true };
      const xtk = crossTrackCourse(fix, c, start);
      const along = alongTrackCourse(fix, c, start); // negative before the fix
      const brgTo = bearing(start, fix);
      if (leg.intcCrs != null && leg.ppos) {
        const trk = ctx.acTrack ?? brgTo;
        const p = intersection(start, trk, fix, norm360(c + 180));
        if (p && distance(start, p) < distance(start, fix) + 5 && alongTrackCourse(fix, c, p) < -0.2) return polyGeo([start, p, fix]);
        const p45 = intersection(start, norm360(c + (xtk > 0 ? -45 : 45)), fix, norm360(c + 180));
        if (p45 && alongTrackCourse(fix, c, p45) < -0.2) return polyGeo([start, p45, fix]);
        return lineGeo(start, fix);
      }
      if (along >= -0.1) return lineGeo(start, fix);
      if (Math.abs(xtk) < 1.5 && Math.abs(angDiff(c, brgTo)) < 15) return lineGeo(start, fix);
      // Intercept the course at 45 degrees
      const intc = norm360(c + (xtk > 0 ? -45 : 45));
      const p = intersection(start, intc, fix, norm360(c + 180));
      if (p && alongTrackCourse(fix, c, p) < 0 && distance(start, p) < 80) return polyGeo([start, p, fix]);
      return lineGeo(start, fix);
    }
    case 'CA':
    case 'VA':
    case 'FA': {
      const from = leg.pt === 'FA' && fix ? fix : start ?? fix;
      if (!from) return undefined;
      const c = crsT(from);
      const target = leg.alt?.a1 ?? alt + 1000;
      const climb = Math.max(0, target - alt);
      const len = Math.max(0.5, climb / ctx.climbGrad);
      const end = destination(from, c, len);
      const g = lineGeo(from, end, false);
      g.endAlt = Math.max(alt, target);
      if (leg.pt === 'FA' && start && fix && distance(start, fix) > 0.1) {
        const p = polyGeo([start, fix, end], false);
        p.endAlt = g.endAlt;
        return p;
      }
      return g;
    }
    case 'FC': {
      const from = fix ?? start;
      if (!from) return undefined;
      const end = destination(from, crsT(from), leg.dist ?? 1);
      return start && fix && distance(start, fix) > 0.1 ? polyGeo([start, fix, end], false) : lineGeo(from, end, false);
    }
    case 'FD':
    case 'CD':
    case 'VD': {
      const from = leg.pt === 'FD' && fix ? fix : start ?? fix;
      if (!from) return undefined;
      const c = crsT(from);
      const nav = leg.nav ?? (fix ? { lat: fix.lat, lon: fix.lon } : null);
      let end: LatLon | null = null;
      if (nav && leg.dist != null) end = courseCircleIntersection(from, c, nav, leg.dist);
      if (!end) end = destination(from, c, leg.dist ?? 3);
      return lineGeo(from, end, false);
    }
    case 'CR':
    case 'VR': {
      if (!start) return undefined;
      const c = crsT(start);
      const nav = leg.nav;
      let end: LatLon | null = null;
      if (nav && leg.theta != null) end = intersection(start, c, nav, norm360(leg.theta + nav.dec));
      if (!end || distance(start, end) > 60) end = destination(start, c, 5);
      return lineGeo(start, end, false);
    }
    case 'CI':
    case 'VI': {
      if (!start) return undefined;
      const c = crsT(start);
      let end: LatLon | null = null;
      if (next?.fix) {
        if (next.pt === 'AF' && next.nav) {
          const r = next.rho ?? distance(next.nav, next.fix);
          end = courseCircleIntersection(start, c, next.nav, r);
        } else {
          const nc = next.crs != null ? legCourseTrue(next, next.fix)! : bearing(start, next.fix);
          end = intersection(start, c, next.fix, norm360(nc + 180));
          if (end && alongTrackCourse(next.fix, nc, end) > 0) end = null;
        }
      }
      if (!end || distance(start, end) > 40) end = destination(start, c, 3);
      return lineGeo(start, end, false);
    }
    case 'VM':
    case 'FM': {
      const from = leg.pt === 'FM' && fix ? fix : start ?? fix;
      if (!from) return undefined;
      const end = destination(from, crsT(from), 12);
      const g = start && fix && leg.pt === 'FM' && distance(start, fix) > 0.1 ? polyGeo([start, fix, end], false) : lineGeo(from, end, false);
      g.manual = true;
      return g;
    }
    case 'RF': {
      if (!fix) return undefined;
      if (!start || !leg.arcR) return start ? lineGeo(start, fix) : undefined;
      const v = toLocal(start, fix);
      const c = Math.hypot(v.x, v.y);
      const r = leg.arcR;
      if (c < 0.01 || c > 2 * r + 0.05) return lineGeo(start, fix);
      const h = Math.sqrt(Math.max(0, r * r - (c / 2) ** 2));
      const nr = { x: v.y / c, y: -v.x / c }; // right perpendicular
      const s = leg.turn === 'L' ? -1 : 1;
      const center = fromLocal(start, { x: v.x / 2 + nr.x * h * s, y: v.y / 2 + nr.y * h * s });
      return arcGeo(center, r, bearing(center, start), bearing(center, fix), leg.turn ?? 'R');
    }
    case 'AF': {
      if (!fix) return undefined;
      const nav = leg.nav;
      if (!nav || !start) return start ? lineGeo(start, fix) : undefined;
      const r = leg.rho ?? distance(nav, fix);
      const b0 = bearing(nav, start);
      const b1 = bearing(nav, fix);
      const lead = Math.abs(distance(nav, start) - r) > 0.3 ? start : undefined;
      return arcGeo(nav, r, b0, b1, leg.turn ?? 'R', lead);
    }
    case 'PI': {
      if (!fix) return undefined;
      const inbound = next?.crs != null && next.fix ? legCourseTrue(next, next.fix)! : norm360(crsT(fix) + 45);
      const outbound = norm360(inbound + 180);
      const ptHdg = crsT(fix);
      const R = turnRadius(ctx.holdTas || 180);
      const a = destination(fix, outbound, 2.5);
      const b = destination(a, ptHdg, 3);
      const dir = leg.turn ?? (angDiff(outbound, ptHdg) > 0 ? 'L' : 'R');
      const c = destination(b, norm360(ptHdg + (dir === 'R' ? 90 : -90)), 2 * R);
      const back = norm360(ptHdg + 180);
      let d = intersection(c, back, fix, outbound);
      if (!d || distance(fix, d) > 15) d = destination(fix, outbound, 4);
      const pts = start && distance(start, fix) > 0.1 ? [start, fix, a, b, c, d] : [fix, a, b, c, d];
      const g = polyGeo(pts, false);
      return g;
    }
    case 'HA':
    case 'HF':
    case 'HM': {
      if (!fix) return undefined;
      const inbound = leg.hold ? magToTrue(leg.hold.inbound, fix.lat, fix.lon) : curCrs;
      const tas = ctx.holdTas || 200;
      const R = turnRadius(tas);
      const L = holdLegLength(leg, tas, alt);
      const track = holdRacetrack(fix, inbound, leg.hold?.turn ?? 'R', L, R);
      const circuit = 2 * L + 2 * Math.PI * R;
      const base: LegGeo = {
        start: start ?? fix, end: fix, segs: [], length: leg.pt === 'HF' ? circuit : 0,
        crsIn: inbound, crsOut: inbound, endIsFix: true, holdTrack: track,
      };
      if (start && distance(start, fix) > 0.2) {
        base.segs = [lineSeg(start, fix)];
        base.length += distance(start, fix);
        base.crsIn = bearing(start, fix);
      }
      if (leg.pt === 'HA' && leg.alt) base.endAlt = leg.alt.a1;
      void isActive;
      return base;
    }
  }
  return undefined;
}

export { isHold };
