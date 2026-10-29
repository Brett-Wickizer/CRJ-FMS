// INDEX, STATUS, POS INIT, MESSAGES, SELECT WPT, MCDU MENU, NEAREST APTS, CONVERSION, DEFAULTS
import { Page, registerPage, Side, Cdu } from '../cdu';
import type { Screen } from '../screen';
import { boxes } from '../screen';
import { fms } from '../../fms/fms';
import { navdb, Waypoint, navaidTypeName } from '../../nav/navdb';
import { fmtLatLon, distance, bearing, parseLatLon } from '../../util/geo';
import { trueToMag } from '../../util/magvar';
import { fmtDate, fmtIsoDate, fmtZulu, fmtCrs, fmtEte, parseWeight, parseTemp, fmtDist } from '../fmt';
import { prompt } from './common';
import { sim } from '../../sim/sim';

// ---------------------------------------------------------------------------
class IndexPage extends Page {
  pages = 2;
  render(s: Screen) {
    s.title('INDEX', this.page, this.pages);
    if (this.page === 1) {
      s.line(1, prompt('STATUS', 'L'), prompt('DATA BASE', 'R'));
      s.line(2, prompt('POS INIT', 'L'), prompt('PILOT WPT', 'R'));
      s.line(3, prompt('VOR CTL', 'L'), prompt('ROUTE MENU', 'R'));
      s.line(4, prompt('GNSS CTL', 'L'), prompt('DEFAULTS', 'R'));
      s.line(5, prompt('NRST APTS', 'L'), prompt('CONVERSION', 'R'));
      s.line(6, prompt('FLT LOG', 'L'), prompt('FUEL MGMT', 'R'));
    } else {
      s.line(1, prompt('TAKEOFF', 'L'), prompt('PERF INIT', 'R'));
      s.line(2, prompt('APPROACH', 'L'), prompt('PERF DATA', 'R'));
      s.line(3, prompt('VNAV SETUP', 'L'), prompt('SEC FPLN', 'R'));
      s.line(4, prompt('HOLD', 'L'), prompt('FIX INFO', 'R'));
      s.line(5, prompt('MESSAGES', 'L'), prompt('MCDU MENU', 'R'));
    }
  }
  lsk(side: Side, n: number) {
    const map1: Record<string, string> = {
      L1: 'STATUS', L2: 'POS INIT', L3: 'VOR CTL', L4: 'GNSS CTL', L5: 'NEAREST APTS', L6: 'FLT LOG',
      R1: 'DATA BASE', R2: 'PILOT WPT LIST', R3: 'ROUTE MENU', R4: 'DEFAULTS', R5: 'CONVERSION', R6: 'FUEL MGMT',
    };
    const map2: Record<string, string> = {
      L1: 'TAKEOFF', L2: 'APPROACH', L3: 'VNAV', L4: 'HOLD', L5: 'MESSAGES',
      R1: 'PERF INIT', R2: 'PERF DATA', R3: 'SECFPLN', R4: 'FIX', R5: 'MCDU MENU',
    };
    const id = (this.page === 1 ? map1 : map2)[side + n];
    if (id) this.cdu.show(id);
  }
}
registerPage('INDEX', (c) => new IndexPage(c));

// ---------------------------------------------------------------------------
class StatusPage extends Page {
  live = true;
  render(s: Screen) {
    const m = navdb.meta;
    s.title('STATUS');
    s.label(1, 'NAV DATA');
    s.line(1, m?.name ?? 'WORLD', `{s}CYCLE ${m?.cycle.ident ?? ''}`);
    const today = sim.dateStr;
    const expired = m && today > m.cycle.exp;
    s.label(2, 'ACTIVE DATA BASE');
    s.line(2, m ? `${fmtIsoDate(m.cycle.eff)} ${fmtIsoDate(m.cycle.exp)}` : '', '', { color: expired ? 'a' : 'g' });
    s.label(3, 'SEC DATA BASE');
    s.line(3, m ? `${fmtIsoDate(m.cycle.prevEff)} ${fmtIsoDate(m.cycle.prevExp)}` : '', '', { small: true });
    s.label(4, 'UTC', 'DATE');
    const d = new Date(sim.dateStr + 'T00:00:00Z');
    s.line(4, `${fmtZulu(sim.utc)}Z`, fmtDate(d));
    s.label(5, 'PROGRAM', 'FMS-4200');
    s.line(5, '{w}SCID 832-6614-101');
    s.line(6, prompt('INDEX', 'L'), prompt('POS INIT', 'R'));
  }
  lsk(side: Side, n: number) {
    if (n === 6) this.cdu.show(side === 'L' ? 'INDEX' : 'POS INIT');
    else super.lsk(side, n);
  }
}
registerPage('STATUS', (c) => new StatusPage(c));

// ---------------------------------------------------------------------------
class PosInitPage extends Page {
  live = true;
  private refWpt: Waypoint | null = null;
  constructor(cdu: Cdu) {
    super(cdu);
    this.refWpt = fms.posRefWpt ?? (fms.active.origin ? fms.aptWpt(fms.active.origin) : null);
  }
  render(s: Screen) {
    s.title('POS INIT', 1, 1);
    const last = fms.lastPos ?? fms.gpsPos;
    s.label(1, 'LAST POS');
    s.line(1, '', `${fmtLatLon(last)}{w}>`);
    s.label(2, 'REF WPT');
    if (this.refWpt) {
      const id = this.refWpt.ident.slice(0, 5).padEnd(5);
      s.line(2, id, `${fmtLatLon(this.refWpt)}{w}>`);
    } else s.line(2, '{w}-----');
    s.label(3, 'GPS1 POS');
    s.line(3, '', `${fmtLatLon(fms.gpsPos)}{w}>`);
    s.label(4, 'FMS POS');
    s.line(4, '', fmtLatLon(fms.posInit ? fms.fmsPos : fms.gpsPos), { color: fms.posInit ? 'g' : 'w', small: !fms.posInit });
    s.label(5, 'SET POS');
    s.line(5, fms.posInit ? fmtLatLon(fms.fmsPos) : `{w}${boxes(18)}`);
    s.line(6, prompt('INDEX', 'L'), prompt('FPLN', 'R'));
  }
  lsk(side: Side, n: number) {
    if (n === 6) { this.cdu.show(side === 'L' ? 'INDEX' : 'FPLN'); return; }
    if (side === 'L' && n === 2) {
      const t = this.cdu.take();
      if (!t) return;
      this.cdu.resolveWaypoint(t, fms.ac.pos, (w) => { this.refWpt = w; fms.posRefWpt = w; });
      return;
    }
    if (side === 'L' && n === 5) {
      const t = this.cdu.take();
      const p = parseLatLon(t);
      if (!p) { this.cdu.error('INVALID ENTRY'); return; }
      fms.setPosition(p);
      return;
    }
    if (side === 'R') {
      const pos = n === 1 ? (fms.lastPos ?? fms.gpsPos) : n === 2 ? this.refWpt : n === 3 ? fms.gpsPos : null;
      if (!pos) { this.cdu.error('INVALID ENTRY'); return; }
      fms.setPosition({ lat: pos.lat, lon: pos.lon });
      fms.lastPos = { lat: pos.lat, lon: pos.lon };
      return;
    }
    super.lsk(side, n);
  }
}
registerPage('POS INIT', (c) => new PosInitPage(c));

// ---------------------------------------------------------------------------
class MessagesPage extends Page {
  live = true;
  update() {
    this.pages = Math.max(1, Math.ceil(fms.messages.length / 5));
    if (this.page > this.pages) this.page = this.pages;
  }
  render(s: Screen) {
    s.title('MESSAGES', this.page, this.pages);
    const list = fms.messages.slice((this.page - 1) * 5, this.page * 5);
    if (!fms.messages.length) s.centerLine(3, '{w}NO MESSAGES');
    list.forEach((m, i) => {
      s.label(i + 1, '', `${fmtZulu(m.time)}Z`);
      s.line(i + 1, m.text, '', { color: m.alert ? 'a' : 'w', small: !m.isNew && false });
    });
    s.line(6, prompt('RETURN', 'L'), fms.messages.length ? prompt('CLEAR ALL', 'R') : '');
  }
  lsk(side: Side, n: number) {
    if (n === 6) {
      if (side === 'L') this.cdu.returnToPrevious();
      else { fms.messages = []; fms.changed(); }
      return;
    }
    if (this.cdu.isDelete) {
      const m = fms.messages[(this.page - 1) * 5 + n - 1];
      if (m) { this.cdu.take(); fms.clearMessage(m.text); }
      return;
    }
    super.lsk(side, n);
  }
}
registerPage('MESSAGES', (c) => new MessagesPage(c));

// ---------------------------------------------------------------------------
interface SelectArgs {
  list: Waypoint[];
  ref: { lat: number; lon: number };
  pick: (w: Waypoint) => void;
  cancel: () => void;
}
class SelectWptPage extends Page {
  constructor(cdu: Cdu, private a: SelectArgs) {
    super(cdu);
    this.pages = Math.ceil(a.list.length / 5);
  }
  render(s: Screen) {
    s.title('SELECT WPT', this.page, this.pages);
    const items = this.a.list.slice((this.page - 1) * 5, this.page * 5);
    items.forEach((w, i) => {
      const d = distance(this.a.ref, w);
      const type = navaidTypeName(w);
      const freq = w.freq ? (w.kind === 'NDB' ? ` ${Math.round(w.freq)}` : ` ${w.freq.toFixed(2)}`) : '';
      s.label(i + 1, `${w.ident} ${type}${freq}`, `${fmtDist(d)}NM`);
      s.line(i + 1, `<${fmtLatLon(w)}`, `{s}${(w.country ?? w.region ?? '').slice(0, 3)}`);
    });
    s.line(6, prompt('CANCEL', 'L'));
  }
  lsk(side: Side, n: number) {
    if (n === 6 && side === 'L') { this.a.cancel(); return; }
    const w = this.a.list[(this.page - 1) * 5 + n - 1];
    if (w && side === 'L') this.a.pick(w);
  }
}
registerPage('SELECT WPT', (c, a) => new SelectWptPage(c, a));

// ---------------------------------------------------------------------------
class McduMenuPage extends Page {
  render(s: Screen) {
    s.title('MCDU MENU', 1, 1);
    s.line(1, '{w}<FMS1', '{g}{s}ACT');
    s.line(2, '{w}<GPS1');
    s.line(3, '{w}<SIM CONTROL');
    s.line(4, '{w}<SIM WEATHER');
    s.line(5, '{w}<KEYBOARD HELP');
  }
  lsk(side: Side, n: number) {
    if (side !== 'L') return super.lsk(side, n);
    const id = ['INDEX', 'GNSS CTL', 'SIM', 'SIM WX', 'HELP'][n - 1];
    if (id) this.cdu.show(id);
  }
}
registerPage('MCDU MENU', (c) => new McduMenuPage(c));

class HelpPage extends Page {
  pages = 2;
  render(s: Screen) {
    s.title('KEYBOARD', this.page, this.pages);
    if (this.page === 1) {
      s.label(1, 'TYPE');
      s.line(1, '{w}A-Z 0-9 . / SPACE', '', {});
      s.label(2, 'CLR / DEL');
      s.line(2, '{w}BACKSPACE / DELETE');
      s.label(3, 'EXEC');
      s.line(3, '{w}ENTER');
      s.label(4, 'LSK 1L-6L');
      s.line(4, '{w}F1-F6');
      s.label(5, 'LSK 1R-6R');
      s.line(5, '{w}SHIFT+F1-F6');
    } else {
      s.label(1, 'PREV / NEXT PAGE');
      s.line(1, '{w}PAGE UP / PAGE DOWN');
      s.label(2, '+/-');
      s.line(2, '{w}- OR +');
      s.label(3, 'SPACE BAR');
      s.line(3, '{w}SP');
      s.label(4, 'CLEAR ALL');
      s.line(4, '{w}HOLD CLR / ESC');
    }
    s.line(6, prompt('MCDU MENU', 'L'));
  }
  lsk(side: Side, n: number) {
    if (n === 6 && side === 'L') this.cdu.show('MCDU MENU');
  }
}
registerPage('HELP', (c) => new HelpPage(c));

// ---------------------------------------------------------------------------
class NearestPage extends Page {
  live = true;
  private minRwy = 5000;
  render(s: Screen) {
    s.title('NEAREST APTS', 1, 1);
    const list = navdb.nearestAirports(fms.ac.pos, 5, this.minRwy);
    s.label(1, 'APT    BRG  DIST  ETE');
    list.forEach((e, i) => {
      const brg = trueToMag(e.brg, fms.ac.pos.lat, fms.ac.pos.lon);
      const ete = fms.ac.gs > 50 ? fmtEte((e.dist / fms.ac.gs) * 3600) : '-:--';
      const line = `<${e.apt.ident.padEnd(5)}${fmtCrs(brg).padStart(5)} ${fmtDist(e.dist).padStart(5)} ${ete.padStart(5)}`;
      s.line(i + 1, line);
      if (i > 0) s.label(i + 1, e.apt.name.slice(0, 24));
    });
    if (list[0]) s.label(1, `APT    BRG  DIST  ETE`);
    s.label(6, '', 'MIN RWY');
    s.line(6, prompt('INDEX', 'L'), `${this.minRwy}FT`);
  }
  lsk(side: Side, n: number) {
    if (n === 6) {
      if (side === 'L') { this.cdu.show('INDEX'); return; }
      const t = this.cdu.take();
      const v = parseInt(t, 10);
      if (!t || !(v >= 1000 && v <= 15000)) { this.cdu.error('INVALID ENTRY'); return; }
      this.minRwy = v;
      return;
    }
    const list = navdb.nearestAirports(fms.ac.pos, 5, this.minRwy);
    const e = list[n - 1];
    if (e && side === 'L') this.cdu.setScratch(e.apt.ident);
  }
}
registerPage('NEAREST APTS', (c) => new NearestPage(c));

// ---------------------------------------------------------------------------
class ConversionPage extends Page {
  private v = { ft: null as number | null, lb: null as number | null, f: null as number | null, inhg: null as number | null, gal: null as number | null };
  render(s: Screen) {
    s.title('CONVERSION', 1, 1);
    const v = this.v;
    s.label(1, 'FT', 'M');
    s.line(1, v.ft != null ? String(Math.round(v.ft)) : '{w}----', v.ft != null ? String(Math.round(v.ft * 0.3048)) : '{w}----');
    s.label(2, 'LB', 'KG');
    s.line(2, v.lb != null ? String(Math.round(v.lb)) : '{w}----', v.lb != null ? String(Math.round(v.lb * 0.45359)) : '{w}----');
    s.label(3, '°F', '°C');
    s.line(3, v.f != null ? String(Math.round(v.f)) : '{w}---', v.f != null ? String(Math.round(((v.f - 32) * 5) / 9)) : '{w}---');
    s.label(4, 'IN HG', 'HPA');
    s.line(4, v.inhg != null ? v.inhg.toFixed(2) : '{w}--.--', v.inhg != null ? String(Math.round(v.inhg * 33.8639)) : '{w}----');
    s.label(5, 'FUEL LB', 'US GAL');
    s.line(5, v.gal != null ? String(Math.round(v.gal * 6.7)) : '{w}----', v.gal != null ? String(Math.round(v.gal)) : '{w}----');
    s.line(6, prompt('INDEX', 'L'));
  }
  lsk(side: Side, n: number) {
    if (n === 6) { this.cdu.show('INDEX'); return; }
    const t = this.cdu.take().replace('+', '');
    const x = parseFloat(t);
    if (!t || Number.isNaN(x)) { this.cdu.error('INVALID ENTRY'); return; }
    const L = side === 'L';
    switch (n) {
      case 1: this.v.ft = L ? x : x / 0.3048; break;
      case 2: this.v.lb = L ? x : x / 0.45359; break;
      case 3: this.v.f = L ? x : (x * 9) / 5 + 32; break;
      case 4: this.v.inhg = L ? x : x / 33.8639; break;
      case 5: this.v.gal = L ? x / 6.7 : x; break;
    }
  }
}
registerPage('CONVERSION', (c) => new ConversionPage(c));

// ---------------------------------------------------------------------------
const DEFAULTS_KEY = 'crjfms.defaults.v1';
export function loadDefaults() {
  try {
    const d = JSON.parse(localStorage.getItem(DEFAULTS_KEY) || 'null');
    if (d) Object.assign(fms.perf, d);
  } catch { /* storage unavailable */ }
}
function saveDefaults() {
  const p = fms.perf;
  const d = { bow: p.bow, paxWt: p.paxWt, reserve: p.reserve, taxiFuel: p.taxiFuel, tailNo: p.tailNo, clbIas: p.clbIas, clbMach: p.clbMach, crzMach: p.crzMach, desMach: p.desMach, desIas: p.desIas };
  try { localStorage.setItem(DEFAULTS_KEY, JSON.stringify(d)); } catch { /* storage unavailable */ }
}

class DefaultsPage extends Page {
  render(s: Screen) {
    const p = fms.perf;
    s.title('DEFAULTS', 1, 1);
    s.label(1, 'BOW (LB)', 'TAIL #');
    s.line(1, String(p.bow), p.tailNo);
    s.label(2, 'PAX WT', 'TAXI FUEL');
    s.line(2, String(p.paxWt), String(p.taxiFuel));
    s.label(3, 'RESERVE FUEL', 'CLB IAS/M');
    s.line(3, String(p.reserve), `${p.clbIas}/.${Math.round(p.clbMach * 100)}`);
    s.label(4, 'CRZ MACH', 'DES M/IAS');
    s.line(4, `.${Math.round(p.crzMach * 100)}`, `.${Math.round(p.desMach * 100)}/${p.desIas}`);
    s.line(6, prompt('INDEX', 'L'));
  }
  lsk(side: Side, n: number) {
    if (n === 6) { this.cdu.show('INDEX'); return; }
    const t = this.cdu.take();
    if (!t) return;
    const p = fms.perf;
    const bad = () => this.cdu.error('INVALID ENTRY');
    const key = side + n;
    if (key === 'L1') { const v = parseWeight(t); if (v && v > 30000 && v < 55000) p.bow = v; else return bad(); }
    else if (key === 'R1') { if (/^[A-Z0-9-]{2,7}$/.test(t)) p.tailNo = t; else return bad(); }
    else if (key === 'L2') { const v = parseInt(t, 10); if (v >= 100 && v <= 300) p.paxWt = v; else return bad(); }
    else if (key === 'R2') { const v = parseWeight(t); if (v != null && v <= 2000) p.taxiFuel = v; else return bad(); }
    else if (key === 'L3') { const v = parseWeight(t); if (v != null && v <= 8000) p.reserve = v; else return bad(); }
    else if (key === 'R3') {
      const m = /^(\d{3})\/\.?(\d{2})$/.exec(t);
      if (!m) return bad();
      p.clbIas = +m[1]; p.clbMach = +m[2] / 100;
    } else if (key === 'L4') {
      const m = /^\.?(\d{2})$/.exec(t);
      if (!m) return bad();
      p.crzMach = +m[1] / 100;
    } else if (key === 'R4') {
      const m = /^\.?(\d{2})\/(\d{3})$/.exec(t);
      if (!m) return bad();
      p.desMach = +m[1] / 100; p.desIas = +m[2];
    } else return bad();
    saveDefaults();
    void parseTemp; void bearing;
  }
}
registerPage('DEFAULTS', (c) => new DefaultsPage(c));
