// Flight plan model and editing operations.
import { distance, bearing, destination, LatLon } from '../util/geo';
import { magToTrue, trueToMag } from '../util/magvar';
import { navdb, Airport, Runway, Waypoint, RawLeg, SidStar, Approach, ProcSet } from '../nav/navdb';
import type { AltCstr, AppSel, FPLeg, FlightPlanData, PathTerm, ProcSel, SegKind, SpdCstr } from './types';

let uidCounter = 1;
export const newUid = (): number => uidCounter++;

export const aptWpt = (apt: Airport): Waypoint => ({ ident: apt.ident, lat: apt.lat, lon: apt.lon, kind: 'APT', apt, elev: apt.elev, name: apt.name });
export const rwyWpt = (apt: Airport, r: Runway): Waypoint => ({ ident: 'RW' + r.id, lat: r.lat, lon: r.lon, kind: 'RWY', apt, rwy: r, elev: r.elev });

export const sameFix = (a?: Waypoint, b?: Waypoint): boolean =>
  !!a && !!b && a.ident === b.ident && distance(a, b) < 2;

const HOLD_PT = new Set(['HA', 'HF', 'HM']);
export const isHold = (l: FPLeg): boolean => HOLD_PT.has(l.pt);
export const isManual = (l: FPLeg): boolean => l.pt === 'VM' || l.pt === 'FM';
/** Legs whose end point is a real waypoint. */
export const endsAtFix = (l: FPLeg): boolean =>
  ['IF', 'TF', 'CF', 'DF', 'RF', 'AF', 'HA', 'HF', 'HM'].includes(l.pt) && !!l.fix;

export function mapAlt(a?: [string, number | null, number | null]): AltCstr | undefined {
  if (!a || a[1] == null) return undefined;
  const [d, a1, a2] = a;
  switch (d) {
    case '+': case 'H': case 'J': case 'V': return { t: 'AB', a1 };
    case '-': case 'Y': return { t: 'BL', a1 };
    case 'B': return a2 != null ? { t: 'WIN', a1: Math.max(a1, a2), a2: Math.min(a1, a2) } : { t: 'AT', a1 };
    case 'C': return { t: 'AB', a1: a2 ?? a1 };
    default: return { t: 'AT', a1 };
  }
}
export function mapSpd(s?: [string, number]): SpdCstr | undefined {
  if (!s) return undefined;
  return { t: s[0] === '-' ? 'BL' : s[0] === '+' ? 'AB' : 'AT', kt: s[1] };
}

function kindFromCat(k?: string): Waypoint['kind'] {
  switch (k) {
    case 'N': return 'VOR';
    case 'A': return 'APT';
    case 'R': return 'RWY';
    default: return 'FIX';
  }
}

export function legFromRaw(r: RawLeg, seg: SegKind, via: string, trans: string | undefined, apt: Airport | null): FPLeg {
  const leg: FPLeg = { uid: newUid(), pt: r.p as PathTerm, seg, via, trans };
  if (r.f && r.la != null && r.lo != null) {
    const fix: Waypoint = { ident: r.f, lat: r.la, lon: r.lo, kind: kindFromCat(r.k) };
    if (fix.kind === 'RWY' && apt) {
      const rw = apt.runways.find((x) => 'RW' + x.id === r.f);
      if (rw) { fix.rwy = rw; fix.apt = apt; fix.elev = rw.elev; }
    } else if (fix.kind === 'VOR') {
      const n = navdb.find(r.f).find((w) => w.kind !== 'FIX' && w.kind !== 'APT' && distance(w, fix) < 2);
      if (n) Object.assign(fix, { kind: n.kind, sub: n.sub, freq: n.freq, dec: n.dec, name: n.name });
    }
    leg.fix = fix;
  }
  if (r.c != null) leg.crs = r.c;
  if (r.d != null) leg.dist = r.d;
  if (r.ht != null) leg.time = r.ht;
  if (r.t) { leg.turn = r.t; leg.turnForced = !!r.tv; }
  leg.alt = mapAlt(r.a);
  leg.spd = mapSpd(r.s);
  if (r.rla != null && r.rlo != null && r.rn) leg.nav = { ident: r.rn, lat: r.rla, lon: r.rlo, dec: r.rmv ?? 0 };
  if (r.th != null) leg.theta = r.th;
  if (r.rh != null) leg.rho = r.rh;
  if (r.r != null) leg.arcR = r.r;
  if (r.fo) leg.flyover = true;
  if (r.faf) leg.faf = true;
  if (r.map) leg.map = true;
  if (r.iaf) leg.iaf = true;
  if (r.vpa != null) leg.vpa = r.vpa;
  if (HOLD_PT.has(r.p)) {
    leg.hold = { inbound: r.c ?? 0, turn: r.t || 'R', legTime: r.ht ?? (r.d ? undefined : 1), legDist: r.d };
  }
  return leg;
}

export interface RouteElem {
  via: string;
  to: string;
  start: number;
  end: number; // inclusive
  seg: SegKind;
  disco?: boolean;
}

export class FlightPlan implements FlightPlanData {
  origin: Airport | null = null;
  dest: Airport | null = null;
  altn: Airport | null = null;
  origRwy: Runway | null = null;
  destRwy: Runway | null = null;
  sid: ProcSel | null = null;
  star: ProcSel | null = null;
  app: AppSel | null = null;
  fltNo = '';
  routeName = '';
  legs: FPLeg[] = [];
  activeIdx = 1;
  /** Altitude at which the missed approach has been activated. */
  missedActive = false;
  /** Bumped on every structural change. */
  version = 0;

  clone(): FlightPlan {
    const p = new FlightPlan();
    Object.assign(p, this);
    p.legs = this.legs.map((l) => ({ ...l, hold: l.hold ? { ...l.hold } : undefined, alt: l.alt ? { ...l.alt } : undefined, spd: l.spd ? { ...l.spd } : undefined }));
    return p;
  }

  touch() {
    this.version++;
  }

  get isEmpty(): boolean {
    return !this.origin && this.legs.length === 0;
  }

  activeLeg(): FPLeg | undefined {
    return this.legs[this.activeIdx];
  }

  /** Index of the first leg of a segment kind, or -1. */
  firstOf(kind: SegKind): number {
    return this.legs.findIndex((l) => l.seg === kind);
  }
  lastOf(kind: SegKind): number {
    for (let i = this.legs.length - 1; i >= 0; i--) if (this.legs[i].seg === kind) return i;
    return -1;
  }

  /** Index where enroute legs should be appended (before STAR/APP/DEST). */
  enrouteInsertIdx(): number {
    const i = this.legs.findIndex((l) => l.seg === 'STAR' || l.seg === 'APP' || l.seg === 'MAP' || l.seg === 'DEST');
    return i < 0 ? this.legs.length : i;
  }

  /** Last leg before index `i` that ends at a fix (skipping discontinuities). */
  prevFixLeg(i: number): FPLeg | undefined {
    for (let k = i - 1; k >= 0; k--) {
      const l = this.legs[k];
      if (l.pt === 'DISCO') return undefined;
      if (l.fix && endsAtFix(l)) return l;
      if (!l.fix) return undefined;
    }
    return undefined;
  }

  // -------------------------------------------------------------------------
  // Origin / destination

  setOrigin(apt: Airport) {
    this.origin = apt;
    this.origRwy = null;
    this.sid = null;
    const dest = this.dest;
    this.legs = [{ uid: newUid(), pt: 'IF', fix: aptWpt(apt), seg: 'ORIG', via: '' }];
    this.star = null;
    this.app = null;
    this.destRwy = null;
    this.activeIdx = 1;
    this.missedActive = false;
    if (dest) this.setDest(dest);
    this.touch();
  }

  setDest(apt: Airport) {
    this.dest = apt;
    this.star = null;
    this.app = null;
    this.destRwy = null;
    this.legs = this.legs.filter((l) => l.seg !== 'STAR' && l.seg !== 'APP' && l.seg !== 'MAP' && l.seg !== 'DEST');
    this.trimTrailingDisco();
    const leg: FPLeg = { uid: newUid(), pt: 'TF', fix: aptWpt(apt), seg: 'DEST', via: 'DIRECT' };
    this.legs.push(leg);
    this.ensureLinkBefore(this.legs.length - 1);
    this.touch();
  }

  private trimTrailingDisco() {
    while (this.legs.length && this.legs[this.legs.length - 1].pt === 'DISCO') this.legs.pop();
  }

  setOrigRwy(rwy: Runway | null) {
    if (!this.origin) return;
    this.origRwy = rwy;
    const orig = this.legs[0];
    if (orig && orig.seg === 'ORIG') orig.fix = rwy ? rwyWpt(this.origin, rwy) : aptWpt(this.origin);
    // Re-expand SID for the new runway.
    if (this.sid) {
      const ps = navdb.proceduresIfLoaded(this.origin.ident);
      const sid = ps?.sids.find((s) => s.id === this.sid!.id);
      if (sid && rwy) this.insertSid(sid, this.sid.trans, ps!);
    }
    this.touch();
  }

  // -------------------------------------------------------------------------
  // Linking helpers

  private disco(seg: SegKind): FPLeg {
    return { uid: newUid(), pt: 'DISCO', seg, via: '' };
  }

  /** Make sure legs[i] connects to the leg before it; insert a discontinuity if not. */
  ensureLinkBefore(i: number) {
    if (i <= 0 || i >= this.legs.length) return;
    const prev = this.legs[i - 1];
    const cur = this.legs[i];
    if (prev.pt === 'DISCO' || cur.pt === 'DISCO') return;
    if (prev.seg === 'ORIG' && cur.seg === 'DEST') {
      this.legs.splice(i, 0, this.disco('ENR'));
      return;
    }
    if (isManual(prev) || (prev.pt === 'HM' && cur.seg !== 'MAP')) {
      this.legs.splice(i, 0, this.disco(cur.seg));
      return;
    }
    if (cur.pt === 'IF') {
      if (prev.fix && sameFix(prev.fix, cur.fix)) {
        // Merge duplicate fix: keep the incoming leg, carry constraints.
        if (!prev.alt && cur.alt) prev.alt = cur.alt;
        if (!prev.spd && cur.spd) prev.spd = cur.spd;
        this.legs.splice(i, 1);
        return;
      }
      cur.pt = 'TF';
      if (!(prev.seg === 'ORIG' && prev.fix?.kind === 'APT')) this.legs.splice(i, 0, this.disco(cur.seg));
      return;
    }
    if (prev.fix && cur.fix && sameFix(prev.fix, cur.fix) && endsAtFix(prev) && (cur.pt === 'TF' || cur.pt === 'DF')) {
      if (!prev.alt && cur.alt) prev.alt = cur.alt;
      if (!prev.spd && cur.spd) prev.spd = cur.spd;
      this.legs.splice(i, 1);
    }
  }

  private removeSeg(...kinds: SegKind[]) {
    const active = this.legs[this.activeIdx];
    this.legs = this.legs.filter((l) => !kinds.includes(l.seg));
    this.fixActiveIdx(active);
  }

  private fixActiveIdx(prevActive?: FPLeg) {
    if (prevActive) {
      const i = this.legs.indexOf(prevActive);
      if (i >= 0) { this.activeIdx = i; return; }
    }
    this.activeIdx = Math.min(Math.max(1, this.activeIdx), Math.max(1, this.legs.length - 1));
  }

  /** Join two sequences: drop legs after `i` up to a later repeat of legs[i].fix. */
  private joinAt(i: number) {
    const a = this.legs[i];
    if (!a || !a.fix || !endsAtFix(a)) return;
    for (let k = i + 1; k < this.legs.length; k++) {
      const l = this.legs[k];
      if (l.seg === 'MAP') break;
      if (l.fix && sameFix(a.fix, l.fix) && endsAtFix(l)) {
        // Remove the intermediate legs and the duplicate itself
        if (!a.alt && l.alt) a.alt = l.alt;
        const removed = this.legs.splice(i + 1, k - i);
        if (removed.includes(this.legs[this.activeIdx])) this.activeIdx = i;
        return;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Procedures

  static rwyTransKey(trans: Record<string, RawLeg[]>, rwId: string): string | null {
    const id = 'RW' + rwId;
    if (trans[id]) return id;
    const num = rwId.replace(/[LRC]$/, '');
    if (trans['RW' + num + 'B']) return 'RW' + num + 'B';
    if (trans['RW' + num]) return 'RW' + num;
    if (trans['ALL']) return 'ALL';
    return null;
  }

  insertSid(sid: SidStar, trans: string | null, _ps?: ProcSet) {
    if (!this.origin) return;
    const apt = this.origin;
    const prevActive = this.legs[this.activeIdx];
    // Remember how the old SID connected to the route so a re-insert keeps the link.
    const oldEndIdx = this.lastOf('SID');
    const oldEnd = oldEndIdx >= 0 ? this.legs[oldEndIdx] : undefined;
    const oldLinked = !!oldEnd && this.legs[oldEndIdx + 1] != null && this.legs[oldEndIdx + 1].pt !== 'DISCO';
    this.removeSeg('SID');
    const via = sid.id;
    const out: FPLeg[] = [];
    const add = (raw: RawLeg[], tname?: string) => {
      for (const r of raw) {
        const l = legFromRaw(r, 'SID', via, trans ?? undefined, apt);
        const last = out[out.length - 1];
        if (l.pt === 'IF' && last && sameFix(last.fix, l.fix)) {
          if (!last.alt && l.alt) last.alt = l.alt;
          continue;
        }
        if (l.pt === 'IF' && last) l.pt = 'TF';
        if (tname) l.trans = tname;
        out.push(l);
      }
    };
    if (this.origRwy) {
      const k = FlightPlan.rwyTransKey(sid.rw, this.origRwy.id);
      if (k) add(sid.rw[k]);
    }
    add(sid.cm);
    if (trans && sid.en[trans]) add(sid.en[trans], trans);
    // First SID leg: an IF at a fix not at the runway needs a discontinuity after the runway.
    const insertAt = this.legs[0]?.seg === 'ORIG' ? 1 : 0;
    this.legs.splice(insertAt, 0, ...out);
    this.sid = { id: sid.id, trans };
    // Link origin -> SID start
    if (out.length) {
      const first = this.legs[insertAt];
      if (first.pt === 'IF') {
        const orig = this.legs[0];
        if (orig.fix && first.fix && distance(orig.fix, first.fix) < 1.5) this.legs.splice(insertAt, 1);
        else { first.pt = 'TF'; this.legs.splice(insertAt, 0, this.disco('SID')); }
      }
      const lastIdx = this.lastOf('SID');
      // Link SID -> enroute (remove leading discontinuity between them first)
      if (this.legs[lastIdx + 1]?.pt === 'DISCO' && this.legs[lastIdx + 1].seg !== 'SID') this.legs.splice(lastIdx + 1, 1);
      this.joinAt(lastIdx);
      const next = this.legs[lastIdx + 1];
      if (next && next.pt !== 'DISCO') {
        const last = this.legs[lastIdx];
        const keepLink = oldLinked && oldEnd?.fix && last.fix && sameFix(oldEnd.fix, last.fix);
        const airwayFromEnd = next.seg === 'ENR' && next.via !== 'DIRECT' && !!last.fix && navdb.airwayContains(next.via, last.fix.ident);
        if (isManual(last)) this.legs.splice(lastIdx + 1, 0, this.disco('ENR'));
        else if (!keepLink && !airwayFromEnd && !(next.seg === 'DEST' && !this.legs.some((l) => l.seg === 'ENR'))) {
          if (!(last.fix && next.fix && sameFix(last.fix, next.fix))) this.legs.splice(lastIdx + 1, 0, this.disco('ENR'));
        }
      }
    }
    this.fixActiveIdx(prevActive);
    this.touch();
  }

  insertStar(star: SidStar, trans: string | null) {
    if (!this.dest) return;
    const apt = this.dest;
    const prevActive = this.legs[this.activeIdx];
    this.removeSeg('STAR');
    const out: FPLeg[] = [];
    const add = (raw: RawLeg[], tname?: string) => {
      for (const r of raw) {
        const l = legFromRaw(r, 'STAR', star.id, trans ?? undefined, apt);
        const last = out[out.length - 1];
        if (l.pt === 'IF' && last && sameFix(last.fix, l.fix)) {
          if (!last.alt && l.alt) last.alt = l.alt;
          if (!last.spd && l.spd) last.spd = l.spd;
          continue;
        }
        if (l.pt === 'IF' && last) l.pt = 'TF';
        if (tname) l.trans = tname;
        out.push(l);
      }
    };
    if (trans && star.en[trans]) add(star.en[trans], trans);
    add(star.cm);
    const rwId = this.destRwy?.id || this.app?.rwy;
    if (rwId) {
      const k = FlightPlan.rwyTransKey(star.rw, rwId);
      if (k) add(star.rw[k]);
    }
    let at = this.legs.findIndex((l) => l.seg === 'APP' || l.seg === 'MAP' || l.seg === 'DEST');
    if (at < 0) at = this.legs.length;
    // Drop a discontinuity directly before the insertion point
    if (this.legs[at - 1]?.pt === 'DISCO' && this.legs[at - 1].seg !== 'SID') { this.legs.splice(at - 1, 1); at--; }
    this.legs.splice(at, 0, ...out);
    this.star = { id: star.id, trans };
    this.linkProcedureStart(at, out);
    // STAR -> approach/dest
    const lastIdx = this.lastOf('STAR');
    if (lastIdx >= 0) this.linkProcedureEnd(lastIdx);
    this.fixActiveIdx(prevActive);
    this.touch();
  }

  /** Connect the route before `at` with a newly inserted procedure starting at `at`. */
  private linkProcedureStart(at: number, out: FPLeg[]) {
    if (!out.length) return;
    const first = this.legs[at];
    // Is the procedure entry fix already in the route? Then cut the route there.
    let found = -1;
    if (first.fix) {
      for (let k = at - 1; k >= 1; k--) {
        const l = this.legs[k];
        if (l.seg === 'SID' && k < this.activeIdx) break;
        if (l.fix && endsAtFix(l) && sameFix(l.fix, first.fix)) { found = k; break; }
      }
    }
    if (found >= 0) {
      // Keep the route leg to the entry fix (so the airway stays visible), drop
      // anything between it and the procedure, and drop the procedure's own
      // first leg after moving its constraints onto the route leg.
      const route = this.legs[found];
      const activeLeg = this.legs[this.activeIdx];
      this.legs.splice(found + 1, at - found - 1);
      const procFirst = this.legs[found + 1];
      if (procFirst === first) {
        if (first.alt) route.alt = first.alt;
        if (first.spd) route.spd = first.spd;
        if (first.iaf) route.iaf = true;
        if (first.faf) route.faf = true;
        if (first.pt === 'TF' || first.pt === 'IF' || first.pt === 'DF') this.legs.splice(found + 1, 1);
        else route.fix = first.fix ?? route.fix;
      }
      const ai = this.legs.indexOf(activeLeg);
      this.activeIdx = ai >= 0 ? ai : Math.min(found, this.legs.length - 1);
      return;
    }
    const prev = this.legs[at - 1];
    if (first.pt === 'IF') first.pt = 'TF';
    if (prev && prev.pt !== 'DISCO') {
      if (prev.seg === 'ORIG' && prev.fix?.kind === 'APT' && !this.legs.some((l) => l.seg === 'ENR' || l.seg === 'SID')) {
        this.legs.splice(at, 0, this.disco(first.seg));
      } else if (!(prev.fix && first.fix && sameFix(prev.fix, first.fix))) {
        this.legs.splice(at, 0, this.disco(first.seg));
      }
    }
  }

  /** Connect the procedure ending at lastIdx with whatever follows. */
  private linkProcedureEnd(lastIdx: number) {
    const last = this.legs[lastIdx];
    const next = this.legs[lastIdx + 1];
    if (!next) return;
    if (next.pt === 'DISCO') return;
    if (next.seg === 'DEST') return; // direct to the airport
    if (next.fix && last.fix && sameFix(last.fix, next.fix)) {
      if (!next.alt && last.alt) next.alt = last.alt;
      if (!next.spd && last.spd) next.spd = last.spd;
      // keep approach leg (IAF) and drop the duplicate STAR leg
      next.pt = next.pt === 'IF' ? 'TF' : next.pt;
      if (last.alt && !next.alt) next.alt = last.alt;
      this.legs.splice(lastIdx, 1);
      return;
    }
    // Approach entry fix earlier in the STAR? cut the STAR there.
    if (next.fix) {
      for (let k = lastIdx; k >= 0 && this.legs[k].seg === last.seg; k--) {
        const l = this.legs[k];
        if (l.fix && sameFix(l.fix, next.fix)) {
          this.legs.splice(k, lastIdx - k + 1);
          if (next.pt === 'IF') next.pt = 'TF';
          return;
        }
      }
    }
    if (next.pt === 'IF') next.pt = 'TF';
    this.legs.splice(lastIdx + 1, 0, this.disco(next.seg));
  }

  insertApproach(app: Approach, trans: string | null) {
    if (!this.dest) return;
    const apt = this.dest;
    const prevActive = this.legs[this.activeIdx];
    this.removeSeg('APP', 'MAP', 'DEST');
    this.trimTrailingDisco();
    const out: FPLeg[] = [];
    const via = approachName(app);
    const add = (raw: RawLeg[], seg: SegKind, tname?: string) => {
      for (const r of raw) {
        const l = legFromRaw(r, seg, via, trans ?? undefined, apt);
        const last = out[out.length - 1];
        if (l.pt === 'IF' && last && sameFix(last.fix, l.fix)) {
          if (!last.alt && l.alt) last.alt = l.alt;
          if (l.faf) last.faf = true;
          continue;
        }
        if (l.pt === 'IF' && last) l.pt = 'TF';
        if (tname) l.trans = tname;
        out.push(l);
      }
    };
    if (trans && app.tr[trans]) add(app.tr[trans], 'APP', trans);
    add(app.fn, 'APP');
    const mapStart = out.length;
    add(app.ma, 'MAP');
    // Missed approach begins with a leg from the MAP; first MAP leg IF should become the runway
    if (out[mapStart] && out[mapStart].pt === 'IF') out.splice(mapStart, 1);
    const rw = apt.runways.find((r) => r.id === app.rwy) || null;
    this.destRwy = rw;
    this.app = { id: app.id, trans, name: via, type: app.ty, rwy: app.rwy };
    // If the final approach doesn't end at a runway (circling), add the airport
    this.legs.push(...out);
    const at = this.legs.length - out.length;
    this.linkProcedureStart(at, out);
    // Re-link STAR for runway transition if needed
    if (this.star && this.dest) {
      const ps = navdb.proceduresIfLoaded(this.dest.ident);
      const star = ps?.stars.find((s) => s.id === this.star!.id);
      // A STAR with runway transitions must be re-expanded for the approach runway.
      if (star && rw && FlightPlan.rwyTransKey(star.rw, rw.id)) this.insertStar(star, this.star.trans);
    }
    this.fixActiveIdx(prevActive);
    this.touch();
  }

  /** Runway-only arrival: 5 NM final fix then the threshold. */
  insertRunwayArrival(rw: Runway) {
    if (!this.dest) return;
    const apt = this.dest;
    const prevActive = this.legs[this.activeIdx];
    this.removeSeg('APP', 'MAP', 'DEST');
    this.trimTrailingDisco();
    const recip = (rw.brg + 180) % 360;
    const ff = destination(rw, recip, 5);
    const crsMag = Math.round(trueToMag(rw.brg, rw.lat, rw.lon));
    const ffAlt = Math.round((rw.elev + 50 + Math.tan((3 * Math.PI) / 180) * 5 * 6076) / 100) * 100;
    const out: FPLeg[] = [
      { uid: newUid(), pt: 'TF', fix: { ident: 'RX' + rw.id, lat: ff.lat, lon: ff.lon, kind: 'FIX' }, seg: 'APP', via: 'RW' + rw.id, alt: { t: 'AT', a1: ffAlt }, faf: true },
      { uid: newUid(), pt: 'CF', fix: rwyWpt(apt, rw), crs: crsMag, dist: 5, seg: 'APP', via: 'RW' + rw.id, map: true, vpa: -3, alt: { t: 'AT', a1: rw.elev + 50 } },
    ];
    this.destRwy = rw;
    this.app = { id: 'RW' + rw.id, trans: null, name: 'RW' + rw.id, type: 'RWY', rwy: rw.id };
    this.legs.push(...out);
    this.linkProcedureStart(this.legs.length - out.length, out);
    this.fixActiveIdx(prevActive);
    this.touch();
  }

  clearSid() {
    this.removeSeg('SID');
    this.sid = null;
    this.cleanupDiscos();
    this.ensureLinkBefore(1);
    this.touch();
  }
  clearStar() {
    this.removeSeg('STAR');
    this.star = null;
    this.cleanupDiscos();
    this.touch();
  }
  clearApproach() {
    if (!this.dest) return;
    this.removeSeg('APP', 'MAP');
    this.app = null;
    this.destRwy = null;
    this.setDestLegOnly();
    this.touch();
  }
  private setDestLegOnly() {
    if (!this.dest) return;
    this.trimTrailingDisco();
    if (!this.legs.some((l) => l.seg === 'DEST')) {
      this.legs.push({ uid: newUid(), pt: 'TF', fix: aptWpt(this.dest), seg: 'DEST', via: 'DIRECT' });
      this.ensureLinkBefore(this.legs.length - 1);
    }
  }

  /** Remove doubled discontinuities. */
  cleanupDiscos() {
    for (let i = this.legs.length - 1; i > 0; i--) {
      if (this.legs[i].pt === 'DISCO' && this.legs[i - 1].pt === 'DISCO') this.legs.splice(i, 1);
    }
    if (this.legs[1]?.pt === 'DISCO' && this.legs.length > 2 && this.legs[2].seg !== 'DEST' && this.legs[2].pt !== 'TF' && this.legs[2].pt !== 'DF') {
      /* keep: origin to an unconnected leg */
    }
  }

  // -------------------------------------------------------------------------
  // Enroute editing

  /** Fix the route currently ends at (before STAR/APP/DEST). */
  lastEnrouteFix(): Waypoint | undefined {
    const at = this.enrouteInsertIdx();
    for (let k = at - 1; k >= 0; k--) {
      const l = this.legs[k];
      if (l.pt === 'DISCO') continue;
      if (l.fix && endsAtFix(l)) return l.fix;
      if (!l.fix) return undefined;
    }
    return undefined;
  }

  /** Append DIRECT or airway segment to the route. Returns an error string or null. */
  appendVia(via: string, to: Waypoint): string | null {
    const at0 = this.enrouteInsertIdx();
    let at = at0;
    // Remove a trailing discontinuity before STAR/DEST so the route links up.
    const newLegs: FPLeg[] = [];
    if (via === 'DIRECT' || via === '') {
      newLegs.push({ uid: newUid(), pt: 'TF', fix: to, seg: 'ENR', via: 'DIRECT' });
    } else {
      const from = this.lastEnrouteFix();
      if (!from) return 'INVALID ENTRY';
      const pts = navdb.airwaySegment(via, from, to.ident);
      if (!pts) return 'NOT ON AIRWAY';
      for (const p of pts) newLegs.push({ uid: newUid(), pt: 'TF', fix: p, seg: 'ENR', via: via.toUpperCase() });
      // Use the exact waypoint the pilot selected for the final fix
      newLegs[newLegs.length - 1].fix = to.ident === newLegs[newLegs.length - 1].fix!.ident ? newLegs[newLegs.length - 1].fix : to;
    }
    const prevActive = this.legs[this.activeIdx];
    if (this.legs[at - 1]?.pt === 'DISCO' && this.legs[at - 2]?.seg !== 'SID') {
      // A discontinuity right after the origin: replace it.
      if (this.legs[at - 2]?.seg === 'ORIG' || this.legs[at - 2]?.seg === 'ENR') {
        this.legs.splice(at - 1, 1);
        at--;
      }
    } else if (this.legs[at - 1]?.pt === 'DISCO' && this.legs[at - 2]?.seg === 'SID' && newLegs[0].fix) {
      // SID followed by a discontinuity: the pilot is now defining the route from the SID end.
      const sidEnd = this.legs[at - 2];
      if (sidEnd.fix && !isManual(sidEnd)) {
        this.legs.splice(at - 1, 1);
        at--;
        if (sameFix(sidEnd.fix, newLegs[0].fix)) newLegs.shift();
      }
    }
    if (!newLegs.length) { this.fixActiveIdx(prevActive); this.touch(); return null; }
    // A direct to the fix the route already ends at is a no-op
    if (newLegs.length === 1 && newLegs[0].fix && this.legs[at - 1]?.fix && sameFix(this.legs[at - 1].fix, newLegs[0].fix)) {
      this.fixActiveIdx(prevActive);
      return null;
    }
    this.legs.splice(at, 0, ...newLegs);
    const end = at + newLegs.length - 1;
    // Link with what follows: STAR entry, approach, or destination.
    const next = this.legs[end + 1];
    if (next && next.pt === 'DISCO' && this.legs[end + 2]?.seg === 'DEST') this.legs.splice(end + 1, 1);
    else if (next && next.seg !== 'DEST' && next.pt !== 'DISCO') {
      const lastNew = this.legs[end];
      if (next.fix && lastNew.fix && sameFix(next.fix, lastNew.fix)) {
        if (next.pt === 'TF' || next.pt === 'IF') this.legs.splice(end, 1);
      } else {
        // check whether the procedure contains this fix later, then cut there
        let cut = -1;
        for (let k = end + 1; k < this.legs.length && this.legs[k].seg !== 'MAP'; k++) {
          const l = this.legs[k];
          if (l.fix && lastNew.fix && sameFix(l.fix, lastNew.fix)) { cut = k; break; }
        }
        if (cut > 0) this.legs.splice(end, cut - end);
        else this.legs.splice(end + 1, 0, this.disco('ENR'));
      }
    }
    this.fixActiveIdx(prevActive);
    this.cleanupDiscos();
    this.touch();
    return null;
  }

  /** Build route elements for the FPLN page. */
  routeElements(): RouteElem[] {
    const out: RouteElem[] = [];
    for (let i = 0; i < this.legs.length; i++) {
      const l = this.legs[i];
      if (l.seg === 'ORIG' || l.seg === 'DEST' || l.seg === 'MAP') continue;
      if (l.pt === 'DISCO') {
        out.push({ via: '', to: '', start: i, end: i, seg: l.seg, disco: true });
        continue;
      }
      const last = out[out.length - 1];
      const key = `${l.seg}|${l.via}|${l.trans ?? ''}`;
      const lastLeg = last && !last.disco ? this.legs[last.end] : undefined;
      const lastKey = lastLeg ? `${lastLeg.seg}|${lastLeg.via}|${lastLeg.trans ?? ''}` : '';
      if (last && !last.disco && key === lastKey && !(l.seg === 'ENR' && l.via === 'DIRECT')) {
        last.end = i;
        last.to = legDisplayIdent(l);
      } else {
        let via = l.via;
        if (l.seg === 'SID') via = this.sid ? this.sid.id + (l.trans ? '.' + l.trans : '') : l.via;
        else if (l.seg === 'STAR') via = this.star ? (l.trans ? l.trans + '.' : '') + this.star.id : l.via;
        else if (l.seg === 'APP') via = this.app ? (l.trans ? l.trans + '.' : '') + this.app.name : l.via;
        out.push({ via, to: legDisplayIdent(l), start: i, end: i, seg: l.seg });
      }
    }
    return out;
  }

  /** Delete a route element (FPLN page). */
  deleteElement(e: RouteElem): string | null {
    if (e.disco) return this.deleteLeg(e.start);
    if (e.start <= this.activeIdx && e.end >= this.activeIdx && e.end > this.activeIdx - 1 && e.start < this.activeIdx) return 'INVALID DELETE';
    if (e.seg === 'SID') { this.clearSid(); return null; }
    if (e.seg === 'STAR') { this.clearStar(); return null; }
    if (e.seg === 'APP') { this.clearApproach(); return null; }
    const prevActive = this.legs[this.activeIdx];
    this.legs.splice(e.start, e.end - e.start + 1);
    // Airway following a deleted element no longer starts at the right fix
    const next = this.legs[e.start];
    if (next && next.seg === 'ENR' && next.via !== 'DIRECT') this.legs.splice(e.start, 0, this.disco('ENR'));
    if (this.legs[e.start - 1]?.seg === 'ORIG' && this.legs[e.start]?.seg === 'DEST') this.legs.splice(e.start, 0, this.disco('ENR'));
    this.cleanupDiscos();
    this.fixActiveIdx(prevActive);
    this.touch();
    return null;
  }

  // -------------------------------------------------------------------------
  // LEGS page editing

  /** Insert a waypoint before legs[i] (or close a discontinuity). */
  insertWaypoint(i: number, w: Waypoint): string | null {
    if (i < 1) return 'INVALID ENTRY';
    const prevActive = this.legs[this.activeIdx];
    // Existing downstream? delete the legs in between.
    for (let k = i; k < this.legs.length; k++) {
      const l = this.legs[k];
      if (l.seg === 'MAP' && this.legs[i].seg !== 'MAP') break;
      if (l.fix && endsAtFix(l) && sameFix(l.fix, w)) {
        const removed = this.legs.splice(i, k - i);
        if (removed.includes(prevActive)) this.activeIdx = i;
        else this.fixActiveIdx(prevActive);
        const leg = this.legs[i];
        if (leg.pt === 'IF') leg.pt = 'TF';
        if (removed.length && removed[0].ppos && i === this.activeIdx) { leg.pt = 'DF'; leg.ppos = removed[0].ppos; }
        this.cleanupDiscos();
        this.touch();
        return null;
      }
    }
    const target = this.legs[i];
    const seg: SegKind = target ? (target.seg === 'DEST' || target.seg === 'ORIG' ? 'ENR' : target.seg) : 'ENR';
    const leg: FPLeg = { uid: newUid(), pt: 'TF', fix: w, seg, via: 'DIRECT' };
    if (seg === 'SID' || seg === 'STAR' || seg === 'APP') { leg.via = target.via; leg.trans = target.trans; }
    if (target && target.pt === 'DISCO') {
      // Fill the discontinuity; keep a discontinuity after the new waypoint.
      this.legs.splice(i, 0, leg);
    } else {
      this.legs.splice(i, 0, leg);
      if (target && target.pt === 'IF') target.pt = 'TF';
      if (target && target.ppos) { /* direct leg no longer starts at ppos */ delete target.ppos; target.pt = 'TF'; }
      if (target && target.pt === 'CF' && !target.dist) { /* keep CF */ }
    }
    if (prevActive && i <= this.activeIdx) this.activeIdx = this.legs.indexOf(prevActive) >= 0 && i < this.legs.indexOf(prevActive) ? i : this.activeIdx;
    this.touch();
    return null;
  }

  deleteLeg(i: number): string | null {
    const l = this.legs[i];
    if (!l) return 'INVALID DELETE';
    if (l.seg === 'ORIG') return 'INVALID DELETE';
    if (l.seg === 'DEST' && !this.app) return 'INVALID DELETE';
    if (i < this.activeIdx) return 'INVALID DELETE';
    if (i === this.activeIdx && l.pt !== 'DISCO') return 'INVALID DELETE';
    const prevActive = this.legs[this.activeIdx];
    this.legs.splice(i, 1);
    const next = this.legs[i];
    if (l.pt === 'DISCO') {
      if (next && next.pt === 'IF') next.pt = 'TF';
      if (next && (isManual(this.legs[i - 1]))) this.legs.splice(i, 0, l); // cannot link a vector leg
    } else if (next && next.seg === 'ENR' && next.via !== 'DIRECT' && l.seg === 'ENR' && l.via !== next.via) {
      next.via = 'DIRECT';
    }
    if (this.legs[i - 1]?.seg === 'ORIG' && this.legs[i]?.seg === 'DEST') this.legs.splice(i, 0, this.disco('ENR'));
    this.cleanupDiscos();
    this.fixActiveIdx(prevActive);
    this.touch();
    return null;
  }

  /** Direct-to (optionally with an intercept course, magnetic). */
  directTo(w: Waypoint, ppos: LatLon, intcCrs?: number): void {
    const prevLen = this.legs.length;
    let j = -1;
    for (let k = Math.max(1, this.activeIdx); k < this.legs.length; k++) {
      const l = this.legs[k];
      if (l.fix && endsAtFix(l) && sameFix(l.fix, w)) { j = k; break; }
    }
    if (j >= 0) {
      this.legs.splice(this.activeIdx, j - this.activeIdx);
      const leg = this.legs[this.activeIdx];
      if (isHold(leg)) {
        // direct to a holding fix: fly to the fix, then the hold
        const fixLeg: FPLeg = { uid: newUid(), pt: 'DF', fix: leg.fix, seg: leg.seg, via: leg.via, ppos: { ...ppos } };
        this.legs.splice(this.activeIdx, 0, fixLeg);
      } else {
        leg.pt = intcCrs != null ? 'CF' : 'DF';
        leg.ppos = { ...ppos };
        if (intcCrs != null) { leg.crs = intcCrs; leg.intcCrs = intcCrs; }
        else delete leg.intcCrs;
      }
    } else {
      const seg: SegKind = this.legs[this.activeIdx]?.seg === 'DEST' ? 'ENR' : this.legs[this.activeIdx]?.seg ?? 'ENR';
      const leg: FPLeg = { uid: newUid(), pt: intcCrs != null ? 'CF' : 'DF', fix: w, seg: seg === 'ORIG' ? 'ENR' : seg, via: 'DIRECT', ppos: { ...ppos } };
      if (intcCrs != null) { leg.crs = intcCrs; leg.intcCrs = intcCrs; }
      if (w.kind === 'APT' && this.dest && w.ident === this.dest.ident) {
        // Direct to the destination: drop the route
        this.legs.splice(this.activeIdx, this.legs.length - this.activeIdx, { ...leg, seg: 'DEST' });
      } else {
        this.legs.splice(this.activeIdx, 0, leg, this.disco(leg.seg));
      }
    }
    if (this.activeIdx < 1) this.activeIdx = 1;
    void prevLen;
    this.cleanupDiscos();
    this.touch();
  }

  /** Insert a hold at the fix of leg i (after it). */
  insertHoldAt(i: number, spec: FPLeg['hold']): number {
    const l = this.legs[i];
    if (!l?.fix) return -1;
    const h: FPLeg = { uid: newUid(), pt: 'HM', fix: l.fix, seg: l.seg === 'ORIG' ? 'ENR' : l.seg, via: 'HOLD', hold: spec, alt: undefined };
    this.legs.splice(i + 1, 0, h);
    this.touch();
    return i + 1;
  }

  /** Hold at present position. */
  insertHoldPpos(ppos: LatLon, spec: FPLeg['hold']): number {
    const w: Waypoint = { ident: 'PPOS', lat: ppos.lat, lon: ppos.lon, kind: 'FIX' };
    const h: FPLeg = { uid: newUid(), pt: 'HM', fix: w, seg: 'ENR', via: 'HOLD', hold: spec, ppos: { ...ppos } };
    this.legs.splice(this.activeIdx, 0, h);
    this.touch();
    return this.activeIdx;
  }

  /** Total route distance from leg geometry (NM). */
  totalDistance(fromIdx = 1): number {
    let d = 0;
    for (let i = fromIdx; i < this.legs.length; i++) {
      const l = this.legs[i];
      if (l.seg === 'MAP') break;
      d += (l.geo?.length ?? 0) + (l.geo?.discoGap ?? 0);
    }
    return d;
  }
}

/** Short identifier shown for a leg on the CDU. */
export function legDisplayIdent(l: FPLeg): string {
  switch (l.pt) {
    case 'DISCO':
      return '';
    case 'CA':
    case 'VA':
    case 'FA':
      return l.alt ? `(${l.alt.a1})` : '(ALT)';
    case 'VI':
    case 'CI':
      return '(INTC)';
    case 'VM':
    case 'FM':
      return '(VECTORS)';
    case 'CD':
    case 'VD':
    case 'FD':
      return `(${(l.nav?.ident ?? l.fix?.ident ?? 'DME').slice(0, 4)}${l.dist != null ? Math.round(l.dist) : ''})`;
    case 'CR':
    case 'VR':
      return `(${(l.nav?.ident ?? '').slice(0, 3)}${String(Math.round(l.theta ?? 0)).padStart(3, '0')})`;
    case 'FC':
      return `(${l.fix?.ident ?? ''}+${l.dist ?? ''})`;
    case 'PI':
      return 'PROC TURN';
    default:
      return l.fix?.ident ?? '?';
  }
}

/** Collins-style compact approach name, e.g. ILS16R, RNAV16R-Y, VOR-A. */
export function approachName(app: Approach): string {
  const n = app.n.toUpperCase();
  const variant = /\b([W-Z])\s+RWY\b/.exec(n)?.[1] ?? '';
  const prefix =
    app.ty === 'RNP' ? 'RNP' : app.ty === 'RNAV' ? (n.startsWith('GPS') ? 'GPS' : 'RNAV') : app.ty === 'LOCB' ? 'BC' : app.ty === 'TACAN' ? 'TAC' : app.ty;
  if (app.rwy) return `${prefix}${app.rwy}${variant ? '-' + variant : ''}`;
  const circ = /-([A-Z])$/.exec(n.replace(/\s/g, ''))?.[1] ?? '';
  return `${prefix}-${circ || variant || 'A'}`;
}

export function legCourseTrue(l: FPLeg, at: LatLon): number | undefined {
  if (l.crs == null) return undefined;
  const ref = l.nav && (l.pt === 'AF' || l.pt === 'CR' || l.pt === 'VR' || l.pt === 'CD' || l.pt === 'FD' || l.pt === 'VD') ? l.nav : l.fix ?? at;
  if (l.nav && l.nav.dec && (l.pt === 'CR' || l.pt === 'VR' || l.pt === 'AF')) return (l.crs + l.nav.dec + 360) % 360;
  return magToTrue(l.crs, ref.lat, ref.lon);
}

export { bearing };
