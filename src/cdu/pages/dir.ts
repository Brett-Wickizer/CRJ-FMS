// DIR-INTC, HOLD and FIX INFO pages.
import { Page, registerPage, Side, Cdu } from '../cdu';
import type { Screen } from '../screen';
import { boxes, dashes } from '../screen';
import { fms } from '../../fms/fms';
import { endsAtFix, isHold, legDisplayIdent } from '../../fms/flightplan';
import type { FPLeg, HoldSpec } from '../../fms/types';
import type { Waypoint } from '../../nav/navdb';
import { LatLon, bearing, distance, norm360, angDiff, intersection, crossTrackCourse, alongTrack, crossTrack, destination } from '../../util/geo';
import { trueToMag, magToTrue } from '../../util/magvar';
import { fmtCrs, fmtDist, fmtEte, fmtZulu, parseCourse, parseZulu, fmtAlt } from '../fmt';
import { actMod, cancelModPrompt, prompt } from './common';
import { segLength } from '../../fms/geometry';
import { pointOnSeg } from '../../fms/predict';

// ---------------------------------------------------------------------------
class DirIntcPage extends Page {
  live = true;
  private list(): { idx: number; leg: FPLeg }[] {
    const p = fms.plan;
    const out: { idx: number; leg: FPLeg }[] = [];
    for (let i = Math.max(1, p.activeIdx); i < p.legs.length; i++) {
      const l = p.legs[i];
      if (l.fix && endsAtFix(l) && !isHold(l) && l.fix.ident !== 'PPOS') out.push({ idx: i, leg: l });
    }
    return out;
  }
  update() {
    this.pages = Math.max(1, Math.ceil(this.list().length / 4));
    if (this.page > this.pages) this.page = this.pages;
  }
  render(s: Screen) {
    s.title('DIR-INTC', this.page, this.pages);
    s.label(1, 'DIRECT TO', 'INTC CRS');
    s.line(1, `{w}${boxes(5)}`, `{w}---°`);
    const items = this.list().slice((this.page - 1) * 4, this.page * 4);
    items.forEach((it, k) => {
      const n = k + 2;
      const active = fms.plan === fms.active && it.idx === fms.plan.activeIdx;
      s.line(n, `{w}<{${active ? 'm' : 'g'}}${it.leg.fix!.ident}`, '{w}---°>');
    });
    if (!cancelModPrompt(s)) s.line(6, prompt('LEGS', 'L'));
  }
  lsk(side: Side, n: number) {
    const cdu = this.cdu;
    if (n === 6) {
      if (side === 'L') { if (fms.isMod) fms.cancelMod(); else cdu.show('LEGS'); }
      return;
    }
    if (!fms.posInit) { cdu.error('INITIALIZE POSITION'); return; }
    const ppos = { ...fms.ac.pos };
    const go = (w: Waypoint, intc?: number) => {
      fms.editPlan().directTo(w, ppos, intc);
      cdu.show('LEGS');
    };
    if (n === 1) {
      if (!cdu.hasEntry) { cdu.error('INVALID ENTRY'); return; }
      const t = cdu.take();
      if (side === 'R') { cdu.error('ENTER WAYPOINT'); return; }
      cdu.resolveWaypoint(t, fms.ac.pos, (w) => go(w));
      return;
    }
    const it = this.list().slice((this.page - 1) * 4, this.page * 4)[n - 2];
    if (!it) { cdu.error('INVALID ENTRY'); return; }
    if (side === 'L') { go(it.leg.fix!); return; }
    const crs = parseCourse(cdu.take());
    if (crs == null) { cdu.error('INVALID ENTRY'); return; }
    go(it.leg.fix!, crs);
  }
}
registerPage('DIR', (c) => new DirIntcPage(c));

// ---------------------------------------------------------------------------
function quadrant(radial: number): string {
  const q = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return q[Math.round(norm360(radial) / 45) % 8];
}

function holdEntryFor(plan: typeof fms.plan, idx: number): string {
  const leg = plan.legs[idx];
  if (!leg?.hold || !leg.fix) return '';
  const g = fms.guidance.holdInfo();
  if (plan === fms.active && idx === plan.activeIdx && g) return g.entry;
  const prev = plan.legs[idx - 1];
  const trk = prev?.geo?.crsOut ?? bearing(fms.ac.pos, leg.fix);
  const inb = magToTrue(leg.hold.inbound, leg.fix.lat, leg.fix.lon);
  const d = angDiff(inb, trk) * (leg.hold.turn === 'R' ? 1 : -1);
  return d >= -70 && d <= 110 ? 'DIRECT' : d > 110 ? 'TEARDROP' : 'PARALLEL';
}

const maxHoldSpeed = (alt: number) => (alt <= 6000 ? 200 : alt <= 14000 ? 230 : 265);

class HoldPage extends Page {
  live = true;
  private newHold = false;
  private holdIdx(): number {
    if (this.newHold) return -1;
    const p = fms.plan;
    for (let i = Math.max(1, p.activeIdx); i < p.legs.length; i++) {
      const l = p.legs[i];
      // Missed approach holds only count once the missed approach is flown
      if (isHold(l) && (l.seg !== 'MAP' || p.missedActive)) return i;
    }
    return -1;
  }
  render(s: Screen) {
    const p = fms.plan;
    const i = this.holdIdx();
    if (i < 0) {
      s.title('HOLD', 1, 1);
      s.label(1, 'HOLD AT');
      s.line(1, `{w}${boxes(5)}`, '{w}PPOS>');
      const holds = p.legs.filter((l, k) => k >= p.activeIdx && isHold(l));
      if (holds.length) s.label(3, `HOLDS IN FPLN: ${holds.map((h) => h.fix?.ident).join(' ')}`);
      if (!cancelModPrompt(s)) s.line(6, prompt('LEGS', 'L'));
      return;
    }
    const leg = p.legs[i];
    const h = leg.hold!;
    const active = p === fms.active && i === p.activeIdx;
    s.title(actMod('HOLD'), 1, 1);
    s.label(1, 'HOLD FIX', 'ENTRY');
    s.line(1, leg.fix?.ident ?? '', active ? (fms.guidance.holdInfo()?.entry ?? holdEntryFor(p, i)) : holdEntryFor(p, i), { color: active ? 'm' : 'g' });
    if (active) s.left(2, leg.fix?.ident ?? '', { color: 'm' });
    const radial = norm360(h.inbound + 180);
    s.label(2, 'QUAD/RADIAL', 'INBD CRS/DIR');
    s.line(2, `${quadrant(radial)}/${fmtCrs(radial)}`, `${fmtCrs(h.inbound)}/${h.turn} TURN`);
    s.label(3, 'LEG TIME', 'LEG DIST');
    s.line(3, h.legDist ? '{s}' + ((h.legDist / Math.max(150, fms.ac.tas || 200)) * 60).toFixed(1) + ' MIN' : `${(h.legTime ?? 1).toFixed(1)} MIN`, h.legDist ? `${h.legDist.toFixed(1)} NM` : `{s}${(((h.legTime ?? 1) * Math.max(150, fms.ac.tas || 200)) / 60).toFixed(1)} NM`);
    s.label(4, 'EFC TIME', 'HOLD SPD');
    const alt = leg.pred?.alt ?? fms.ac.alt;
    s.line(4, h.efc ? `${h.efc}Z` : `{w}----Z`, h.spd ? String(h.spd) : `{s}${maxHoldSpeed(alt)}`);
    s.label(5, leg.pt === 'HM' ? 'MANUAL TERM' : leg.pt === 'HF' ? 'ONE TURN' : 'TO ALTITUDE', active ? 'HOLD STATUS' : '');
    if (active) s.line(5, '', fms.guidance.holdInfo()?.phase.replace('_', ' ') ?? '', { small: true });
    s.line(6, prompt('NEW HOLD', 'L'), active ? (h.exitArmed ? prompt('CANCEL EXIT', 'R') : prompt('EXIT HOLD', 'R')) : '');
    if (fms.isMod) s.line(6, '{w}<CANCEL MOD');
  }
  lsk(side: Side, n: number) {
    const cdu = this.cdu;
    const i = this.holdIdx();
    if (i < 0) {
      if (n === 1) {
        if (side === 'R') {
          const e = fms.editPlan();
          e.insertHoldPpos({ ...fms.ac.pos }, { inbound: Math.round(trueToMag(fms.ac.trk, fms.ac.pos.lat, fms.ac.pos.lon)) || 360, turn: 'R', legTime: fms.ac.alt > 14000 ? 1.5 : 1 });
          this.newHold = false;
          return;
        }
        if (!cdu.hasEntry) { cdu.error('INVALID ENTRY'); return; }
        const t = cdu.take();
        cdu.resolveWaypoint(t, fms.ac.pos, (w) => this.createHold(w));
        return;
      }
      if (n === 6 && side === 'L') { if (fms.isMod) fms.cancelMod(); else cdu.show('LEGS'); return; }
      cdu.error('INVALID ENTRY');
      return;
    }
    const p = fms.plan;
    const active = p === fms.active && i === p.activeIdx;
    if (n === 6) {
      if (side === 'L') {
        if (fms.isMod) { fms.cancelMod(); return; }
        this.newHold = true;
        return;
      }
      if (active) {
        const h = fms.active.legs[i].hold!;
        h.exitArmed = !h.exitArmed;
        fms.changed();
      }
      return;
    }
    if (cdu.isDelete && n === 1 && side === 'L') {
      cdu.take();
      const e = fms.editPlan();
      e.legs.splice(i, 1);
      e.touch();
      return;
    }
    if (n === 1 && side === 'L' && cdu.hasEntry) {
      // A new holding fix entered over the current one creates another hold
      const t = cdu.take();
      cdu.resolveWaypoint(t, fms.ac.pos, (w) => this.createHold(w));
      return;
    }
    if (!cdu.hasEntry) { cdu.error('INVALID ENTRY'); return; }
    const t = cdu.take().trim().toUpperCase();
    const e = fms.editPlan();
    const h: HoldSpec = e.legs[i].hold!;
    const bad = () => cdu.error('INVALID ENTRY');
    const key = side + n;
    if (key === 'R2') {
      const m = /^(\d{1,3})?(?:\/([LR]))?$/.exec(t);
      if (!m || (!m[1] && !m[2])) return bad();
      if (m[1]) { const c = parseCourse(m[1]); if (c == null) return bad(); h.inbound = c; }
      if (m[2]) h.turn = m[2] as 'L' | 'R';
    } else if (key === 'L2') {
      const m = /^(?:[NSEW]{1,2}\/)?(\d{1,3})$/.exec(t);
      if (!m) return bad();
      const r = parseCourse(m[1]);
      if (r == null) return bad();
      h.inbound = norm360(r + 180) || 360;
    } else if (key === 'L3') {
      const v = parseFloat(t);
      if (!(v >= 0.5 && v <= 9.9)) return bad();
      h.legTime = v; h.legDist = undefined;
    } else if (key === 'R3') {
      const v = parseFloat(t);
      if (!(v >= 1 && v <= 30)) return bad();
      h.legDist = v;
    } else if (key === 'L4') {
      const z = parseZulu(t);
      if (z == null) return bad();
      h.efc = t.replace('Z', '');
    } else if (key === 'R4') {
      const v = parseInt(t, 10);
      if (!(v >= 150 && v <= 300)) return bad();
      h.spd = v;
    } else return bad();
    e.touch();
  }

  private createHold(w: Waypoint) {
    const e = fms.editPlan();
    let idx = -1;
    for (let k = Math.max(1, e.activeIdx); k < e.legs.length; k++) {
      const l = e.legs[k];
      if (l.fix && endsAtFix(l) && l.fix.ident === w.ident && distance(l.fix, w) < 2 && !isHold(l)) { idx = k; break; }
    }
    if (idx < 0) {
      e.directTo(w, { ...fms.ac.pos });
      idx = e.activeIdx;
    }
    const spec = fms.defaultHold(idx);
    // defaultHold reads fms.plan (the MOD) for the inbound course
    e.insertHoldAt(idx, spec);
    this.newHold = false;
  }
}
registerPage('HOLD', (c) => new HoldPage(c));

// ---------------------------------------------------------------------------
interface CrossPt {
  pos: LatLon;
  dtg: number;
  alt: number | null;
}

/** Walk the active flight plan from the aircraft and return points with along-track distance. */
function* planSegments(): Generator<{ a: LatLon; b: LatLon; s0: number; seg: any; legIdx: number }> {
  const p = fms.active;
  let s = 0;
  let first = true;
  for (let i = Math.max(1, p.activeIdx); i < p.legs.length; i++) {
    const l = p.legs[i];
    if (l.seg === 'MAP') break;
    const g = l.geo;
    if (!g) continue;
    for (let k = 0; k < g.segs.length; k++) {
      const seg = g.segs[k];
      let a = seg.a;
      if (first && seg.type === 'line' && !fms.ac.onGround) {
        // start at the aircraft's abeam point on the active leg
        const len = distance(seg.a, seg.b);
        const at = Math.max(0, Math.min(len, alongTrack(seg.a, seg.b, fms.ac.pos)));
        a = destination(seg.a, bearing(seg.a, seg.b), at);
      }
      first = false;
      const b = seg.b;
      yield { a, b, s0: s, seg, legIdx: i };
      s += seg.type === 'line' ? distance(a, b) : segLength(seg);
    }
  }
}

function predAltAt(legIdx: number): number | null {
  return fms.active.legs[legIdx]?.pred?.alt ?? null;
}

function radialCross(ref: Waypoint, radialMag: number): CrossPt | null {
  const dec = ref.kind === 'VOR' && ref.dec != null ? ref.dec : null;
  const radT = dec != null ? norm360(radialMag + dec) : magToTrue(radialMag, ref.lat, ref.lon);
  for (const s of planSegments()) {
    if (s.seg.type !== 'line') continue;
    const x0 = crossTrackCourse(ref, radT, s.a);
    const x1 = crossTrackCourse(ref, radT, s.b);
    if (Math.sign(x0) === Math.sign(x1) && Math.abs(x0) > 1e-6) continue;
    const p = intersection(s.a, bearing(s.a, s.b), ref, radT);
    if (!p) continue;
    if (Math.abs(angDiff(bearing(ref, p), radT)) > 90) continue;
    return { pos: p, dtg: s.s0 + distance(s.a, p), alt: predAltAt(s.legIdx) };
  }
  return null;
}

function distCross(ref: Waypoint, d: number): CrossPt | null {
  for (const s of planSegments()) {
    const len = s.seg.type === 'line' ? distance(s.a, s.b) : segLength(s.seg);
    const at = (f: number) => (s.seg.type === 'line' ? destination(s.a, bearing(s.a, s.b), f * len) : pointOnSeg(s.seg, f * len));
    const d0 = distance(ref, at(0)) - d, d1 = distance(ref, at(1)) - d;
    if (Math.sign(d0) === Math.sign(d1)) continue;
    let lo = 0, hi = 1;
    for (let k = 0; k < 30; k++) {
      const m = (lo + hi) / 2;
      if (Math.sign(distance(ref, at(m)) - d) === Math.sign(d0)) lo = m; else hi = m;
    }
    return { pos: at(lo), dtg: s.s0 + lo * len, alt: predAltAt(s.legIdx) };
  }
  return null;
}

function abeam(ref: Waypoint): CrossPt | null {
  let best: CrossPt | null = null;
  let bx = Infinity;
  for (const s of planSegments()) {
    if (s.seg.type !== 'line') continue;
    const len = distance(s.a, s.b);
    const at = alongTrack(s.a, s.b, ref);
    if (at < 0 || at > len) continue;
    const x = Math.abs(crossTrack(s.a, s.b, ref));
    if (x < bx) { bx = x; best = { pos: destination(s.a, bearing(s.a, s.b), at), dtg: s.s0 + at, alt: predAltAt(s.legIdx) }; }
  }
  return best;
}

export interface FixInfoState {
  ref: Waypoint | null;
  radial: number | null;
  dist: number | null;
  abeam: boolean;
}
export const fixInfo: FixInfoState = { ref: null, radial: null, dist: null, abeam: false };

class FixInfoPage extends Page {
  live = true;
  render(s: Screen) {
    s.title('FIX INFO', 1, 1);
    const f = fixInfo;
    const res = (c: CrossPt | null) => {
      if (!c) return '{w}{s}NO CROSSING';
      const ete = fms.ac.gs > 50 ? fmtEte((c.dtg / fms.ac.gs) * 3600) : '-:--';
      return `${fmtDist(c.dtg)} ${ete} ${c.alt != null ? fmtAlt(c.alt) : ''}`.trim();
    };
    s.label(1, 'REF', 'CRS/DIST');
    if (f.ref) {
      const brgFrom = bearing(f.ref, fms.ac.pos);
      const dec = f.ref.kind === 'VOR' && f.ref.dec != null ? f.ref.dec : null;
      const rad = dec != null ? norm360(brgFrom - dec) : trueToMag(brgFrom, f.ref.lat, f.ref.lon);
      s.line(1, f.ref.ident, `${fmtCrs(rad)}/${fmtDist(distance(f.ref, fms.ac.pos))}`);
    } else s.line(1, `{w}${boxes(5)}`);
    s.label(2, 'RAD CROSS', 'DTG ETE ALT');
    s.line(2, f.radial != null ? fmtCrs(f.radial) : `{w}---°`, f.ref && f.radial != null ? res(radialCross(f.ref, f.radial)) : '');
    s.label(3, 'DIS CROSS');
    s.line(3, f.dist != null ? `${f.dist.toFixed(1)}` : `{w}---.-`, f.ref && f.dist != null ? res(distCross(f.ref, f.dist)) : '');
    s.label(4, 'ABEAM REF');
    s.line(4, f.abeam ? '{g}ON' : '{w}<ABEAM', f.ref && f.abeam ? res(abeam(f.ref)) : '');
    s.line(6, prompt('INDEX', 'L'));
    void dashes; void legDisplayIdent; void fmtZulu;
  }
  lsk(side: Side, n: number) {
    const cdu = this.cdu;
    const f = fixInfo;
    if (n === 6) { cdu.show('INDEX'); return; }
    if (cdu.isDelete) {
      cdu.take();
      if (n === 1) { f.ref = null; f.radial = null; f.dist = null; f.abeam = false; }
      if (n === 2) f.radial = null;
      if (n === 3) f.dist = null;
      if (n === 4) f.abeam = false;
      return;
    }
    if (side !== 'L') { cdu.error('INVALID ENTRY'); return; }
    if (n === 4) { if (!f.ref) { cdu.error('ENTER REF'); return; } f.abeam = !f.abeam; return; }
    const t = cdu.take();
    if (!t) { cdu.error('INVALID ENTRY'); return; }
    if (n === 1) { cdu.resolveWaypoint(t, fms.ac.pos, (w) => { f.ref = w; }); return; }
    if (!f.ref) { cdu.error('ENTER REF'); return; }
    if (n === 2) { const c = parseCourse(t); if (c == null) { cdu.error('INVALID ENTRY'); return; } f.radial = c; return; }
    if (n === 3) { const v = parseFloat(t); if (!(v > 0 && v < 500)) { cdu.error('INVALID ENTRY'); return; } f.dist = v; return; }
  }
}
registerPage('FIX', (c: Cdu) => new FixInfoPage(c));
