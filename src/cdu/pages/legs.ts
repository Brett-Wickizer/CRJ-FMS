// LEGS page.
import { Page, registerPage, Side } from '../cdu';
import type { Screen } from '../screen';
import { boxes } from '../screen';
import { fms } from '../../fms/fms';
import { legDisplayIdent, isHold } from '../../fms/flightplan';
import type { FPLeg } from '../../fms/types';
import { trueToMag } from '../../util/magvar';
import { distance } from '../../util/geo';
import { fmtAlt, fmtCstrAlt, fmtCrs, fmtDist, fmtZulu, fmtFuelK, fmtMach } from '../fmt';
import { parseSpdAlt } from '../fmt';
import { actMod, cancelModPrompt, prompt } from './common';

class LegsPage extends Page {
  live = true;
  private rteData = false;

  private first(): number {
    const p = fms.plan;
    return Math.max(1, p.activeIdx);
  }
  private legsShown(): number[] {
    const p = fms.plan;
    const out: number[] = [];
    for (let i = this.first(); i < p.legs.length; i++) out.push(i);
    return out;
  }
  update() {
    const n = this.legsShown().length;
    this.pages = Math.max(1, Math.ceil(n / 5));
    if (this.page > this.pages) this.page = this.pages;
  }

  render(s: Screen) {
    const p = fms.plan;
    s.title(actMod('LEGS'), this.page, this.pages);
    const idx = this.legsShown().slice((this.page - 1) * 5, this.page * 5);
    const ta = fms.perf.transAlt;
    if (!p.legs.length) s.centerLine(2, '{w}NO ACTIVE FPLN');
    idx.forEach((i, k) => {
      const n = k + 1;
      const l = p.legs[i];
      const active = p === fms.active && i === p.activeIdx && !fms.ac.onGround;
      const activeLike = i === p.activeIdx;
      if (l.pt === 'DISCO') {
        s.label(n, '', '', '- DISCONTINUITY -');
        s.line(n, `{w}${boxes(5)}`);
        return;
      }
      if (l.seg === 'MAP' && p.legs[i - 1]?.seg !== 'MAP') s.label(n, '', '', '- MISSED APPROACH -');
      else s.label(n, this.legLabel(l, i, activeLike));
      const ident = legDisplayIdent(l);
      const color = active || (activeLike && p !== fms.active) || (activeLike && fms.ac.onGround) ? 'm' : l.seg === 'MAP' ? 'c' : 'g';
      s.line(n, ident, '', { color: color as any });
      s.right(n * 2, this.rteData ? this.dataText(l) : this.spdAltText(l, ta));
    });
    if (!cancelModPrompt(s)) s.line(6, prompt('SEC FPLN', 'L'));
    s.line(6, '', prompt(this.rteData ? 'LEG DATA' : 'RTE DATA', 'R'));
  }

  private legLabel(l: FPLeg, i: number, activeLike: boolean): string {
    const g = l.geo;
    const ref = l.fix ?? g?.end ?? fms.ac.pos;
    const crs = g ? fmtCrs(trueToMag(g.segs.length ? g.crsIn : g.crsOut, ref.lat, ref.lon)) : '';
    let dist = g ? g.length : 0;
    if (activeLike && fms.plan === fms.active && !fms.ac.onGround && fms.guidance.lnav.valid) dist = fms.guidance.lnav.dtg;
    if (isHold(l)) {
      const h = l.hold!;
      const t = h.legDist ? `${h.legDist}NM` : `${(h.legTime ?? 1).toFixed(1)}MIN`;
      return ` HOLD ${h.turn}  ${t}`;
    }
    switch (l.pt) {
      case 'CA': case 'VA': case 'FA':
        return ` ${l.crs != null ? fmtCrs(l.crs) : crs}${l.pt === 'VA' ? ' HDG' : ''}`;
      case 'VM': case 'FM':
        return ` ${l.crs != null ? fmtCrs(l.crs) : crs} HDG`;
      case 'VI': case 'CI':
        return ` ${l.crs != null ? fmtCrs(l.crs) : crs}${l.pt === 'VI' ? ' HDG' : ''}`;
      case 'RF':
        return ` ${l.turn ?? ''} ARC   ${fmtDist(dist)}NM`;
      case 'AF':
        return ` DME ARC ${l.turn ?? ''} ${fmtDist(dist)}NM`;
      case 'PI':
        return ` ${l.crs != null ? fmtCrs(l.crs) : ''}`;
    }
    if (!g || (g.length < 0.05 && !activeLike)) return '';
    void i;
    return ` ${crs}  ${fmtDist(dist).padStart(5)}NM`;
  }

  private spdAltText(l: FPLeg, ta: number): string {
    const pr = l.pred;
    let spd: string;
    if (l.spd) spd = `{l}${l.spd.kt}${l.spd.t === 'AB' ? 'A' : ''}`;
    else if (pr) spd = pr.mach > 0.6 && pr.alt > 25000 ? `{s}${fmtMach(pr.mach)}` : `{s}${pr.spd}`;
    else spd = '{s}---';
    let alt: string;
    if (l.alt) alt = `{l}${fmtCstrAlt(l.alt, ta)}`;
    else if (pr) alt = `{s}${fmtAlt(pr.alt, ta)}`;
    else alt = '{s}-----';
    return `{g}${spd}{s}/${alt}`;
  }

  private dataText(l: FPLeg): string {
    const pr = l.pred;
    if (!pr) return '{s}----Z  --.-';
    return `{s}${fmtZulu(fms.eta(pr.ete))}Z  ${fmtFuelK(pr.fuel).padStart(4)}`;
  }

  lsk(side: Side, n: number) {
    const cdu = this.cdu;
    if (n === 6) {
      if (side === 'L') {
        if (fms.isMod) fms.cancelMod();
        else cdu.show('SECFPLN');
      } else this.rteData = !this.rteData;
      return;
    }
    const idx = this.legsShown().slice((this.page - 1) * 5, this.page * 5)[n - 1];
    const p = fms.plan;
    if (idx == null) {
      // Empty slot after the end of the plan: append a waypoint
      if (side === 'L' && cdu.hasEntry && p.legs.length) {
        const t = cdu.take();
        cdu.resolveWaypoint(t, fms.ac.pos, (w) => {
          const e = fms.editPlan();
          const err = e.insertWaypoint(e.legs.length, w);
          if (err) cdu.error(err);
        });
      } else cdu.error('INVALID ENTRY');
      return;
    }
    const leg = p.legs[idx];
    if (side === 'L') {
      if (cdu.isDelete) {
        cdu.take();
        const err = fms.editPlan().deleteLeg(idx);
        if (err) { if (fms.mod && !fms.mod.legs.length) fms.cancelMod(); cdu.error(err); }
        return;
      }
      if (!cdu.hasEntry) {
        if (leg.fix && leg.pt !== 'DISCO') cdu.setScratch(leg.fix.ident);
        return;
      }
      const t = cdu.take();
      const refPos = p.prevFixLeg(idx)?.fix ?? fms.ac.pos;
      cdu.resolveWaypoint(t, refPos, (w) => {
        const e = fms.editPlan();
        const airborne = !fms.ac.onGround;
        if (idx === e.activeIdx && airborne && e === fms.mod) {
          e.directTo(w, { ...fms.ac.pos });
          return;
        }
        const err = e.insertWaypoint(idx, w);
        if (err) cdu.error(err);
      });
      return;
    }
    // Right side: speed / altitude constraints
    if (leg.pt === 'DISCO') { cdu.error('INVALID ENTRY'); return; }
    if (cdu.isDelete) {
      cdu.take();
      const e = fms.editPlan();
      const l = e.legs[idx];
      l.alt = undefined; l.spd = undefined; l.userAlt = false; l.userSpd = false;
      e.touch();
      return;
    }
    if (!cdu.hasEntry) {
      const parts: string[] = [];
      if (leg.spd) parts.push(String(leg.spd.kt));
      if (leg.alt) parts.push(fmtCstrAlt(leg.alt));
      if (parts.length) cdu.setScratch(leg.spd && leg.alt ? parts.join('/') : leg.spd ? parts[0] + '/' : parts[0]);
      return;
    }
    const t = cdu.take();
    const v = parseSpdAlt(t);
    if (!v) { cdu.error('INVALID ENTRY'); return; }
    if (!leg.fix || ['VM', 'FM', 'CI', 'VI'].includes(leg.pt)) { cdu.error('INVALID ENTRY'); return; }
    const e = fms.editPlan();
    const l = e.legs[idx];
    if (v.spd !== undefined) { l.spd = v.spd ?? undefined; l.userSpd = true; }
    if (v.alt !== undefined) { l.alt = v.alt ?? undefined; l.userAlt = true; }
    e.touch();
    void distance;
  }
}
registerPage('LEGS', (c) => new LegsPage(c));
