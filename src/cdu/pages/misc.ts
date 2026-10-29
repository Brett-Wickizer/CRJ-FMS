// PROGRESS, RADIO, VOR CTL, GNSS CTL, MFD MENU/ADV/DATA, DATA BASE, PILOT WPT, SIM pages.
import { Page, registerPage, Side, Cdu } from '../cdu';
import type { Screen } from '../screen';
import { boxes, dashes } from '../screen';
import { fms } from '../../fms/fms';
import { navdb, Waypoint, navaidTypeName, Airport } from '../../nav/navdb';
import { endsAtFix, legDisplayIdent } from '../../fms/flightplan';
import { fmtLatLon, distance } from '../../util/geo';
import { trueToMag, magVar } from '../../util/magvar';
import { tatC } from '../../util/atmos';
import {
  fmtDist, fmtEte, fmtFuelK, fmtWind, fmtTemp, fmtCrs, fmtZulu, fmtAlt, parseFreq, parseWind, parseTemp, parseAlt, parseWeight,
} from '../fmt';
import { prompt, toggle } from './common';
import { sim } from '../../sim/sim';
import * as control from '../../sim/control';

// ---------------------------------------------------------------------------
class ProgPage extends Page {
  pages = 2;
  live = true;
  render(s: Screen) {
    s.title('PROGRESS', this.page, this.pages);
    const plan = fms.active;
    const ac = fms.ac;
    const ln = fms.guidance.lnav;
    if (this.page === 1) {
      s.label(1, 'TO', 'DIST  ETE   FUEL');
      const row = (n: number, ident: string, dist: number | null, ete: number | null, fuel: number | null, color: 'm' | 'g') => {
        s.line(n, ident || '{w}-----', '', { color });
        const d = dist != null ? fmtDist(dist).padStart(5) : '  ---';
        const e = ete != null ? fmtEte(ete).padStart(5) : ' -:--';
        const f = fuel != null ? fmtFuelK(fuel).padStart(5) : '  -.-';
        s.right(n * 2, `${d} ${e} ${f}`, { color: 'g' });
      };
      const act = plan.legs[plan.activeIdx];
      const airborne = !ac.onGround;
      if (act && act.pt !== 'DISCO') {
        const dist = airborne && ln.valid ? ln.dtg : act.pred?.dist ?? act.geo?.length ?? null;
        row(1, legDisplayIdent(act), dist, act.pred?.ete ?? null, act.pred?.fuel ?? null, 'm');
      } else row(1, act?.pt === 'DISCO' ? '{w}DISCONTINUITY' : '', null, null, null, 'm');
      s.label(2, 'NEXT');
      let nx = plan.activeIdx + 1;
      while (plan.legs[nx] && plan.legs[nx].pt === 'DISCO') nx++;
      const next = plan.legs[nx];
      if (next && next.seg !== 'MAP') row(2, legDisplayIdent(next), next.pred?.dist ?? null, next.pred?.ete ?? null, next.pred?.fuel ?? null, 'g');
      s.label(3, 'DEST');
      const pr = fms.pred;
      if (plan.dest) row(3, plan.dest.ident, pr?.valid ? pr.destDist : null, pr?.valid ? pr.destEte : null, pr?.valid ? pr.destFuel : null, 'g');
      s.label(4, plan.altn ? 'ALTN' : '');
      if (plan.altn && plan.dest) {
        const d = distance(plan.dest, plan.altn);
        row(4, plan.altn.ident, (pr?.destDist ?? 0) + d, null, null, 'g');
      }
      const v = fms.guidance.vnav;
      s.label(5, v.todDist != null && v.todDist > 0 && fms.phase !== 'DESCENT' && fms.phase !== 'APPROACH' ? 'TO T/D' : 'VERT DEV', 'NAV MODE');
      if (v.todDist != null && v.todDist > 0 && fms.phase !== 'DESCENT' && fms.phase !== 'APPROACH') s.line(5, `${fmtDist(v.todDist)}NM`, '');
      else s.line(5, v.vdev != null ? `${v.vdev > 0 ? '+' : ''}${Math.round(v.vdev)}FT` : '{w}----', '');
      s.right(10, fms.posInit ? (ln.approach ? 'GPS APPR' : plan.legs[plan.activeIdx]?.seg === 'SID' || plan.legs[plan.activeIdx]?.seg === 'STAR' ? 'GPS TERM' : 'GPS ENR') : '{a}NO POS', { color: 'g', small: true });
      s.line(6, prompt('INDEX', 'L'), prompt('LEGS', 'R'));
    } else {
      s.label(1, 'XTK', 'DTK / TRK');
      const xtk = ln.valid ? `${Math.abs(ln.xtk).toFixed(1)}NM ${ln.xtk >= 0 ? 'R' : 'L'}` : '{w}----';
      const dtk = ln.valid ? fmtCrs(trueToMag(ln.dtk, ac.pos.lat, ac.pos.lon)) : '---°';
      s.line(1, xtk, `${dtk}/${fmtCrs(trueToMag(ac.trk, ac.pos.lat, ac.pos.lon))}`);
      s.label(2, 'TAS', 'GS');
      s.line(2, String(Math.round(ac.tas)), String(Math.round(ac.gs)));
      s.label(3, 'WIND', 'ISA DEV');
      const w = fms.windNow;
      const wm = { dir: trueToMag(w.dir, ac.pos.lat, ac.pos.lon), spd: w.spd };
      s.line(3, w.spd > 1 ? fmtWind(wm) : '{w}CALM', fmtTemp(sim.env.isaDev));
      s.label(4, 'SAT', 'TAT');
      s.line(4, fmtTemp(fms.satC), fmtTemp(tatC(fms.satC, ac.mach)));
      s.label(5, 'GW', 'FUEL');
      s.line(5, `${Math.round(sim.ac.gw)}`, `${Math.round(sim.ac.s.fuel)}`);
      s.line(6, prompt('INDEX', 'L'), prompt('LEGS', 'R'));
    }
  }
  lsk(side: Side, n: number) {
    if (n === 6) this.cdu.show(side === 'L' ? 'INDEX' : 'LEGS');
    else super.lsk(side, n);
  }
}
registerPage('PROG', (c) => new ProgPage(c));

// ---------------------------------------------------------------------------
class RadioPage extends Page {
  pages = 2;
  live = true;
  render(s: Screen) {
    const r = fms.radios;
    s.title('RADIO', this.page, this.pages);
    const navId = (f: number) => fms.tunedStation(f)?.ident ?? '';
    if (this.page === 1) {
      s.label(1, 'COM1', 'COM2');
      s.line(1, r.com1.toFixed(3), r.com2.toFixed(3));
      s.label(2, 'PRESET', 'PRESET');
      s.line(2, `{c}${r.com1sby.toFixed(3)}`, `{c}${r.com2sby.toFixed(3)}`);
      s.label(3, `NAV1 ${r.nav1Auto ? 'FMS' : 'MAN'}`, `NAV2 ${r.nav2Auto ? 'FMS' : 'MAN'}`);
      s.line(3, `${r.nav1.toFixed(2)} {s}${navId(r.nav1)}`, `{s}${navId(r.nav2)} {l}${r.nav2.toFixed(2)}`);
      s.label(4, 'PRESET', 'PRESET');
      s.line(4, `{c}${r.nav1sby.toFixed(2)}`, `{c}${r.nav2sby.toFixed(2)}`);
      s.label(5, 'ATC1', 'TCAS/XPDR');
      s.line(5, r.atc, r.atcMode);
      s.line(6, prompt('VOR CTL', 'L'), prompt('INDEX', 'R'));
    } else {
      s.label(1, 'ADF1', 'ADF2');
      s.line(1, r.adf1.toFixed(1), r.adf2.toFixed(1));
      s.label(2, 'DME HOLD', 'TCAS RANGE');
      s.line(2, r.dmeHold1 ? '{g}ON{w}{s}/OFF' : '{w}{s}ON/{g}{l}OFF', `${r.tcasRange} NM`);
      s.label(3, 'NAV1 TUNE', 'NAV2 TUNE');
      s.line(3, toggle('AUTO', 'MAN', r.nav1Auto), toggle('AUTO', 'MAN', r.nav2Auto));
      s.line(6, prompt('VOR CTL', 'L'), prompt('INDEX', 'R'));
    }
  }
  lsk(side: Side, n: number) {
    const cdu = this.cdu;
    const r = fms.radios;
    if (n === 6) { cdu.show(side === 'L' ? 'VOR CTL' : 'INDEX'); return; }
    const t = cdu.hasEntry ? cdu.take().trim() : '';
    const bad = () => cdu.error('INVALID ENTRY');
    const key = `${this.page}${side}${n}`;
    const com = (x: string) => parseFreq(x.length <= 3 && !x.includes('.') ? x : x, 118, 136.99, 3);
    const nav = (x: string) => parseFreq(x, 108, 117.95, 2);
    switch (key) {
      case '1L1': if (!t) { [r.com1, r.com1sby] = [r.com1sby, r.com1]; return; } { const v = com(t); if (!v) return bad(); r.com1 = v; } return;
      case '1R1': if (!t) { [r.com2, r.com2sby] = [r.com2sby, r.com2]; return; } { const v = com(t); if (!v) return bad(); r.com2 = v; } return;
      case '1L2': if (!t) { [r.com1, r.com1sby] = [r.com1sby, r.com1]; return; } { const v = com(t); if (!v) return bad(); r.com1sby = v; } return;
      case '1R2': if (!t) { [r.com2, r.com2sby] = [r.com2sby, r.com2]; return; } { const v = com(t); if (!v) return bad(); r.com2sby = v; } return;
      case '1L3': {
        if (!t) { [r.nav1, r.nav1sby] = [r.nav1sby, r.nav1]; r.nav1Auto = false; return; }
        const w = navdb.findNear(t, fms.ac.pos).find((x) => x.freq && x.freq > 107);
        const v = w ? w.freq! : nav(t);
        if (!v) return bad();
        r.nav1 = v; r.nav1Auto = false; return;
      }
      case '1R3': {
        if (!t) { [r.nav2, r.nav2sby] = [r.nav2sby, r.nav2]; r.nav2Auto = false; return; }
        const w = navdb.findNear(t, fms.ac.pos).find((x) => x.freq && x.freq > 107);
        const v = w ? w.freq! : nav(t);
        if (!v) return bad();
        r.nav2 = v; r.nav2Auto = false; return;
      }
      case '1L4': if (!t) { [r.nav1, r.nav1sby] = [r.nav1sby, r.nav1]; r.nav1Auto = false; return; } { const v = nav(t); if (!v) return bad(); r.nav1sby = v; } return;
      case '1R4': if (!t) { [r.nav2, r.nav2sby] = [r.nav2sby, r.nav2]; r.nav2Auto = false; return; } { const v = nav(t); if (!v) return bad(); r.nav2sby = v; } return;
      case '1L5': if (!/^[0-7]{4}$/.test(t)) return bad(); r.atc = t; return;
      case '1R5': {
        const modes: typeof r.atcMode[] = ['STBY', 'ON', 'ALT', 'TA', 'TA/RA'];
        r.atcMode = modes[(modes.indexOf(r.atcMode) + 1) % modes.length];
        return;
      }
      case '2L1': case '2R1': {
        const v = parseFloat(t);
        if (!(v >= 190 && v <= 1799)) return bad();
        if (side === 'L') r.adf1 = v; else r.adf2 = v;
        return;
      }
      case '2L2': r.dmeHold1 = !r.dmeHold1; return;
      case '2R2': { const opts = [6, 12, 20, 40]; r.tcasRange = opts[(opts.indexOf(r.tcasRange) + 1) % opts.length]; return; }
      case '2L3': r.nav1Auto = !r.nav1Auto; return;
      case '2R3': r.nav2Auto = !r.nav2Auto; return;
    }
    bad();
  }
}
registerPage('RADIO', (c) => new RadioPage(c));

class VorCtlPage extends Page {
  live = true;
  render(s: Screen) {
    const r = fms.radios;
    s.title('VOR CTL', 1, 1);
    const st = (f: number) => {
      const w = fms.tunedStation(f);
      if (!w) return `{w}${f.toFixed(2)}`;
      return `${w.ident} ${f.toFixed(2)}`;
    };
    s.label(1, 'VOR1', 'VOR2');
    s.line(1, st(r.nav1), st(r.nav2));
    s.label(2, 'TUNING', 'TUNING');
    s.line(2, toggle('AUTO', 'MAN', r.nav1Auto), toggle('AUTO', 'MAN', r.nav2Auto));
    s.label(3, 'DIST', 'DIST');
    const d = (f: number) => { const w = fms.tunedStation(f); return w ? `${fmtDist(distance(fms.ac.pos, w))}NM` : '---'; };
    s.line(3, d(r.nav1), d(r.nav2), { small: true });
    s.label(4, 'NAV SENSORS');
    s.line(4, 'GPS1 GPS2 DME/DME', '', { small: true });
    s.line(6, prompt('RADIO', 'L'), prompt('INDEX', 'R'));
  }
  lsk(side: Side, n: number) {
    const r = fms.radios;
    if (n === 6) { this.cdu.show(side === 'L' ? 'RADIO' : 'INDEX'); return; }
    if (n === 2) { if (side === 'L') r.nav1Auto = !r.nav1Auto; else r.nav2Auto = !r.nav2Auto; return; }
    super.lsk(side, n);
  }
}
registerPage('VOR CTL', (c) => new VorCtlPage(c));

class GnssPage extends Page {
  live = true;
  pages = 2;
  render(s: Screen) {
    s.title(`GPS${this.page} STATUS`, this.page, this.pages);
    const t = Math.floor(sim.utc / 60);
    const sats = 9 + ((t + this.page) % 3);
    s.label(1, 'MODE', 'SATELLITES');
    s.line(1, 'NAV', String(sats));
    s.label(2, 'HFOM', 'VFOM');
    s.line(2, `0.0${this.page + 1}NM`, `${9 + this.page}FT`);
    s.label(3, 'HIL', 'RAIM');
    s.line(3, `0.0${this.page + 4}NM`, 'AVAIL');
    s.label(4, 'GPS POS');
    s.line(4, fmtLatLon(fms.gpsPos), '', { small: true });
    s.label(5, 'UTC', 'SBAS');
    s.line(5, `${fmtZulu(sim.utc)}Z`, 'WAAS');
    s.line(6, prompt('INDEX', 'L'), prompt('POS INIT', 'R'));
  }
  lsk(side: Side, n: number) {
    if (n === 6) this.cdu.show(side === 'L' ? 'INDEX' : 'POS INIT');
    else super.lsk(side, n);
  }
}
registerPage('GNSS CTL', (c) => new GnssPage(c));

// ---------------------------------------------------------------------------
class MfdMenuPage extends Page {
  pages = 2;
  render(s: Screen) {
    const m = fms.mfd;
    s.title('MFD MENU', this.page, this.pages);
    const t = (on: boolean) => toggle('ON', 'OFF', on);
    if (this.page === 1) {
      s.label(1, 'DISPLAY', '', '');
      s.line(1, '{w}<NEAREST APTS', t(m.apts));
      s.line(2, '{w}<HI NAVAIDS', t(m.hiNav));
      s.line(3, '{w}<LO NAVAIDS', t(m.loNav));
      s.line(4, '{w}<INTERSECTIONS', t(m.inters));
      s.line(5, '{w}<NDBS', t(m.ndbs));
      s.label(6, '', 'SIDE');
      s.line(6, '{w}<TERM WPTS', t(m.termWpts));
    } else {
      s.line(1, '{w}<MISSED APPR', t(m.missedAppr));
      s.line(2, '{w}<ALTN FPLN', t(m.altnFpln));
      s.line(3, '{w}<SEC FPLN', t(m.secFpln));
      s.line(4, '{w}<RANGE RINGS', t(m.rangeRings));
      s.line(5, '{w}<PROGRESS', t(m.progress));
    }
  }
  lsk(side: Side, n: number) {
    const m = fms.mfd;
    const keys1: (keyof typeof m)[] = ['apts', 'hiNav', 'loNav', 'inters', 'ndbs', 'termWpts'];
    const keys2: (keyof typeof m)[] = ['missedAppr', 'altnFpln', 'secFpln', 'rangeRings', 'progress'];
    const k = (this.page === 1 ? keys1 : keys2)[n - 1];
    if (k) (m as any)[k] = !(m as any)[k];
    fms.changed();
    void side;
  }
}
registerPage('MFD MENU', (c) => new MfdMenuPage(c));

class MfdAdvPage extends Page {
  live = true;
  private list(): number[] {
    const p = fms.plan;
    const out: number[] = [];
    for (let i = 0; i < p.legs.length; i++) if (p.legs[i].fix && (endsAtFix(p.legs[i]) || i === 0)) out.push(i);
    return out;
  }
  next() {
    const l = this.list();
    const k = l.indexOf(fms.mfd.planCenter);
    fms.mfd.planCenter = l[Math.min(l.length - 1, k + 1)] ?? 0;
  }
  prev() {
    const l = this.list();
    const k = l.indexOf(fms.mfd.planCenter);
    fms.mfd.planCenter = l[Math.max(0, k - 1)] ?? 0;
  }
  render(s: Screen) {
    s.title('MFD ADVANCE', 1, 1);
    const p = fms.plan;
    const l = this.list();
    let k = l.indexOf(fms.mfd.planCenter);
    if (k < 0) { k = Math.max(0, l.indexOf(p.activeIdx)); fms.mfd.planCenter = l[k] ?? 0; }
    const start = Math.max(0, Math.min(k - 2, l.length - 5));
    s.label(1, 'PLAN MAP CENTER');
    for (let r = 0; r < 5; r++) {
      const i = l[start + r];
      if (i == null) break;
      const leg = p.legs[i];
      const ctr = i === fms.mfd.planCenter;
      s.line(r + 1, `${ctr ? '{w}' : ''}${leg.fix!.ident}`, ctr ? '{w}<CTR>' : '', { color: i === p.activeIdx ? 'm' : 'g' });
    }
    s.line(6, prompt('TO WPT', 'L'), '{w}{s}PREV/NEXT PAGE');
  }
  lsk(side: Side, n: number) {
    const p = fms.plan;
    if (n === 6 && side === 'L') { fms.mfd.planCenter = p.activeIdx; return; }
    const l = this.list();
    let k = l.indexOf(fms.mfd.planCenter);
    if (k < 0) k = 0;
    const start = Math.max(0, Math.min(k - 2, l.length - 5));
    const i = l[start + n - 1];
    if (i != null) fms.mfd.planCenter = i;
  }
}
registerPage('MFD ADV', (c) => new MfdAdvPage(c));

class MfdDataPage extends Page {
  render(s: Screen) {
    const d = fms.mfd.dataPage;
    s.title('MFD DATA', 1, 1);
    const opt = (name: string, v: typeof d) => (d === v ? `{g}${name} {w}{s}<ACT>` : `{w}<${name}`);
    s.line(1, opt('FPL PROGRESS', 'FPL PROG'));
    s.line(2, opt('NAV STATUS', 'NAV STATUS'));
    s.line(3, opt('FPL DATA', 'FPL DATA'));
    s.line(4, opt('MAP ONLY', 'NONE'));
  }
  lsk(side: Side, n: number) {
    const v = (['FPL PROG', 'NAV STATUS', 'FPL DATA', 'NONE'] as const)[n - 1];
    if (v && side === 'L') { fms.mfd.dataPage = v; fms.changed(); }
  }
}
registerPage('MFD DATA', (c) => new MfdDataPage(c));

// ---------------------------------------------------------------------------
class DataBasePage extends Page {
  private w: Waypoint | null = null;
  update() {
    if (this.w?.apt) this.pages = 1 + Math.ceil(this.w.apt.runways.length / 5);
    else this.pages = 1;
    if (this.page > this.pages) this.page = 1;
  }
  render(s: Screen) {
    s.title('DATA BASE', this.page, this.pages);
    const w = this.w;
    if (this.page === 1) {
      s.label(1, 'IDENT');
      s.line(1, w ? w.ident : `{w}${boxes(5)}`, w ? `{s}${navaidTypeName(w)}` : '');
      if (w) {
        s.label(2, w.kind === 'APT' ? 'NAME' : w.name ? 'NAME' : '');
        s.line(2, (w.name ?? '').slice(0, 24), '', { small: true });
        s.label(3, 'LAT/LON');
        s.line(3, fmtLatLon(w, 2), '', { small: true });
        if (w.apt) {
          s.label(4, 'ELEV', 'MAG VAR');
          s.line(4, `${w.apt.elev}FT`, `${Math.abs(w.apt.magvar).toFixed(0)}°${w.apt.magvar >= 0 ? 'E' : 'W'}`);
          s.label(5, 'TRANS ALT', 'LONGEST RWY');
          s.line(5, String(w.apt.transAlt), `${w.apt.longest}FT`);
        } else {
          s.label(4, w.freq ? 'FREQ' : '', 'MAG VAR');
          const mv = w.dec != null && w.kind === 'VOR' ? w.dec : magVar(w.lat, w.lon);
          s.line(4, w.freq ? (w.kind === 'NDB' ? `${w.freq}` : w.freq.toFixed(2)) : '', `${Math.abs(mv).toFixed(0)}°${mv >= 0 ? 'E' : 'W'}`);
          s.label(5, w.elev ? 'ELEV' : '', 'DIST');
          s.line(5, w.elev ? `${w.elev}FT` : '', `${fmtDist(distance(fms.ac.pos, w))}NM`);
        }
      }
    } else if (w?.apt) {
      const rws = w.apt.runways.slice((this.page - 2) * 5, (this.page - 1) * 5);
      rws.forEach((r, i) => {
        s.label(i + 1, `RW${r.id}  ${fmtCrs(trueToMag(r.brg, r.lat, r.lon))}`, r.ilsFreq ? `${r.ilsIdent} ${r.ilsFreq.toFixed(2)}` : '');
        s.line(i + 1, `${r.length}X${r.width}`, `{s}${fmtLatLon(r)}`);
      });
    }
    s.line(6, prompt('INDEX', 'L'), w ? prompt('COPY', 'R') : '');
  }
  lsk(side: Side, n: number) {
    const cdu = this.cdu;
    if (n === 6) {
      if (side === 'L') cdu.show('INDEX');
      else if (this.w) cdu.setScratch(this.w.ident);
      return;
    }
    if (n === 1 && side === 'L') {
      const t = cdu.take();
      if (!t) return;
      cdu.resolveWaypoint(t, fms.ac.pos, (w) => { this.w = w; this.page = 1; });
      return;
    }
    super.lsk(side, n);
  }
}
registerPage('DATA BASE', (c) => new DataBasePage(c));

class PilotWptPage extends Page {
  update() {
    this.pages = Math.max(1, Math.ceil(navdb.pilotWpts.length / 4));
    if (this.page > this.pages) this.page = this.pages;
  }
  render(s: Screen) {
    s.title('PILOT WPT LIST', this.page, this.pages);
    const list = navdb.pilotWpts.slice((this.page - 1) * 4, this.page * 4);
    if (!list.length) s.centerLine(2, '{w}NO PILOT WPTS');
    list.forEach((w, i) => {
      s.label(i + 1, w.def ?? '');
      s.line(i + 1, `{w}<{g}${w.ident}`, `{s}${fmtLatLon(w)}`);
    });
    s.line(6, prompt('INDEX', 'L'), prompt('DEFINE WPT', 'R'));
  }
  lsk(side: Side, n: number) {
    const cdu = this.cdu;
    if (n === 6) { cdu.show(side === 'L' ? 'INDEX' : 'DEFINE WPT'); return; }
    const w = navdb.pilotWpts[(this.page - 1) * 4 + n - 1];
    if (!w) { cdu.error('INVALID ENTRY'); return; }
    if (cdu.isDelete) { cdu.take(); navdb.deletePilotWpt(w.ident); return; }
    cdu.setScratch(w.ident);
  }
}
registerPage('PILOT WPT LIST', (c) => new PilotWptPage(c));

class DefineWptPage extends Page {
  private ident = '';
  private wpt: Waypoint | null = null;
  render(s: Screen) {
    s.title('DEFINE PILOT WPT', 1, 1);
    s.label(1, 'IDENT');
    s.line(1, this.ident || `{w}${boxes(5)}`);
    s.label(2, 'DEFINITION (LAT/LON, PBD, PB/PB)');
    s.line(2, this.wpt?.def ?? `{w}${dashes(12)}`, '', { small: !!this.wpt });
    s.label(3, 'LAT/LON');
    s.line(3, this.wpt ? fmtLatLon(this.wpt, 2) : '{w}---°--.-- ----°--.--', '', { small: true });
    s.line(6, prompt('PILOT WPT LIST', 'L'), this.ident && this.wpt ? prompt('STORE', 'R') : '');
  }
  lsk(side: Side, n: number) {
    const cdu = this.cdu;
    if (n === 6) {
      if (side === 'L') { cdu.show('PILOT WPT LIST'); return; }
      if (!this.ident || !this.wpt) { cdu.error('INVALID ENTRY'); return; }
      if (!navdb.addPilotWpt({ ...this.wpt, ident: this.ident })) { cdu.error('PILOT WPT LIST FULL'); return; }
      cdu.show('PILOT WPT LIST');
      return;
    }
    const t = cdu.take().trim().toUpperCase();
    if (!t) return;
    if (n === 1) {
      if (!/^[A-Z0-9]{1,5}$/.test(t)) { cdu.error('INVALID ENTRY'); return; }
      this.ident = t;
      return;
    }
    if (n === 2) {
      const w = fms.parseDefinedWaypoint(t, fms.ac.pos);
      if (!w || w === 'INVALID') { cdu.error('INVALID ENTRY'); return; }
      this.wpt = w;
      if (!this.ident) this.ident = w.ident;
      return;
    }
    cdu.error('INVALID ENTRY');
  }
}
registerPage('DEFINE WPT', (c) => new DefineWptPage(c));

// ---------------------------------------------------------------------------
const RATES = [1, 2, 4, 8, 16, 32, 64];
class SimPage extends Page {
  live = true;
  render(s: Screen) {
    s.title('SIM CONTROL', 1, 1);
    const ac = sim.ac;
    s.label(1, 'SIM RATE', 'PAUSE');
    s.line(1, `${sim.rate}X`, toggle('ON', 'OFF', sim.paused));
    s.label(2, 'POSITION');
    s.line(2, prompt('AT GATE', 'L'), prompt('LINE UP', 'R'));
    s.label(3, ac.s.onGround ? 'START TAKEOFF' : 'GO AROUND', 'AUTO CREW');
    s.line(3, prompt('TOGA', 'L'), toggle('ON', 'OFF', ac.fcp.autoCrew));
    s.label(4, 'FUEL (LB)', 'ATC ALT CLR');
    s.line(4, String(Math.round(ac.s.fuel)), toggle('ON', 'OFF', control.settings.atcAlt));
    s.label(5, 'ALT SEL', 'VNAV/NAV ARM');
    s.line(5, fmtAlt(ac.fcp.altSel), `${ac.fcp.vnav ? 'VNAV' : '----'} ${ac.fcp.latArmed === 'LNAV' || ac.fcp.lat === 'LNAV' ? 'LNAV' : '----'}`);
    s.line(6, prompt('MCDU MENU', 'L'), prompt('RESET FLT', 'R'));
  }
  lsk(side: Side, n: number) {
    const cdu = this.cdu;
    const ac = sim.ac;
    const key = side + n;
    const err = (e: string | null) => { if (e) cdu.error(e); };
    switch (key) {
      case 'L1': {
        if (cdu.hasEntry) {
          const v = parseInt(cdu.take(), 10);
          if (!RATES.includes(v)) { cdu.error('INVALID ENTRY'); return; }
          sim.rate = v;
        } else sim.rate = RATES[(RATES.indexOf(sim.rate) + 1) % RATES.length];
        return;
      }
      case 'R1': sim.paused = !sim.paused; return;
      case 'L2': err(control.atGate()); return;
      case 'R2': err(control.lineUp()); return;
      case 'L3': err(control.toga()); return;
      case 'R3': ac.fcp.autoCrew = !ac.fcp.autoCrew; return;
      case 'L4': {
        const v = parseWeight(cdu.take(), 19594);
        if (v == null) { cdu.error('INVALID ENTRY'); return; }
        control.setFuel(v);
        return;
      }
      case 'R4': control.settings.atcAlt = !control.settings.atcAlt; return;
      case 'L5': {
        const v = parseAlt(cdu.take());
        if (v == null) { cdu.error('INVALID ENTRY'); return; }
        ac.fcp.altSel = Math.round(v / 100) * 100;
        return;
      }
      case 'R5': ac.fcp.vnav = !ac.fcp.vnav; if (!ac.fcp.vnav && ac.fcp.vert.startsWith('V')) ac.fcp.vert = 'FLC'; if (ac.fcp.lat !== 'LNAV') ac.fcp.latArmed = 'LNAV'; return;
      case 'L6': cdu.show('MCDU MENU'); return;
      case 'R6': control.resetFlight(); cdu.show('STATUS'); return;
    }
  }
}
registerPage('SIM', (c) => new SimPage(c));

class SimWxPage extends Page {
  render(s: Screen) {
    const e = sim.env;
    s.title('SIM WEATHER', 1, 1);
    s.label(1, 'SFC WIND', 'ALOFT WIND');
    s.line(1, fmtWind(e.sfcWind), fmtWind(e.aloftWind));
    s.label(2, 'ISA DEV', 'ALOFT ALT');
    s.line(2, fmtTemp(e.isaDev), fmtAlt(e.aloftAlt));
    s.label(3, 'QNH', 'GUST');
    s.line(3, e.qnh.toFixed(2), String(e.gust));
    s.label(4, 'WINDS ARE TRUE');
    s.line(6, prompt('MCDU MENU', 'L'));
  }
  lsk(side: Side, n: number) {
    const cdu = this.cdu;
    const e = sim.env;
    if (n === 6) { cdu.show('MCDU MENU'); return; }
    const t = cdu.take().trim();
    const bad = () => cdu.error('INVALID ENTRY');
    const key = side + n;
    if (key === 'L1') { const w = parseWind(t); if (!w) return bad(); e.sfcWind = w; }
    else if (key === 'R1') { const w = parseWind(t); if (!w) return bad(); e.aloftWind = w; }
    else if (key === 'L2') { const v = parseTemp(t); if (v == null) return bad(); e.isaDev = v; }
    else if (key === 'R2') { const v = parseAlt(t); if (v == null) return bad(); e.aloftAlt = v; }
    else if (key === 'L3') { const v = parseFloat(t); if (!(v > 27 && v < 32)) return bad(); e.qnh = v; }
    else if (key === 'R3') { const v = parseInt(t, 10); if (!(v >= 0 && v <= 30)) return bad(); e.gust = v; }
    else bad();
  }
}
registerPage('SIM WX', (c) => new SimWxPage(c));

export type { Airport, Cdu };
