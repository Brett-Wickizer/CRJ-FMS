// FPLN, SEC FPLN and ROUTE MENU pages.
import { Page, registerPage, Side, Cdu } from '../cdu';
import type { Screen } from '../screen';
import { boxes, dashes } from '../screen';
import { fms } from '../../fms/fms';
import { navdb } from '../../nav/navdb';
import { FlightPlan, RouteElem, sameFix, newUid } from '../../fms/flightplan';
import { fmtDist } from '../fmt';
import { actMod, cancelModPrompt, prompt } from './common';

const ROWS_P1 = 2;
const ROWS_PN = 5;

abstract class FplnBase extends Page {
  protected pendingVia: string | null = null;
  abstract plan(): FlightPlan;
  abstract edit(): FlightPlan;
  abstract titleText(): string;
  abstract bottom(s: Screen): void;
  abstract bottomLsk(side: Side): void;

  /** Elements plus the trailing entry slot. */
  protected elems(): (RouteElem | null)[] {
    const p = this.plan();
    const list: (RouteElem | null)[] = p.routeElements();
    list.push(null);
    return list;
  }

  update() {
    const n = this.elems().length;
    this.pages = n <= ROWS_P1 ? 1 : 1 + Math.ceil((n - ROWS_P1) / ROWS_PN);
    if (this.page > this.pages) this.page = this.pages;
  }

  private slotIndex(n: number): number {
    // index into elems for LSK row n on the current page
    if (this.page === 1) return n >= 4 && n <= 5 ? n - 4 : -1;
    return n >= 1 && n <= 5 ? ROWS_P1 + (this.page - 2) * ROWS_PN + (n - 1) : -1;
  }

  render(s: Screen) {
    const p = this.plan();
    s.title(this.titleText(), this.page, this.pages);
    if (this.page === 1) {
      s.label(1, 'ORIGIN', 'DEST', 'DIST');
      s.line(1, p.origin ? p.origin.ident : `{w}${boxes(4)}`, p.dest ? p.dest.ident : `{w}${boxes(4)}`);
      const dist = p.totalDistance(p === fms.active && !fms.ac.onGround ? p.activeIdx : 1);
      if (p.origin && p.dest) s.center(2, `{s}${fmtDist(dist)}`, { color: 'g' });
      s.label(2, 'ROUTE', 'ALTN');
      s.line(2, p.routeName || `{w}${dashes(10)}`, p.altn ? p.altn.ident : `{w}${dashes(4)}`);
      s.label(3, 'ORIG RWY', 'FLT NO');
      s.line(3, p.origRwy ? 'RW' + p.origRwy.id : `{w}${dashes(5)}`, p.fltNo || `{w}${dashes(8)}`);
    }
    const elems = this.elems();
    let labelShown = false;
    for (let n = 1; n <= 5; n++) {
      const i = this.slotIndex(n);
      if (i < 0 || i >= elems.length) continue;
      const e = elems[i];
      if (!labelShown && !(e && e.disco)) { s.label(n, 'VIA', 'TO'); labelShown = true; }
      if (e === null) {
        if (!p.origin) continue;
        if (this.pendingVia) {
          s.line(n, this.pendingVia, `{w}${boxes(5)}`);
        } else s.line(n, `{w}${dashes(5)}`, `{w}${dashes(5)}`);
        continue;
      }
      if (e.disco) {
        s.label(n, '', '', '- DISCONTINUITY -');
        s.line(n, '', `{w}${boxes(5)}`);
        continue;
      }
      const active = p === fms.active && e.start <= p.activeIdx && e.end >= p.activeIdx;
      const via = e.via.length > 13 ? e.via.slice(0, 13) : e.via;
      s.line(n, via, e.to, { color: active ? 'm' : 'g' });
      if (active) s.left(n * 2, via, { color: 'g' });
    }
    this.bottom(s);
  }

  lsk(side: Side, n: number) {
    if (n === 6) { this.bottomLsk(side); return; }
    if (this.page === 1 && n <= 3) { this.topLsk(side, n); return; }
    const i = this.slotIndex(n);
    const elems = this.elems();
    if (i < 0 || i >= elems.length) { this.cdu.error('INVALID ENTRY'); return; }
    const e = elems[i];
    const cdu = this.cdu;
    if (cdu.isDelete) {
      cdu.take();
      if (e === null) { this.pendingVia = null; return; }
      const err = this.edit().deleteElement(this.mapElem(e));
      if (err) cdu.error(err);
      return;
    }
    if (!cdu.hasEntry) {
      if (e && !e.disco) cdu.setScratch(side === 'L' ? e.via : e.to);
      return;
    }
    const text = cdu.take().trim();
    if (side === 'L') this.viaEntry(text, e);
    else this.toEntry(text, e);
  }

  /** Map an element of the displayed plan onto the edit plan (indices are shared). */
  private mapElem(e: RouteElem): RouteElem {
    return e;
  }

  private viaEntry(text: string, e: RouteElem | null) {
    const cdu = this.cdu;
    const isAirway = navdb.hasAirway(text);
    if (text === 'DIRECT' || text === 'DCT') {
      if (e === null) { this.pendingVia = 'DIRECT'; return; }
      cdu.error('INVALID ENTRY');
      return;
    }
    if (!isAirway) { cdu.error('INVALID ENTRY'); return; }
    if (e === null) {
      const plan = this.edit();
      if (this.pendingVia && this.pendingVia !== 'DIRECT') {
        // Airway to airway: find the intersection automatically
        const from = plan.lastEnrouteFix();
        const x = from ? navdb.airwayIntersection(this.pendingVia, from, text) : null;
        if (!x || !from) { cdu.error('NO INTERSECTION'); return; }
        const w = navdb.findNear(x, from)[0];
        const err = plan.appendVia(this.pendingVia, w);
        if (err) { cdu.error(err); return; }
      } else {
        const from = plan.lastEnrouteFix();
        if (!from || !navdb.airwayContains(text, from.ident)) { cdu.error('NOT ON AIRWAY'); return; }
      }
      this.pendingVia = text.toUpperCase();
      return;
    }
    if (e.disco || e.seg !== 'ENR') { cdu.error('INVALID ENTRY'); return; }
    // Re-route an existing element along a different airway to the same TO fix
    const plan = this.edit();
    const startLeg = plan.legs[e.start];
    const prevFix = plan.prevFixLeg(e.start)?.fix;
    const toFix = plan.legs[e.end].fix;
    if (!prevFix || !toFix || !startLeg) { cdu.error('INVALID ENTRY'); return; }
    const pts = navdb.airwaySegment(text, prevFix, toFix.ident);
    if (!pts) { cdu.error('NOT ON AIRWAY'); return; }
    plan.legs.splice(e.start, e.end - e.start + 1, ...pts.map((w) => ({ uid: newUid(), pt: 'TF' as const, fix: w, seg: 'ENR' as const, via: text.toUpperCase() })));
    plan.touch();
  }

  private toEntry(text: string, e: RouteElem | null) {
    const cdu = this.cdu;
    const plan = this.edit();
    const ref = plan.lastEnrouteFix() ?? plan.origin ?? fms.ac.pos;
    cdu.resolveWaypoint(text, ref, (w) => {
      if (e === null) {
        const err = plan.appendVia(this.pendingVia ?? 'DIRECT', w);
        if (err) { cdu.error(err); return; }
        this.pendingVia = null;
        return;
      }
      if (e.disco) {
        const err = plan.insertWaypoint(e.start, w);
        if (err) cdu.error(err);
        return;
      }
      if (e.seg !== 'ENR') { cdu.error('INVALID ENTRY'); return; }
      const leg = plan.legs[e.end];
      if (e.start === e.end && leg.via === 'DIRECT') {
        leg.fix = w;
        const next = plan.legs[e.end + 1];
        if (next && next.seg === 'ENR' && next.via !== 'DIRECT' && !navdb.airwayContains(next.via, w.ident)) {
          plan.legs.splice(e.end + 1, 0, { uid: newUid(), pt: 'DISCO', seg: 'ENR', via: '' });
        }
        plan.touch();
        return;
      }
      // Airway element: change the exit fix along the same airway
      const prevFix = plan.prevFixLeg(e.start)?.fix;
      if (!prevFix) { cdu.error('INVALID ENTRY'); return; }
      const pts = navdb.airwaySegment(leg.via, prevFix, w.ident);
      if (!pts) { cdu.error('NOT ON AIRWAY'); return; }
      plan.legs.splice(e.start, e.end - e.start + 1, ...pts.map((p) => ({ uid: newUid(), pt: 'TF' as const, fix: p, seg: 'ENR' as const, via: leg.via })));
      const next = plan.legs[e.start + pts.length];
      if (next && next.pt !== 'DISCO' && next.seg === 'ENR' && !(next.fix && sameFix(next.fix, w))) {
        plan.legs.splice(e.start + pts.length, 0, { uid: newUid(), pt: 'DISCO', seg: 'ENR', via: '' });
      }
      plan.touch();
    });
  }

  private topLsk(side: Side, n: number) {
    const cdu = this.cdu;
    const key = side + n;
    if (!cdu.hasEntry && !cdu.isDelete) {
      const p = this.plan();
      const v = key === 'L1' ? p.origin?.ident : key === 'R1' ? p.dest?.ident : key === 'R2' ? p.altn?.ident : key === 'L3' ? (p.origRwy ? 'RW' + p.origRwy.id : '') : '';
      if (v) cdu.setScratch(v);
      return;
    }
    if (cdu.isDelete) {
      cdu.take();
      const p = this.edit();
      if (key === 'R2') { p.altn = null; p.touch(); return; }
      if (key === 'R3') { p.fltNo = ''; return; }
      if (key === 'L3') { p.setOrigRwy(null); return; }
      cdu.error('INVALID DELETE');
      return;
    }
    const text = cdu.take().trim().toUpperCase();
    switch (key) {
      case 'L1': {
        const apt = navdb.getAirport(text);
        if (!apt) { cdu.error('NOT IN DATA BASE'); return; }
        if (this.plan() === fms.active && !fms.ac.onGround && fms.active.origin) { cdu.error('NOT ALLOWED'); return; }
        const p = this.edit();
        p.setOrigin(apt);
        void navdb.ensureProcedures(apt.ident);
        if (!fms.posRefWpt) fms.posRefWpt = fms.aptWpt(apt);
        return;
      }
      case 'R1': {
        const apt = navdb.getAirport(text);
        if (!apt) { cdu.error('NOT IN DATA BASE'); return; }
        const p = this.edit();
        if (!p.origin) { cdu.error('ENTER ORIGIN'); return; }
        p.setDest(apt);
        void navdb.ensureProcedures(apt.ident);
        return;
      }
      case 'L2': {
        const saved = fms.savedRoutes().find((r) => r.name === text);
        const p = this.edit();
        if (saved) {
          void fms.loadRouteString(p, saved.route).then((err) => {
            if (err) cdu.error(err);
            p.routeName = text;
            cdu.render();
          });
          return;
        }
        if (!/^[A-Z0-9]{1,10}$/.test(text)) { cdu.error('INVALID ENTRY'); return; }
        p.routeName = text;
        return;
      }
      case 'R2': {
        const apt = navdb.getAirport(text);
        if (!apt) { cdu.error('NOT IN DATA BASE'); return; }
        const p = this.edit();
        p.altn = apt;
        p.touch();
        return;
      }
      case 'L3': {
        const p = this.edit();
        if (!p.origin) { cdu.error('ENTER ORIGIN'); return; }
        const id = text.replace(/^RW/, '');
        const rw = p.origin.runways.find((r) => r.id === id || r.id === id.padStart(2, '0') || r.id === '0' + id);
        if (!rw) { cdu.error('NOT IN DATA BASE'); return; }
        void navdb.ensureProcedures(p.origin.ident).then(() => { p.setOrigRwy(rw); cdu.render(); });
        return;
      }
      case 'R3': {
        if (!/^[A-Z0-9]{1,8}$/.test(text)) { cdu.error('INVALID ENTRY'); return; }
        const p = this.plan() === fms.sec ? fms.sec : fms.editPlan();
        p.fltNo = text;
        return;
      }
    }
    cdu.error('INVALID ENTRY');
  }
}

class ActFplnPage extends FplnBase {
  plan() { return fms.plan; }
  edit() { return fms.editPlan(); }
  titleText() { return actMod('FPLN'); }
  bottom(s: Screen) {
    if (!cancelModPrompt(s)) s.line(6, prompt('SEC FPLN', 'L'));
    s.line(6, '', prompt('PERF INIT', 'R'));
  }
  bottomLsk(side: Side) {
    if (side === 'L') {
      if (fms.isMod) { fms.cancelMod(); this.pendingVia = null; }
      else this.cdu.show('SECFPLN');
    } else this.cdu.show('PERF INIT');
  }
}
registerPage('FPLN', (c) => new ActFplnPage(c));

class SecFplnPage extends FplnBase {
  plan() { return fms.sec; }
  edit() { return fms.sec; }
  titleText() { return 'SEC FPLN'; }
  bottom(s: Screen) {
    s.line(6, prompt('COPY ACTIVE', 'L'), fms.sec.origin ? prompt('ACTIVATE', 'R') : '');
  }
  bottomLsk(side: Side) {
    if (side === 'L') { fms.copyActiveToSec(); return; }
    if (!fms.sec.origin) { this.cdu.error('INVALID ENTRY'); return; }
    fms.activateSecondary();
    this.cdu.show('FPLN');
  }
}
registerPage('SECFPLN', (c) => new SecFplnPage(c));

// ---------------------------------------------------------------------------
class RouteMenuPage extends Page {
  update() {
    this.pages = Math.max(1, Math.ceil(fms.savedRoutes().length / 4));
    if (this.page > this.pages) this.page = this.pages;
  }
  render(s: Screen) {
    s.title('ROUTE MENU', this.page, this.pages);
    const list = fms.savedRoutes().slice((this.page - 1) * 4, this.page * 4);
    if (!list.length) s.centerLine(2, '{w}NO PILOT ROUTES');
    list.forEach((r, i) => {
      s.label(i + 1, r.route.slice(0, 24));
      s.line(i + 1, `{w}<{g}${r.name}`, '{w}SEC>');
    });
    s.label(5, 'SAVE ACT FPLN AS');
    s.line(5, `{w}${boxes(8)}`);
    s.line(6, prompt('INDEX', 'L'), prompt('FPLN', 'R'));
  }
  lsk(side: Side, n: number) {
    const cdu = this.cdu;
    if (n === 6) { cdu.show(side === 'L' ? 'INDEX' : 'FPLN'); return; }
    if (n === 5 && side === 'L') {
      const name = cdu.take().trim().toUpperCase();
      if (!/^[A-Z0-9]{1,10}$/.test(name)) { cdu.error('INVALID ENTRY'); return; }
      if (!fms.active.origin || !fms.active.dest) { cdu.error('NO ACTIVE FPLN'); return; }
      fms.saveRoute(name, fms.routeString(fms.active));
      fms.active.routeName = name;
      cdu.error('ROUTE SAVED', 'w');
      return;
    }
    const r = fms.savedRoutes()[(this.page - 1) * 4 + n - 1];
    if (!r) { cdu.error('INVALID ENTRY'); return; }
    if (cdu.isDelete) { cdu.take(); fms.deleteRoute(r.name); return; }
    if (side === 'L' && !fms.ac.onGround) { cdu.error('NOT ALLOWED'); return; }
    const plan = side === 'L' ? fms.editPlan() : fms.sec;
    void fms.loadRouteString(plan, r.route).then((err) => {
      if (err) cdu.error(err);
      plan.routeName = r.name;
      if (!err) cdu.show(side === 'L' ? 'FPLN' : 'SECFPLN');
    });
  }
}
registerPage('ROUTE MENU', (c: Cdu) => new RouteMenuPage(c));
