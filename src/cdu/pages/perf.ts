// PERF pages.
import { Page, registerPage, Side } from '../cdu';
import type { Screen } from '../screen';
import { boxes, dashes } from '../screen';
import { fms, PerfInit } from '../../fms/fms';
import { CRJ700 } from '../../fms/perf';
import {
  fmtAlt, fmtMach, fmtWind, fmtTemp, fmtEte, fmtZulu, fmtDist, parseAlt, parseWind, parseTemp, parseWeight, parseSpeed,
} from '../fmt';
import { actModPerf, prompt } from './common';
import { sim } from '../../sim/sim';
import { trueToMag } from '../../util/magvar';

const lbs = (n: number) => String(Math.round(n));

class PerfMenuPage extends Page {
  render(s: Screen) {
    s.title('PERF MENU', 1, 1);
    s.line(1, prompt('PERF INIT', 'L'), prompt('PERF DATA', 'R'));
    s.line(2, prompt('VNAV SETUP', 'L'), prompt('FUEL MGMT', 'R'));
    s.line(3, prompt('TAKEOFF', 'L'), prompt('FLT LOG', 'R'));
    s.line(4, prompt('APPROACH', 'L'));
    if (fms.isMod) s.line(6, '{w}<CANCEL MOD');
  }
  lsk(side: Side, n: number) {
    if (n === 6 && side === 'L' && fms.isMod) { fms.cancelMod(); return; }
    const id = ({ L1: 'PERF INIT', R1: 'PERF DATA', L2: 'VNAV', R2: 'FUEL MGMT', L3: 'TAKEOFF', R3: 'FLT LOG', L4: 'APPROACH' } as Record<string, string>)[side + n];
    if (id) this.cdu.show(id);
    else super.lsk(side, n);
  }
}
registerPage('PERF', (c) => (fms.perf.confirmed ? new PerfMenuPage(c) : new PerfInitPage(c)));
registerPage('PERF MENU', (c) => new PerfMenuPage(c));

// ---------------------------------------------------------------------------
class PerfInitPage extends Page {
  pages = 3;
  live = true;
  render(s: Screen) {
    const p = fms.perfView;
    s.title(actModPerf('PERF INIT'), this.page, this.pages);
    const ta = p.transAlt;
    if (this.page === 1) {
      s.label(1, 'ACFT TYPE', 'TAIL #');
      s.line(1, p.acftType, p.tailNo);
      s.label(2, 'CLIMB', 'CRUISE');
      s.line(2, `${p.clbIas}/${fmtMach(p.clbMach)}`, p.crzMode === 'MACH' ? fmtMach(p.crzMach) : p.crzMode === 'LRC' ? 'LRC' : 'MAX SPD');
      s.label(3, 'DESCENT', 'DES ANGLE');
      s.line(3, `${fmtMach(p.desMach)}/${p.desIas}`, `${p.vpa.toFixed(1)}°`);
      s.label(4, 'SPD/ALT LIM', 'TRANS ALT');
      s.line(4, `${p.clbLimIas}/${p.clbLimAlt}`, String(p.transAlt));
      s.label(5, 'RESERVE FUEL', 'TAXI FUEL');
      s.line(5, lbs(p.reserve), lbs(p.taxiFuel));
      s.line(6, prompt('PERF MENU', 'L'));
    } else if (this.page === 2) {
      s.label(1, 'CRZ ALT', 'OPT/MAX');
      s.line(1, p.crzAlt ? fmtAlt(p.crzAlt, ta) : `{w}${boxes(5)}`, `{s}${fmtAlt(fms.optAlt(), ta)}/${fmtAlt(fms.maxAlt(), ta)}`);
      s.label(2, 'ISA DEV', 'SAT');
      s.line(2, fmtTemp(p.isaDev), `{s}${fmtTemp(fms.satC)}`);
      s.label(3, 'CLB WIND');
      s.line(3, p.winds.clb.spd ? fmtWind(p.winds.clb) : `{w}${fmtWind(null)}`);
      s.label(4, 'CRZ WIND');
      s.line(4, p.winds.crz.spd ? fmtWind(p.winds.crz) : `{w}${fmtWind(null)}`);
      s.label(5, 'DES WIND');
      s.line(5, p.winds.des.spd ? fmtWind(p.winds.des) : `{w}${fmtWind(null)}`);
      s.line(6, prompt('PERF MENU', 'L'));
    } else {
      const zfw = fms.zfw(p);
      const fuel = fms.fuel(p);
      const gw = zfw + fuel;
      s.label(1, 'BOW', 'PASS/WT');
      s.line(1, lbs(p.bow), `${p.pax}/${p.paxWt}`);
      s.label(2, 'CARGO', 'PASS WT');
      s.line(2, lbs(p.cargo), `{s}${lbs(p.pax * p.paxWt)}`);
      s.label(3, 'FUEL', 'ZFW');
      s.line(3, p.fuelOverride != null ? lbs(fuel) : `{s}${lbs(fuel)}`, zfw > CRJ700.mzfw ? `{a}${lbs(zfw)}` : `{s}${lbs(zfw)}`);
      s.label(4, '', 'GWT');
      s.line(4, '', gw > CRJ700.mtow ? `{a}${lbs(gw)}` : `{s}${lbs(gw)}`);
      s.label(5, '', 'MAX TOW/LW');
      s.line(5, '', `{s}{w}${CRJ700.mtow}/${CRJ700.mlw}`);
      s.line(6, prompt('PERF MENU', 'L'), fms.modPerf || !fms.perf.confirmed ? prompt('CONFIRM INIT', 'R') : '{g}{s}CONFIRMED');
    }
  }
  lsk(side: Side, n: number) {
    const cdu = this.cdu;
    if (n === 6) {
      if (side === 'L') cdu.show('PERF MENU');
      else if (this.page === 3) {
        fms.editPerf();
        fms.exec();
        cdu.show('PERF MENU');
      }
      return;
    }
    const bad = () => cdu.error('INVALID ENTRY');
    if (cdu.isDelete) {
      cdu.take();
      const p = fms.editPerf();
      const key = `${this.page}${side}${n}`;
      if (key === '2L3') p.winds.clb = { dir: 0, spd: 0 };
      else if (key === '2L4') p.winds.crz = { dir: 0, spd: 0 };
      else if (key === '2L5') p.winds.des = { dir: 0, spd: 0 };
      else if (key === '3L3') p.fuelOverride = null;
      else if (key === '2L1') p.crzAlt = null;
      else cdu.error('INVALID DELETE');
      return;
    }
    if (!cdu.hasEntry) return;
    const t = cdu.take().trim().toUpperCase();
    const p = fms.editPerf();
    const key = `${this.page}${side}${n}`;
    switch (key) {
      case '1R1': if (!/^[A-Z0-9-]{2,7}$/.test(t)) return bad(); p.tailNo = t; break;
      case '1L2': {
        const m = /^(\d{3})?\/?(\.\d{2})?$/.exec(t);
        if (!m || (!m[1] && !m[2])) return bad();
        if (m[1]) { const v = +m[1]; if (v < 200 || v > 320) return bad(); p.clbIas = v; }
        if (m[2]) { const v = parseFloat(m[2]); if (v < 0.6 || v > 0.82) return bad(); p.clbMach = v; }
        break;
      }
      case '1R2': {
        if (t === 'LRC') { p.crzMode = 'LRC'; break; }
        if (t === 'MAX' || t === 'MAX SPD') { p.crzMode = 'MAX'; break; }
        const sp = parseSpeed(t);
        if (!sp?.mach || sp.mach > CRJ700.mmo) return bad();
        p.crzMach = sp.mach; p.crzMode = 'MACH';
        break;
      }
      case '1L3': {
        const m = /^(\.\d{2})?\/?(\d{3})?$/.exec(t);
        if (!m || (!m[1] && !m[2])) return bad();
        if (m[1]) p.desMach = parseFloat(m[1]);
        if (m[2]) { const v = +m[2]; if (v < 220 || v > 330) return bad(); p.desIas = v; }
        break;
      }
      case '1R3': { const v = parseFloat(t); if (!(v >= 1 && v <= 6)) return bad(); p.vpa = v; break; }
      case '1L4': {
        const m = /^(\d{3})\/(\d{4,5})$/.exec(t);
        if (!m) return bad();
        p.clbLimIas = +m[1]; p.clbLimAlt = +m[2]; p.desLimIas = +m[1]; p.desLimAlt = +m[2];
        break;
      }
      case '1R4': { const v = parseAlt(t); if (v == null || v < 2000) return bad(); p.transAlt = v; break; }
      case '1L5': { const v = parseWeight(t); if (v == null || v > 10000) return bad(); p.reserve = v; break; }
      case '1R5': { const v = parseWeight(t); if (v == null || v > 3000) return bad(); p.taxiFuel = v; break; }
      case '2L1': { const v = parseAlt(t); if (v == null || v < 1000 || v > CRJ700.ceiling) return bad(); p.crzAlt = Math.round(v / 100) * 100; break; }
      case '2L2': { const v = parseTemp(t); if (v == null || Math.abs(v) > 40) return bad(); p.isaDev = v; break; }
      case '2L3': case '2L4': case '2L5': {
        const w = parseWind(t);
        if (!w) return bad();
        if (key === '2L3') p.winds.clb = w; else if (key === '2L4') p.winds.crz = w; else p.winds.des = w;
        break;
      }
      case '3L1': { const v = parseWeight(t); if (!v || v < 30000 || v > 55000) return bad(); p.bow = v; break; }
      case '3R1': {
        const m = /^(\d{1,2})?(?:\/(\d{2,3}))?$/.exec(t);
        if (!m || (!m[1] && !m[2])) return bad();
        if (m[1]) { const v = +m[1]; if (v > CRJ700.paxMax) return bad(); p.pax = v; }
        if (m[2]) { const v = +m[2]; if (v < 100 || v > 300) return bad(); p.paxWt = v; }
        break;
      }
      case '3L2': { const v = parseWeight(t); if (v == null || v > 6000) return bad(); p.cargo = v; break; }
      case '3L3': { const v = parseWeight(t); if (v == null || v > CRJ700.maxFuel) return bad(); p.fuelOverride = v; break; }
      default: return bad();
    }
    if (p.crzAlt == null && fms.active.dest) { /* leave boxes */ }
  }
}
registerPage('PERF INIT', (c) => new PerfInitPage(c));

// ---------------------------------------------------------------------------
class VnavPage extends Page {
  pages = 3;
  constructor(cdu: any) {
    super(cdu);
    const ph = fms.phase;
    this.page = ph === 'CRUISE' ? 2 : ph === 'DESCENT' || ph === 'APPROACH' ? 3 : 1;
  }
  live = true;
  render(s: Screen) {
    const p = fms.perfView;
    const names = ['VNAV CLIMB', 'VNAV CRUISE', 'VNAV DESCENT'];
    s.title(actModPerf(names[this.page - 1]), this.page, this.pages);
    const ta = p.transAlt;
    if (this.page === 1) {
      s.label(1, 'TGT SPEED', 'TRANS ALT');
      s.line(1, `${p.clbIas}/${fmtMach(p.clbMach)}`, String(p.transAlt));
      s.label(2, 'SPD/ALT LIMIT');
      s.line(2, `${p.clbLimIas}/${p.clbLimAlt}`);
      s.label(3, 'CRZ ALT');
      s.line(3, p.crzAlt ? fmtAlt(p.crzAlt, ta) : `{w}${boxes(5)}`);
      const toc = fms.pred?.toc;
      s.label(4, 'TO T/C', '');
      s.line(4, toc ? `{s}${fmtDist(toc.dist - fms.guidance.traveledSincePred)}NM  ${fmtEte(toc.ete)}` : '{w}{s}----');
    } else if (this.page === 2) {
      s.label(1, 'TGT SPEED', 'CRZ ALT');
      s.line(1, p.crzMode === 'MACH' ? fmtMach(p.crzMach) : p.crzMode === 'LRC' ? 'LRC' : 'MAX SPD', p.crzAlt ? fmtAlt(p.crzAlt, ta) : `{w}${boxes(5)}`);
      s.label(2, 'OPT ALT', 'MAX ALT');
      s.line(2, `{s}${fmtAlt(fms.optAlt(), ta)}`, `{s}${fmtAlt(fms.maxAlt(), ta)}`);
      const tod = fms.pred?.tod;
      s.label(3, 'TO T/D');
      s.line(3, tod ? `{s}${fmtDist(tod.dist - fms.guidance.traveledSincePred)}NM  ${fmtEte(tod.ete)}` : '{w}{s}----');
    } else {
      s.label(1, 'TGT SPEED', 'TRANS FL');
      s.line(1, `${fmtMach(p.desMach)}/${p.desIas}`, fmtAlt(p.transLvl, 0));
      s.label(2, 'SPD/ALT LIMIT');
      s.line(2, `${p.desLimIas}/${p.desLimAlt}`);
      s.label(3, 'VPA');
      s.line(3, `${p.vpa.toFixed(1)}°`);
      const v = fms.guidance.vnav;
      s.label(4, 'VERT DEV', 'TGT ALT');
      s.line(4, v.vdev != null ? `${v.vdev > 0 ? '+' : ''}${Math.round(v.vdev)}FT` : '{w}----', v.valid ? fmtAlt(v.tgtAlt, ta) : '{w}-----');
      const tod = fms.pred?.tod;
      s.label(5, 'TO T/D');
      s.line(5, tod && fms.phase !== 'DESCENT' && fms.phase !== 'APPROACH' ? `{s}${fmtDist(tod.dist - fms.guidance.traveledSincePred)}NM` : '{w}{s}----');
    }
    s.line(6, fms.modPerf ? '{w}<CANCEL MOD' : prompt('PERF MENU', 'L'));
  }
  lsk(side: Side, n: number) {
    const cdu = this.cdu;
    if (n === 6) { if (fms.modPerf) fms.cancelMod(); else cdu.show('PERF MENU'); return; }
    if (!cdu.hasEntry) return;
    const t = cdu.take().trim().toUpperCase();
    const p = fms.editPerf();
    const bad = () => cdu.error('INVALID ENTRY');
    const key = `${this.page}${side}${n}`;
    if (key === '1L1') {
      const m = /^(\d{3})?\/?(\.\d{2})?$/.exec(t);
      if (!m || (!m[1] && !m[2])) return bad();
      if (m[1]) p.clbIas = +m[1];
      if (m[2]) p.clbMach = parseFloat(m[2]);
    } else if (key === '1R1') { const v = parseAlt(t); if (v == null) return bad(); p.transAlt = v; }
    else if (key === '1L2' || key === '3L2') {
      const m = /^(\d{3})\/(\d{4,5})$/.exec(t);
      if (!m) return bad();
      if (key === '1L2') { p.clbLimIas = +m[1]; p.clbLimAlt = +m[2]; } else { p.desLimIas = +m[1]; p.desLimAlt = +m[2]; }
    } else if (key === '1L3' || key === '2R1') {
      const v = parseAlt(t); if (v == null || v > CRJ700.ceiling) return bad(); p.crzAlt = v;
    } else if (key === '2L1') {
      if (t === 'LRC') p.crzMode = 'LRC';
      else { const sp = parseSpeed(t); if (!sp?.mach) return bad(); p.crzMach = sp.mach; p.crzMode = 'MACH'; }
    } else if (key === '3L1') {
      const m = /^(\.\d{2})?\/?(\d{3})?$/.exec(t);
      if (!m || (!m[1] && !m[2])) return bad();
      if (m[1]) p.desMach = parseFloat(m[1]);
      if (m[2]) p.desIas = +m[2];
    } else if (key === '3R1') { const v = parseAlt(t); if (v == null) return bad(); p.transLvl = v; }
    else if (key === '3L3') { const v = parseFloat(t); if (!(v >= 1 && v <= 6)) return bad(); p.vpa = v; }
    else bad();
  }
}
registerPage('VNAV', (c) => new VnavPage(c));

// ---------------------------------------------------------------------------
class TakeoffPage extends Page {
  pages = 2;
  live = true;
  render(s: Screen) {
    const p = fms.perfView;
    const t = p.takeoff;
    const plan = fms.plan;
    if (!t.pilotSpeeds) fms.computeTakeoff(p);
    const info = fms.takeoffInfo(p);
    s.title('TAKEOFF REF', this.page, this.pages);
    if (this.page === 1) {
      s.label(1, 'RWY ID', 'RWY LENGTH');
      s.line(1, plan.origRwy ? `${plan.origin?.ident} RW${plan.origRwy.id}` : `{w}${dashes(5)}`, plan.origRwy ? `${plan.origRwy.length}FT` : '{w}-----');
      s.label(2, 'RWY WIND', 'HW/XW');
      let comp = '';
      if (t.wind && plan.origRwy) {
        const hdg = trueToMag(plan.origRwy.brg, plan.origRwy.lat, plan.origRwy.lon);
        const a = ((t.wind.dir - hdg) * Math.PI) / 180;
        const hw = Math.round(t.wind.spd * Math.cos(a)), xw = Math.round(t.wind.spd * Math.sin(a));
        comp = `${hw >= 0 ? 'H' : 'T'}${Math.abs(hw)} ${xw >= 0 ? 'R' : 'L'}${Math.abs(xw)}`;
      }
      s.line(2, t.wind ? fmtWind(t.wind) : `{w}${fmtWind(null)}`, `{s}${comp}`);
      s.label(3, 'OAT', 'QNH');
      s.line(3, t.oat != null ? fmtTemp(t.oat) : `{s}${fmtTemp(info.oat)}`, t.qnh != null ? t.qnh.toFixed(2) : '{s}29.92');
      s.label(4, 'RWY COND', 'A/I');
      s.line(4, t.cond, t.antiIce);
      s.label(5, 'T/O FLAPS', 'ELEV');
      s.line(5, String(t.flaps), `{s}${info.elev}FT`);
      s.line(6, prompt('PERF MENU', 'L'), prompt('NEXT', 'R'));
    } else {
      const big = t.pilotSpeeds || t.confirmed;
      const v = (x: number | null) => (x == null ? '{w}---' : big ? String(x) : `{s}${x}`);
      s.label(1, 'V1', 'TOW');
      s.line(1, v(t.v1), info.overweight ? `{a}${info.tow}` : `{s}${info.tow}`);
      s.label(2, 'VR', 'TOFL/RWY');
      s.line(2, v(t.vr), `{s}${info.tofl}/${plan.origRwy?.length ?? '----'}`);
      s.label(3, 'V2', 'TO N1');
      s.line(3, v(t.v2), `{s}${info.n1.toFixed(1)}%`);
      s.label(4, 'VT');
      s.line(4, v(t.vt));
      if (info.rwyLen && info.tofl > info.rwyLen) s.label(5, '{a}RWY LENGTH LIMITED');
      s.line(6, prompt('PERF MENU', 'L'), t.confirmed ? '{g}{s}SPEEDS SET' : prompt('SET SPEEDS', 'R'));
    }
  }
  lsk(side: Side, n: number) {
    const cdu = this.cdu;
    if (n === 6) {
      if (side === 'L') { cdu.show('PERF MENU'); return; }
      if (this.page === 1) { this.page = 2; return; }
      const t = fms.perf.takeoff;
      if (t.v1 == null) { cdu.error('INVALID ENTRY'); return; }
      t.confirmed = true;
      fms.clearMessage('CHECK T/O SPEEDS');
      fms.changed();
      return;
    }
    const p = fms.perf; // takeoff data applies immediately
    const t = p.takeoff;
    if (cdu.isDelete) {
      cdu.take();
      if (this.page === 2) { t.pilotSpeeds = false; t.confirmed = false; fms.computeTakeoff(p); return; }
      if (n === 2 && side === 'L') t.wind = null;
      if (n === 3 && side === 'L') t.oat = null;
      if (n === 3 && side === 'R') t.qnh = null;
      return;
    }
    const bad = () => cdu.error('INVALID ENTRY');
    if (!cdu.hasEntry) {
      if (this.page === 1 && n === 4) {
        if (side === 'L') t.cond = t.cond === 'DRY' ? 'WET' : 'DRY';
        else t.antiIce = t.antiIce === 'OFF' ? 'ENG' : t.antiIce === 'ENG' ? 'ALL' : 'OFF';
        t.confirmed = false;
        return;
      }
      if (this.page === 1 && n === 5 && side === 'L') { t.flaps = t.flaps === 8 ? 20 : 8; t.confirmed = false; return; }
      return;
    }
    const s = cdu.take().trim().toUpperCase();
    t.confirmed = false;
    if (this.page === 1) {
      const key = side + n;
      if (key === 'L1') {
        const plan = fms.editPlan();
        const rw = plan.origin?.runways.find((r) => r.id === s.replace(/^RW/, ''));
        if (!rw) return bad();
        plan.setOrigRwy(rw);
      } else if (key === 'L2') { const w = parseWind(s); if (!w) return bad(); t.wind = w; }
      else if (key === 'L3') { const v = parseTemp(s); if (v == null) return bad(); t.oat = v; }
      else if (key === 'R3') { const v = parseFloat(s); if (!(v > 27 && v < 32)) return bad(); t.qnh = v; }
      else if (key === 'L5') { const v = parseInt(s, 10); if (v !== 8 && v !== 20) return bad(); t.flaps = v; }
      else return bad();
      if (!t.pilotSpeeds) fms.computeTakeoff(p);
      return;
    }
    if (side === 'L' && n <= 4) {
      const v = parseInt(s, 10);
      if (!(v >= 90 && v <= 230)) return bad();
      t.pilotSpeeds = true;
      if (n === 1) t.v1 = v; else if (n === 2) t.vr = v; else if (n === 3) t.v2 = v; else t.vt = v;
      if (t.v1 != null && t.vr != null && t.v1 > t.vr) cdu.error('V1 > VR');
      return;
    }
    bad();
  }
}
registerPage('TAKEOFF', (c) => new TakeoffPage(c));

// ---------------------------------------------------------------------------
class ApproachPage extends Page {
  live = true;
  render(s: Screen) {
    const p = fms.perfView;
    const ap = p.approach;
    const a = fms.approachSpeeds(p);
    const plan = fms.plan;
    s.title('APPROACH REF', 1, 1);
    s.label(1, 'LDG FLAPS', 'LW (LB)');
    s.line(1, String(ap.flaps), a.overweight ? `{a}${a.lw}` : `{s}${a.lw}`);
    s.label(2, 'VREF', 'RWY');
    s.line(2, ap.pilotVref ? String(a.vref) : `{s}${a.vref}`, plan.destRwy ? `${plan.dest?.ident} RW${plan.destRwy.id}` : '{w}-----');
    s.label(3, 'VAPP', 'LDG DIST/RWY');
    s.line(3, ap.pilotVapp ? String(a.vapp) : `{s}${a.vapp}`, `{s}${a.ld}/${a.rwyLen ?? '----'}`);
    s.label(4, 'VGA', 'RWY COND');
    s.line(4, `{s}${a.vga}`, ap.cond);
    s.label(5, 'WIND/GUST', 'QNH');
    s.line(5, ap.wind ? `${fmtWind(ap.wind)}${ap.gust ? 'G' + ap.gust : ''}` : `{w}${fmtWind(null)}`, ap.qnh != null ? ap.qnh.toFixed(2) : '{w}--.--');
    s.line(6, prompt('PERF MENU', 'L'));
    void fmtZulu;
  }
  lsk(side: Side, n: number) {
    const cdu = this.cdu;
    if (n === 6) { cdu.show('PERF MENU'); return; }
    const ap = fms.perf.approach;
    if (cdu.isDelete) {
      cdu.take();
      if (n === 2) { ap.pilotVref = false; ap.vref = null; }
      if (n === 3) { ap.pilotVapp = false; ap.vapp = null; }
      if (n === 5) { ap.wind = null; ap.gust = 0; }
      return;
    }
    if (!cdu.hasEntry) {
      if (n === 1 && side === 'L') { ap.flaps = ap.flaps === 45 ? 30 : 45; return; }
      if (n === 4 && side === 'R') { ap.cond = ap.cond === 'DRY' ? 'WET' : 'DRY'; return; }
      return;
    }
    const t = cdu.take().trim().toUpperCase();
    const bad = () => cdu.error('INVALID ENTRY');
    const key = side + n;
    if (key === 'L1') { const v = parseInt(t, 10); if (v !== 30 && v !== 45) return bad(); ap.flaps = v; }
    else if (key === 'L2') { const v = parseInt(t, 10); if (!(v >= 100 && v <= 180)) return bad(); ap.vref = v; ap.pilotVref = true; }
    else if (key === 'L3') { const v = parseInt(t, 10); if (!(v >= 100 && v <= 200)) return bad(); ap.vapp = v; ap.pilotVapp = true; }
    else if (key === 'L5') {
      const m = /^(\d{1,3})\/(\d{1,3})(?:G(\d{1,2}))?$/.exec(t);
      if (!m) return bad();
      ap.wind = { dir: +m[1] % 360, spd: +m[2] };
      ap.gust = m[3] ? Math.max(0, +m[3] - +m[2]) : 0;
    } else if (key === 'R5') { const v = parseFloat(t); if (!(v > 27 && v < 32)) return bad(); ap.qnh = v; }
    else bad();
  }
}
registerPage('APPROACH', (c) => new ApproachPage(c));

// ---------------------------------------------------------------------------
class PerfDataPage extends Page {
  live = true;
  render(s: Screen) {
    const pr = fms.pred;
    const p = fms.perf;
    s.title('PERF DATA', 1, 1);
    s.label(1, 'DEST', 'ETA');
    const dest = fms.active.dest;
    s.line(1, dest?.ident ?? '{w}----', pr?.valid ? `${fmtZulu(fms.eta(pr.destEte))}Z` : '{w}----Z');
    s.label(2, 'DIST', 'ETE');
    s.line(2, pr?.valid ? fmtDist(pr.destDist) : '{w}----', pr?.valid ? fmtEte(pr.destEte) : '{w}-:--');
    s.label(3, 'FUEL AT DEST', 'RESERVE');
    const low = pr?.valid && pr.destFuel < p.reserve;
    s.line(3, pr?.valid ? (low ? `{a}${lbs(pr.destFuel)}` : lbs(pr.destFuel)) : '{w}----', lbs(p.reserve));
    s.label(4, 'TRIP FUEL', 'LDG WT');
    s.line(4, pr?.valid ? lbs(pr.totalFuelBurn) : '{w}----', pr?.valid ? lbs(fms.estLandingWeight()) : '{w}-----');
    s.label(5, 'T/C', 'T/D');
    s.line(5, pr?.toc ? `{s}${fmtDist(pr.toc.dist)}NM` : '{w}{s}----', pr?.tod ? `{s}${fmtDist(pr.tod.dist)}NM` : '{w}{s}----');
    s.line(6, prompt('PERF MENU', 'L'));
  }
  lsk(side: Side, n: number) {
    if (n === 6 && side === 'L') this.cdu.show('PERF MENU');
  }
}
registerPage('PERF DATA', (c) => new PerfDataPage(c));

// ---------------------------------------------------------------------------
class FuelMgmtPage extends Page {
  pages = 2;
  live = true;
  render(s: Screen) {
    const ac = sim.ac.s;
    const p = fms.perf;
    s.title('FUEL MGMT', this.page, this.pages);
    const ff = Math.max(1, ac.ff);
    if (this.page === 1) {
      s.label(1, 'FUEL', 'FUEL FLOW');
      s.line(1, `${lbs(ac.fuel)} LB`, `${lbs(ac.ff)} PPH`);
      s.label(2, 'RESERVES', 'ENDURANCE');
      s.line(2, lbs(p.reserve), ac.ff > 10 ? fmtEte((ac.fuel / ff) * 3600) : '{w}-:--');
      s.label(3, 'TO RESERVES', 'RANGE');
      const tr = ac.ff > 10 ? fmtEte((Math.max(0, ac.fuel - p.reserve) / ff) * 3600) : '-:--';
      const rng = ac.ff > 10 ? Math.round((ac.fuel / ff) * ac.gs) : 0;
      s.line(3, tr, ac.ff > 10 && ac.gs > 50 ? `${rng} NM` : '{w}----');
      s.label(4, 'SPC RNG', 'GS');
      s.line(4, ac.gs > 50 && ac.ff > 10 ? `{s}${((ac.gs / ff) * 1000).toFixed(0)} NM/1000LB` : '{w}{s}----', String(Math.round(ac.gs)));
      s.line(6, prompt('PERF MENU', 'L'));
    } else {
      const L = fms.log;
      s.label(1, 'FUEL USED', 'SINCE');
      const start = L.fuelAtOut ?? ac.fuel;
      s.line(1, `${lbs(start - ac.fuel)} LB`, L.outTime != null ? `${fmtZulu(L.outTime)}Z` : '{w}----Z');
      s.label(2, 'ENG 1 FF', 'ENG 2 FF');
      s.line(2, `${lbs(ac.ff / 2)}`, `${lbs(ac.ff / 2)}`);
      s.label(3, 'L WING', 'R WING');
      const wing = Math.min(ac.fuel / 2, 7400);
      s.line(3, lbs(wing), lbs(wing));
      s.label(4, 'CENTER', 'TOTAL');
      s.line(4, lbs(Math.max(0, ac.fuel - 2 * wing)), lbs(ac.fuel));
      s.line(6, prompt('PERF MENU', 'L'));
    }
  }
  lsk(side: Side, n: number) {
    if (n === 6 && side === 'L') this.cdu.show('PERF MENU');
  }
}
registerPage('FUEL MGMT', (c) => new FuelMgmtPage(c));

class FltLogPage extends Page {
  live = true;
  render(s: Screen) {
    const L = fms.log;
    const ac = sim.ac.s;
    s.title('FLT LOG', 1, 1);
    const z = (t: number | null) => (t != null ? `${fmtZulu(t)}Z` : '{w}----Z');
    s.label(1, 'OUT', 'OFF');
    s.line(1, z(L.outTime), z(L.offTime));
    s.label(2, 'ON', 'IN');
    s.line(2, z(L.onTime), z(L.inTime));
    s.label(3, 'FLT TIME', 'BLOCK TIME');
    const now = sim.utc;
    const flt = L.offTime != null ? ((L.onTime ?? now) - L.offTime + 86400) % 86400 : null;
    const blk = L.outTime != null ? ((L.inTime ?? now) - L.outTime + 86400) % 86400 : null;
    s.line(3, flt != null ? fmtEte(flt) : '{w}-:--', blk != null ? fmtEte(blk) : '{w}-:--');
    s.label(4, 'FUEL USED', 'FUEL REM');
    s.line(4, L.fuelAtOut != null ? lbs(L.fuelAtOut - ac.fuel) : '{w}----', lbs(ac.fuel));
    s.line(6, prompt('PERF MENU', 'L'));
  }
  lsk(side: Side, n: number) {
    if (n === 6 && side === 'L') this.cdu.show('PERF MENU');
  }
}
registerPage('FLT LOG', (c) => new FltLogPage(c));

export type { PerfInit };
