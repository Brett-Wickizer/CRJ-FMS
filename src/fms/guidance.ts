// LNAV/VNAV guidance and leg sequencing.
import {
  LatLon, bearing, distance, crossTrack, alongTrack, angDiff, norm360, clamp, destination,
  crossTrackCourse, alongTrackCourse, R2D, D2R,
} from '../util/geo';
import { magToTrue } from '../util/magvar';
import { casToMach, machToCas as machToCasG, crossoverAlt } from '../util/atmos';
import type { FlightPlan } from './flightplan';
import { isHold, legDisplayIdent } from './flightplan';
import type { FPLeg, PathSeg } from './types';
import { segLength, turnRadius, holdLegLength, planBank } from './geometry';
import type { Predictions, PerfParams } from './predict';

export interface AcState {
  pos: LatLon;
  alt: number;
  ias: number;
  tas: number;
  gs: number;
  trk: number;
  hdg: number;
  vs: number;
  onGround: boolean;
  mach: number;
}

export interface LnavOut {
  valid: boolean;
  dtk: number;
  xtk: number;
  trkCmd: number;
  bankFF: number;
  /** Force turn direction when the heading change is large. */
  turnDir?: 'L' | 'R';
  dtg: number;
  brgTo: number;
  toIdent: string;
  fromIdent: string;
  disco: boolean;
  endOfRoute: boolean;
  holdState?: string;
  holdEntry?: string;
  approach: boolean;
  /** Seconds to the active waypoint. */
  ete: number;
  /** trkCmd is a heading (heading legs, teardrop entry). */
  hdgLeg?: boolean;
}

export interface VnavOut {
  valid: boolean;
  phase: 'PRE' | 'CLB' | 'CRZ' | 'DES' | 'APP';
  tgtAlt: number;
  pathAlt: number | null;
  pathAngle: number;
  vsCmd: number | null;
  tgtIas: number;
  tgtMach: number;
  useMach: boolean;
  vdev: number | null;
  todDist: number | null;
}

type HoldPhase = 'ENTRY_DIRECT' | 'TEARDROP' | 'PARALLEL_OUT' | 'PARALLEL_BACK' | 'TURN1' | 'OUTBOUND' | 'TURN2' | 'INBOUND';

interface HoldRt {
  uid: number;
  phase: HoldPhase;
  entry: 'DIRECT' | 'TEARDROP' | 'PARALLEL';
  phaseStart: LatLon;
  circuits: number;
  turnAccum: number;
  lastHdg: number;
}

export class Guidance {
  lnav: LnavOut = this.emptyLnav();
  vnav: VnavOut = {
    valid: false, phase: 'PRE', tgtAlt: 0, pathAlt: null, pathAngle: 3, vsCmd: null, tgtIas: 0, tgtMach: 0, useMach: false, vdev: null, todDist: null,
  };
  private segIdx = 0;
  private segLegUid = -1;
  private hold: HoldRt | null = null;
  /** Called when a leg sequences (index of the new active leg). */
  onSequence: ((newIdx: number) => void) | null = null;
  /** Distance travelled since the last prediction (for path interpolation). */
  traveledSincePred = 0;
  goAround = false;
  /** Fly-by turn arc being flown onto the active leg. */
  private trans: { uid: number; c: LatLon; r: number; dir: 1 | -1; outCrs: number } | null = null;
  /** Descent speed limit from speed constraints already crossed. */
  desSpdCap = 999;

  private emptyLnav(): LnavOut {
    return { valid: false, dtk: 0, xtk: 0, trkCmd: 0, bankFF: 0, dtg: 0, brgTo: 0, toIdent: '', fromIdent: '', disco: false, endOfRoute: true, approach: false, ete: 0 };
  }

  reset() {
    this.segIdx = 0;
    this.segLegUid = -1;
    this.hold = null;
    this.goAround = false;
    this.trans = null;
    this.desSpdCap = 999;
  }

  /** Remaining distance on the active leg. */
  activeDtg(): number | null {
    return this.lnav.valid ? this.lnav.dtg : null;
  }

  updateLnav(plan: FlightPlan, ac: AcState): void {
    const out = this.emptyLnav();
    let leg = plan.legs[plan.activeIdx];
    if (!leg) { this.lnav = out; return; }
    if (leg.uid !== this.segLegUid) {
      this.segLegUid = leg.uid;
      this.segIdx = 0;
      if (!isHold(leg)) this.hold = null;
    }
    const prevFix = plan.prevFixLeg(plan.activeIdx);
    out.fromIdent = leg.ppos ? '(PPOS)' : prevFix?.fix?.ident ?? '';
    out.toIdent = legDisplayIdent(leg);
    out.approach = leg.seg === 'APP';
    out.endOfRoute = false;
    if (leg.pt === 'DISCO') {
      out.disco = true;
      out.toIdent = '';
      out.trkCmd = ac.trk;
      out.dtk = ac.trk;
      this.lnav = out;
      return;
    }
    const geo = leg.geo;
    if (!geo) { this.lnav = out; return; }

    if (isHold(leg)) {
      this.holdGuidance(plan, leg, ac, out);
      this.lnav = out;
      return;
    }

    const segs = geo.segs;
    if (segs.length === 0) {
      // Zero-length leg (IF or already at fix) - sequence immediately when airborne
      out.valid = true;
      out.dtk = ac.trk;
      out.trkCmd = ac.trk;
      out.dtg = leg.fix ? distance(ac.pos, leg.fix) : 0;
      out.brgTo = leg.fix ? bearing(ac.pos, leg.fix) : ac.trk;
      if (!ac.onGround) {
        if (leg.fix && out.dtg > 0.3 && leg.pt !== 'IF') {
          out.dtk = out.brgTo;
          out.trkCmd = out.brgTo;
        } else this.sequence(plan);
      }
      this.lnav = out;
      return;
    }
    // Advance through segments
    while (this.segIdx < segs.length - 1) {
      const s = segs[this.segIdx];
      const prog = segProgress(s, ac.pos);
      const len = segLength(s);
      const next = segs[this.segIdx + 1];
      const ta = turnAnticipation(segEndCourse(s), segStartCourse(next), ac.gs, planBank(ac.alt));
      if (prog.along >= len - Math.min(ta, len * 0.8)) this.segIdx++;
      else break;
    }
    const seg = segs[this.segIdx];
    const prog = segProgress(seg, ac.pos);
    let remaining = Math.max(0, segLength(seg) - prog.along);
    for (let k = this.segIdx + 1; k < segs.length; k++) remaining += segLength(segs[k]);
    out.valid = true;
    out.dtk = prog.dtk;
    out.xtk = prog.xtk;
    out.dtg = remaining;
    out.brgTo = bearing(ac.pos, geo.end);
    out.bankFF = prog.bankFF(ac.tas);
    // Heading/course legs fly the course without cross-track correction once established
    // Procedure direct-to-fix legs are flown direct from present position
    if (leg.pt === 'DF' && !leg.ppos && leg.fix) {
      out.dtk = bearing(ac.pos, leg.fix);
      out.xtk = 0;
      out.bankFF = 0;
    }
    // Fly-by transition arc onto this leg
    if (this.trans && this.trans.uid === leg.uid) {
      const t = this.trans;
      const d = distance(t.c, ac.pos);
      const brg = bearing(t.c, ac.pos);
      const tdtk = norm360(brg + 90 * t.dir);
      if (angDiff(tdtk, t.outCrs) * t.dir <= 1 || Math.abs(d - t.r) > t.r) this.trans = null;
      else {
        out.dtk = tdtk;
        out.xtk = t.dir > 0 ? t.r - d : d - t.r;
        out.bankFF = t.dir * Math.atan((ac.tas * 0.5144) ** 2 / (9.81 * t.r * 1852)) * R2D;
      }
    }
    const headingLeg = ['VA', 'VI', 'VM', 'VD', 'VR'].includes(leg.pt);
    const courseLeg = ['CA', 'CI', 'CD', 'CR', 'FA', 'FM', 'FC', 'FD'].includes(leg.pt);
    const lookahead = clamp((ac.gs / 60) * 0.6, 0.8, 4);
    let intcp = -Math.atan2(out.xtk, lookahead) * R2D;
    intcp = clamp(intcp, -45, 45);
    if (headingLeg && leg.crs != null) {
      const hdgT = magToTrue(leg.crs, ac.pos.lat, ac.pos.lon);
      out.dtk = hdgT;
      out.trkCmd = hdgT; // heading legs: flown as a heading, no wind correction
      out.hdgLeg = true;
      out.xtk = 0;
      out.bankFF = 0;
    } else if (courseLeg && leg.pt !== 'FC' && leg.pt !== 'FD' && this.segIdx === segs.length - 1 && leg.crs != null) {
      out.trkCmd = out.dtk;
    } else {
      out.trkCmd = norm360(out.dtk + intcp);
    }

    // ---- Sequencing
    if (ac.onGround) { this.lnav = out; return; }
    const next = plan.legs[plan.activeIdx + 1];
    let seq = false;
    switch (leg.pt) {
      case 'CA':
      case 'VA':
      case 'FA':
        if (ac.alt >= (geo.endAlt ?? leg.alt?.a1 ?? 0) - 40) seq = true;
        break;
      case 'VM':
      case 'FM':
        seq = false;
        break;
      case 'CI':
      case 'VI': {
        if (next?.geo && next.geo.segs.length) {
          const np = segProgress(next.geo.segs[0], ac.pos);
          const delta = Math.abs(angDiff(out.dtk, np.dtk));
          const R = turnRadius(ac.tas);
          const capture = R * (1 - Math.cos(Math.min(90, delta) * D2R)) + 0.1;
          if (Math.abs(np.xtk) <= capture || remaining < 0.1) seq = true;
        } else if (remaining < 0.1) seq = true;
        break;
      }
      default: {
        let ta = 0;
        if (!leg.flyover && next && next.pt !== 'DISCO' && next.geo) {
          const nc = next.geo.segs.length ? segStartCourse(next.geo.segs[0]) : next.geo.crsIn;
          ta = turnAnticipation(geo.crsOut, nc, ac.gs, planBank(ac.alt));
          if (isHold(next)) ta = 0;
        }
        // Do not sequence past the MAP unless going around
        if (leg.map && !this.goAround && !plan.missedActive) {
          seq = false;
          break;
        }
        if (remaining <= Math.max(ta, 0.05)) {
          seq = true;
          if (ta > 0.2 && next?.geo && leg.fix && !leg.flyover && next.pt !== 'DF') {
            const nc = next.geo.segs.length ? segStartCourse(next.geo.segs[0]) : next.geo.crsIn;
            const dir = angDiff(geo.crsOut, nc) >= 0 ? 1 : -1;
            const r = turnRadius(Math.max(120, ac.gs), planBank(ac.alt));
            const t1 = destination(geo.end, norm360(geo.crsOut + 180), ta);
            this.trans = { uid: next.uid, c: destination(t1, norm360(geo.crsOut + 90 * dir), r), r, dir, outCrs: nc };
          }
        }
      }
    }
    out.ete = ac.gs > 30 ? (remaining / ac.gs) * 3600 : 0;
    this.lnav = out;
    if (seq) this.sequence(plan);
  }

  private sequence(plan: FlightPlan) {
    const cur = plan.legs[plan.activeIdx];
    if (plan.activeIdx >= plan.legs.length - 1) {
      // End of the flight plan
      this.lnav.endOfRoute = true;
      return;
    }
    if (cur?.map) plan.missedActive = true;
    if (cur?.spd && cur.spd.t !== 'AB' && (cur.seg === 'STAR' || cur.seg === 'APP')) this.desSpdCap = Math.min(this.desSpdCap, cur.spd.kt);
    if (cur?.seg === 'SID' || plan.missedActive) this.desSpdCap = 999;
    plan.activeIdx++;
    // Until the next guidance pass, the remaining distance is the new leg's length
    this.lnav = { ...this.lnav, dtg: plan.legs[plan.activeIdx]?.geo?.length ?? 0 };
    this.segIdx = 0;
    this.segLegUid = plan.legs[plan.activeIdx]?.uid ?? -1;
    this.onSequence?.(plan.activeIdx);
  }

  // -------------------------------------------------------------------------
  private holdGuidance(plan: FlightPlan, leg: FPLeg, ac: AcState, out: LnavOut) {
    const fix = leg.fix!;
    const hs = leg.hold!;
    const inb = magToTrue(hs.inbound, fix.lat, fix.lon);
    const s = hs.turn === 'R' ? 1 : -1;
    const R = turnRadius(ac.tas);
    const L = holdLegLength(leg, ac.tas, ac.alt);
    const n = norm360(inb + 90 * s); // toward holding side
    const c1 = destination(fix, n, R);
    const o1 = destination(fix, n, 2 * R);
    const o2 = destination(o1, inb + 180, L);
    const c2 = destination(o2, norm360(n + 180), R);
    const i1 = destination(fix, inb + 180, L);
    out.valid = true;
    out.toIdent = fix.ident;
    out.brgTo = bearing(ac.pos, fix);
    out.dtg = distance(ac.pos, fix);

    if (!this.hold || this.hold.uid !== leg.uid) {
      // Arriving at the fix region: fly to the fix first if far away
      const d = angDiff(inb, ac.trk) * s;
      const entry = d >= -70 && d <= 110 ? 'DIRECT' : d > 110 ? 'TEARDROP' : 'PARALLEL';
      this.hold = { uid: leg.uid, phase: 'ENTRY_DIRECT', entry, phaseStart: ac.pos, circuits: 0, turnAccum: 0, lastHdg: ac.trk };
      if (out.dtg > 1.5) this.hold.phase = 'ENTRY_DIRECT';
      else this.startEntry(ac, entry);
    }
    const h = this.hold;
    const steerLine = (a: LatLon, crs: number) => {
      const xtk = crossTrackCourse(a, crs, ac.pos);
      const look = clamp((ac.gs / 60) * 0.6, 0.8, 3);
      out.dtk = crs;
      out.xtk = xtk;
      out.trkCmd = norm360(crs - clamp(Math.atan2(xtk, look) * R2D, -45, 45));
    };
    const steerArc = (c: LatLon) => {
      const d = distance(c, ac.pos);
      const brg = bearing(c, ac.pos);
      out.dtk = norm360(brg + 90 * s);
      const xtk = s > 0 ? R - d : d - R;
      out.xtk = xtk;
      const look = clamp((ac.gs / 60) * 0.5, 0.6, 2);
      out.trkCmd = norm360(out.dtk - clamp(Math.atan2(xtk, look) * R2D, -45, 45));
      out.bankFF = s * Math.atan((ac.tas * 0.5144) ** 2 / (9.81 * R * 1852)) * R2D;
      out.turnDir = s > 0 ? 'R' : 'L';
    };
    const turned = () => {
      const dh = angDiff(h.lastHdg, ac.trk);
      h.lastHdg = ac.trk;
      h.turnAccum += dh * s;
      return h.turnAccum;
    };
    out.holdEntry = h.entry;
    switch (h.phase) {
      case 'ENTRY_DIRECT': {
        out.dtk = out.brgTo;
        out.trkCmd = out.brgTo;
        if (out.dtg < 0.3 || (out.dtg < 1.5 && Math.abs(angDiff(ac.trk, out.brgTo)) > 90)) {
          const d = angDiff(inb, ac.trk) * s;
          h.entry = d >= -70 && d <= 110 ? 'DIRECT' : d > 110 ? 'TEARDROP' : 'PARALLEL';
          this.startEntry(ac, h.entry);
        }
        break;
      }
      case 'TEARDROP': {
        const hdg = norm360(inb + 180 - 30 * s);
        out.dtk = hdg;
        out.trkCmd = hdg;
        out.hdgLeg = true;
        if (distance(h.phaseStart, ac.pos) >= Math.max(L, 2.5 * R)) this.setPhase(ac, 'TURN2');
        break;
      }
      case 'PARALLEL_OUT': {
        steerLine(fix, norm360(inb + 180));
        out.trkCmd = norm360(inb + 180);
        if (distance(h.phaseStart, ac.pos) >= L) this.setPhase(ac, 'PARALLEL_BACK');
        break;
      }
      case 'PARALLEL_BACK': {
        out.dtk = out.brgTo;
        out.trkCmd = out.brgTo;
        out.turnDir = s > 0 ? 'L' : 'R';
        if (out.dtg < 0.3) this.setPhase(ac, 'TURN1');
        break;
      }
      case 'TURN1': {
        steerArc(c1);
        if (turned() >= 170) this.setPhase(ac, 'OUTBOUND');
        break;
      }
      case 'OUTBOUND': {
        steerLine(o1, norm360(inb + 180));
        const along = alongTrackCourse(o1, norm360(inb + 180), ac.pos);
        if (along >= L) this.setPhase(ac, 'TURN2');
        break;
      }
      case 'TURN2': {
        steerArc(c2);
        // complete when established toward the inbound course
        const t = turned();
        if (t >= 170 || (t > 90 && Math.abs(angDiff(ac.trk, inb)) < 20)) this.setPhase(ac, 'INBOUND');
        break;
      }
      case 'INBOUND': {
        steerLine(i1, inb);
        const along = alongTrackCourse(fix, inb, ac.pos);
        if (along >= -Math.min(0.2, R * 0.15)) {
          h.circuits++;
          const exit = (leg.pt === 'HM' && hs.exitArmed) || (leg.pt === 'HF' && h.circuits >= 1) || (leg.pt === 'HA' && ac.alt >= (leg.alt?.a1 ?? 0) - 100) || hs.exitArmed;
          if (exit) {
            this.hold = null;
            this.sequence(plan);
            return;
          }
          this.setPhase(ac, 'TURN1');
        }
        break;
      }
    }
    out.holdState = h.phase;
    out.dtg = distance(ac.pos, fix);
    void c2; void o2; void i1;
  }

  private startEntry(ac: AcState, entry: HoldRt['entry']) {
    if (!this.hold) return;
    this.hold.entry = entry;
    this.setPhase(ac, entry === 'DIRECT' ? 'TURN1' : entry === 'TEARDROP' ? 'TEARDROP' : 'PARALLEL_OUT');
  }
  private setPhase(ac: AcState, p: HoldPhase) {
    if (!this.hold) return;
    this.hold.phase = p;
    this.hold.phaseStart = ac.pos;
    this.hold.turnAccum = 0;
    this.hold.lastHdg = ac.trk;
  }

  holdInfo(): { phase: string; entry: string } | null {
    return this.hold ? { phase: this.hold.phase, entry: this.hold.entry } : null;
  }

  // -------------------------------------------------------------------------
  updateVnav(plan: FlightPlan, ac: AcState, pred: Predictions | null, perf: PerfParams, flightPhase: string): void {
    const v: VnavOut = { valid: false, phase: 'PRE', tgtAlt: perf.crzAlt, pathAlt: null, pathAngle: perf.vpa, vsCmd: null, tgtIas: 250, tgtMach: perf.clbMach, useMach: false, vdev: null, todDist: null };
    const leg = plan.legs[plan.activeIdx];
    if (!pred || !pred.valid || !leg) { this.vnav = v; return; }
    v.valid = true;
    const s = this.traveledSincePred;
    const todDist = pred.tod ? pred.tod.dist - s : null;
    v.todDist = todDist;
    const inApp = leg.seg === 'APP' || leg.seg === 'MAP';
    if (ac.onGround && flightPhase !== 'TAKEOFF') v.phase = 'PRE';
    else if (flightPhase === 'TAKEOFF' || flightPhase === 'CLIMB') v.phase = 'CLB';
    else if (flightPhase === 'CRUISE') v.phase = 'CRZ';
    else v.phase = inApp ? 'APP' : 'DES';

    // Next constraints along the route
    let nextCap: number | null = null;
    let nextFloor: number | null = null;
    for (let i = plan.activeIdx; i < plan.legs.length; i++) {
      const l = plan.legs[i];
      if (l.seg === 'MAP' && !plan.missedActive) break;
      if (!l.alt) continue;
      if (v.phase === 'CLB' || v.phase === 'PRE') {
        if ((l.alt.t === 'BL' || l.alt.t === 'AT' || l.alt.t === 'WIN') && l.alt.a1 > ac.alt - 100 && nextCap == null) nextCap = l.alt.a1;
      } else {
        const fl = l.alt.t === 'WIN' ? l.alt.a2! : l.alt.t === 'AB' || l.alt.t === 'AT' ? l.alt.a1 : null;
        if (fl != null && nextFloor == null && fl < ac.alt + 100) nextFloor = fl;
        if (nextFloor != null) break;
      }
    }
    if (v.phase === 'CLB' || v.phase === 'PRE') {
      v.tgtAlt = Math.min(perf.crzAlt || 41000, nextCap ?? 99999);
    } else if (v.phase === 'CRZ') {
      v.tgtAlt = perf.crzAlt;
    } else {
      v.tgtAlt = nextFloor ?? (pred.path.length ? pred.path[pred.path.length - 1].alt : 0);
    }

    // Path
    if (pred.path.length >= 2 && (v.phase === 'DES' || v.phase === 'APP' || (v.phase === 'CRZ' && todDist != null && todDist < 5))) {
      const p = pathAt(pred.path, s);
      if (p) {
        v.pathAlt = p.alt;
        v.pathAngle = p.angle;
        v.vdev = ac.alt - p.alt;
        const vsPath = -ac.gs * 101.27 * Math.tan(p.angle * D2R);
        v.vsCmd = clamp(vsPath - clamp((ac.alt - p.alt) * 2.2, -1200, 1200), -4500, 500);
      }
    }

    // Speed targets
    const xoverC = crossoverAlt(perf.clbIas, perf.clbMach);
    const xoverD = crossoverAlt(perf.desIas, perf.desMach);
    let ias = 250, useMach = false, mach = 0;
    if (v.phase === 'CLB' || v.phase === 'PRE') {
      ias = ac.alt < perf.clbLimAlt - 20 ? perf.clbLimIas : perf.clbIas;
      if (ac.alt > xoverC) { useMach = true; mach = perf.clbMach; ias = machToCasG(mach, ac.alt); }
    } else if (v.phase === 'CRZ') {
      if (ac.alt > xoverC - 2000) { useMach = true; mach = perf.crzMach; ias = machToCasG(mach, ac.alt); }
      else ias = perf.clbIas;
    } else if (v.phase === 'DES') {
      ias = ac.alt < perf.desLimAlt + 1500 ? perf.desLimIas : perf.desIas;
      if (ac.alt > xoverD) { useMach = true; mach = perf.desMach; ias = machToCasG(mach, ac.alt); }
    } else {
      // Approach
      const pastFaf = this.pastFaf(plan);
      ias = pastFaf ? perf.vapp : leg.faf || nextIsFaf(plan) ? 180 : 210;
    }
    // Speed constraints: climb constraints apply on the leg to the fix; descent
    // constraints are met at the fix (decelerate in time) and then held.
    const descending = v.phase === 'DES' || v.phase === 'APP';
    if (descending) ias = Math.min(ias, this.desSpdCap);
    if (leg.spd && leg.spd.t !== 'AB') {
      const curIas = Math.round(Math.max(ac.ias, ias));
      const decelNm = (Math.max(0, curIas - leg.spd.kt) / 0.6) * (ac.gs / 3600) + 1.5;
      const climbing = v.phase === 'CLB' || v.phase === 'PRE';
      if (climbing || (this.lnav.valid && this.lnav.dtg <= decelNm)) ias = Math.min(ias, leg.spd.kt);
    }
    if (useMach && casToMach(ias, ac.alt) < mach - 0.005) useMach = false;
    if (plan.missedActive || this.goAround) { ias = Math.max(perf.vapp + 20, 180); useMach = false; }
    v.tgtIas = Math.round(ias);
    v.tgtMach = mach;
    v.useMach = useMach;
    this.vnav = v;
  }

  private pastFaf(plan: FlightPlan): boolean {
    for (let i = plan.activeIdx - 1; i >= 0; i--) {
      const l = plan.legs[i];
      if (l.seg !== 'APP') return false;
      if (l.faf) return true;
    }
    return false;
  }
}

function nextIsFaf(plan: FlightPlan): boolean {
  const l = plan.legs[plan.activeIdx];
  return !!l?.faf;
}

export function pathAt(path: { s: number; alt: number }[], s: number): { alt: number; angle: number } | null {
  if (!path.length) return null;
  if (s <= path[0].s) {
    const b = path[1] ?? path[0];
    const ang = b.s > path[0].s ? Math.atan((path[0].alt - b.alt) / ((b.s - path[0].s) * 6076.12)) * R2D : 0;
    return { alt: path[0].alt, angle: ang };
  }
  for (let k = 1; k < path.length; k++) {
    if (s <= path[k].s) {
      const a = path[k - 1], b = path[k];
      const f = (s - a.s) / Math.max(1e-6, b.s - a.s);
      const ang = Math.atan((a.alt - b.alt) / Math.max(1e-6, (b.s - a.s) * 6076.12)) * R2D;
      return { alt: a.alt + (b.alt - a.alt) * f, angle: ang };
    }
  }
  return { alt: path[path.length - 1].alt, angle: 0 };
}

export function turnAnticipation(crsOut: number, nextCrsIn: number, gs: number, bank = 20): number {
  const delta = Math.abs(angDiff(crsOut, nextCrsIn));
  if (delta < 1) return 0;
  const R = turnRadius(Math.max(120, gs), bank);
  return Math.min(R * Math.tan((Math.min(delta, 120) / 2) * D2R), 12);
}

function segStartCourse(s: PathSeg): number {
  if (s.type === 'line') return bearing(s.a, s.b);
  return norm360(s.start + (s.sweep >= 0 ? 90 : -90));
}
function segEndCourse(s: PathSeg): number {
  if (s.type === 'line') return norm360(bearing(s.b, s.a) + 180);
  return norm360(s.start + s.sweep + (s.sweep >= 0 ? 90 : -90));
}

interface SegProg {
  along: number;
  xtk: number;
  dtk: number;
  bankFF: (tas: number) => number;
}

export function segProgress(s: PathSeg, p: LatLon): SegProg {
  if (s.type === 'line') {
    const len = distance(s.a, s.b);
    if (len < 1e-3) return { along: 0, xtk: 0, dtk: bearing(p, s.b), bankFF: () => 0 };
    const xtk = crossTrack(s.a, s.b, p);
    const along = alongTrack(s.a, s.b, p);
    // Desired track at the abeam point
    const f = clamp(along / len, 0, 1);
    const abeam = destination(s.a, bearing(s.a, s.b), f * len);
    const dtk = f < 0.999 ? bearing(abeam, s.b) : norm360(bearing(s.b, s.a) + 180);
    return { along, xtk, dtk, bankFF: () => 0 };
  }
  const dir = s.sweep >= 0 ? 1 : -1;
  const d = distance(s.c, p);
  const brg = bearing(s.c, p);
  const ang = angDiff(s.start, brg) * dir; // degrees travelled
  const along = clamp(ang, -10, Math.abs(s.sweep) + 30) * D2R * s.r;
  const xtk = dir > 0 ? s.r - d : d - s.r;
  const dtk = norm360(brg + 90 * dir);
  return {
    along,
    xtk,
    dtk,
    bankFF: (tas: number) => dir * Math.atan((tas * 0.5144) ** 2 / (9.81 * s.r * 1852)) * R2D,
  };
}
