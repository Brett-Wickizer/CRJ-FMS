// DEP/ARR INDEX, DEPART and ARRIVAL pages.
import { Page, registerPage, Side, Cdu } from '../cdu';
import type { Screen } from '../screen';
import { boxes, dashes } from '../screen';
import { fms } from '../../fms/fms';
import { navdb, Airport, ProcSet, runwaySortKey } from '../../nav/navdb';
import { FlightPlan, approachName } from '../../fms/flightplan';
import { distance } from '../../util/geo';
import { cancelModPrompt, prompt } from './common';

type Which = 'ACT' | 'SEC';
const planOf = (w: Which) => (w === 'ACT' ? fms.plan : fms.sec);
const editOf = (w: Which) => (w === 'ACT' ? fms.editPlan() : fms.sec);

class DepArrIndexPage extends Page {
  private other: Airport | null = null;
  render(s: Screen) {
    s.title('DEP/ARR INDEX', 1, 1);
    const a = fms.plan, b = fms.sec;
    s.label(1, '', '', 'ACT FPLN');
    s.line(1, a.origin ? '{w}<DEPART' : '', a.origin ? '{w}ARRIVE>' : '');
    s.center(2, a.origin?.ident ?? '----', { color: 'g' });
    s.line(2, '', a.dest ? '{w}ARRIVE>' : '');
    s.center(4, a.dest?.ident ?? '----', { color: 'g' });
    s.label(3, '', '', 'SEC FPLN');
    s.line(3, b.origin ? '{w}<DEPART' : '', b.origin ? '{w}ARRIVE>' : '');
    s.center(6, b.origin?.ident ?? '----', { color: 'g' });
    s.line(4, '', b.dest ? '{w}ARRIVE>' : '');
    s.center(8, b.dest?.ident ?? '----', { color: 'g' });
    s.label(5, '', '', 'OTHER');
    s.line(5, '{w}<DEPART', '{w}ARRIVE>');
    s.center(10, this.other?.ident ?? boxes(4), { color: this.other ? 'g' : 'w' });
  }
  lsk(side: Side, n: number) {
    const cdu = this.cdu;
    const go = (apt: Airport | null, which: Which, dep: boolean, other = false) => {
      if (!apt) { cdu.error('INVALID ENTRY'); return; }
      cdu.show(dep ? 'DEPART' : 'ARRIVAL', { apt, which, other });
    };
    if (n === 5) {
      if (cdu.hasEntry) {
        const apt = navdb.getAirport(cdu.take().trim());
        if (!apt) { cdu.error('NOT IN DATA BASE'); return; }
        this.other = apt;
      }
      go(this.other, 'ACT', side === 'L', true);
      return;
    }
    const a = fms.plan, b = fms.sec;
    if (n === 1) go(a.origin, 'ACT', side === 'L');
    else if (n === 2 && side === 'R') go(a.dest, 'ACT', false);
    else if (n === 3) go(b.origin, 'SEC', side === 'L');
    else if (n === 4 && side === 'R') go(b.dest, 'SEC', false);
    else cdu.error('INVALID ENTRY');
  }
}
registerPage('DEPARR INDEX', (c) => new DepArrIndexPage(c));

/** DEP ARR key: DEPART on the ground near the origin, ARRIVAL when closer to the destination. */
registerPage('DEPARR', (c: Cdu) => {
  const p = fms.plan;
  const ac = fms.ac;
  if (p.origin && ac.onGround && distance(ac.pos, p.origin) < 15) return new DepartPage(c, { apt: p.origin, which: 'ACT' });
  if (p.dest && p.origin && !ac.onGround && distance(ac.pos, p.dest) < distance(ac.pos, p.origin)) return new ArrivalPage(c, { apt: p.dest, which: 'ACT' });
  if (p.origin && !p.dest) return new DepartPage(c, { apt: p.origin, which: 'ACT' });
  return new DepArrIndexPage(c);
});

interface ProcArg {
  apt: Airport;
  which: Which;
  other?: boolean;
}

interface Item {
  text: string;
  sel?: boolean;
  act?: boolean;
  header?: string;
  onPick: () => void;
}

abstract class ProcPage extends Page {
  protected ps: ProcSet | null | undefined = undefined;
  constructor(cdu: Cdu, protected a: ProcArg) {
    super(cdu);
    this.ps = navdb.proceduresIfLoaded(a.apt.ident);
    if (this.ps === undefined) {
      void navdb.ensureProcedures(a.apt.ident).then((ps) => {
        this.ps = ps;
        if (this.cdu.page === this) this.cdu.render();
      });
    }
  }
  protected plan(): FlightPlan {
    return planOf(this.a.which);
  }
  protected edit(): FlightPlan {
    return editOf(this.a.which);
  }
  abstract leftItems(): Item[];
  abstract rightItems(): Item[];
  abstract titleText(): string;
  abstract headers(): [string, string];

  update() {
    const n = Math.max(this.leftItems().length, this.rightItems().length, 1);
    this.pages = Math.max(1, Math.ceil(n / 5));
    if (this.page > this.pages) this.page = this.pages;
  }

  render(s: Screen) {
    s.title(this.titleText(), this.page, this.pages);
    if (this.ps === undefined) { s.centerLine(3, '{w}LOADING'); return; }
    const L = this.leftItems().slice((this.page - 1) * 5, this.page * 5);
    const R = this.rightItems().slice((this.page - 1) * 5, this.page * 5);
    const [hl, hr] = this.headers();
    if (this.page === 1) s.label(1, hl, hr);
    const mark = (it: Item) => (it.act ? '{w}{s}<ACT>{/}' : it.sel ? '{w}{s}<SEL>{/}' : '');
    for (let n = 1; n <= 5; n++) {
      const l = L[n - 1], r = R[n - 1];
      if (l?.header) s.label(n, l.header);
      if (r?.header) s.right(n * 2 - 1, r.header, { color: 'w', small: true });
      if (l) s.left(n * 2, l.sel || l.act ? `{g}${l.text} ${mark(l)}` : `{w}<{g}${l.text}`);
      if (r) s.right(n * 2, r.sel || r.act ? `${mark(r)} {g}${r.text}` : `{g}${r.text}{w}>`);
    }
    if (this.a.which === 'SEC' || !cancelModPrompt(s)) s.line(6, prompt('DEP/ARR IDX', 'L'));
  }

  lsk(side: Side, n: number) {
    if (n === 6) {
      if (side === 'L') {
        if (this.a.which === 'ACT' && fms.isMod) fms.cancelMod();
        else this.cdu.show('DEPARR INDEX');
      }
      return;
    }
    const items = side === 'L' ? this.leftItems() : this.rightItems();
    const it = items[(this.page - 1) * 5 + n - 1];
    if (!it) { this.cdu.error('INVALID ENTRY'); return; }
    it.onPick();
    this.update();
  }
}

class DepartPage extends ProcPage {
  titleText() { return `DEPART ${this.a.apt.ident}`; }
  headers(): [string, string] { return ['RUNWAYS', 'DEPARTURES']; }
  private isOrigin() { return this.plan().origin?.ident === this.a.apt.ident; }

  leftItems(): Item[] {
    const p = this.plan();
    const apt = this.a.apt;
    const sid = this.isOrigin() && p.sid ? this.ps?.sids.find((x) => x.id === p.sid!.id) : undefined;
    const exec = this.a.which === 'ACT' && !fms.mod;
    if (this.isOrigin() && p.origRwy) {
      return [{ text: 'RW' + p.origRwy.id, sel: !exec, act: exec, onPick: () => this.ensureOrigin(() => this.edit().setOrigRwy(null)) }];
    }
    let rws = [...apt.runways].sort((a, b) => runwaySortKey(a.id) - runwaySortKey(b.id));
    if (sid && Object.keys(sid.rw).length) rws = rws.filter((r) => FlightPlan.rwyTransKey(sid.rw, r.id));
    return rws.map((r) => ({
      text: 'RW' + r.id + (r.length ? '' : ''),
      onPick: () => this.ensureOrigin(() => this.edit().setOrigRwy(r)),
    }));
  }

  rightItems(): Item[] {
    const ps = this.ps;
    if (!ps) return [];
    const p = this.plan();
    const exec = this.a.which === 'ACT' && !fms.mod;
    if (this.isOrigin() && p.sid) {
      const sid = ps.sids.find((x) => x.id === p.sid!.id);
      if (sid) {
        const items: Item[] = [{ text: sid.id, sel: !exec, act: exec, onPick: () => this.edit().clearSid() }];
        const trans = Object.keys(sid.en).sort();
        if (p.sid.trans) items.push({ header: 'TRANS', text: p.sid.trans, sel: !exec, act: exec, onPick: () => this.edit().insertSid(sid, null) });
        else trans.forEach((t, i) => items.push({ header: i === 0 ? 'TRANS' : undefined, text: t, onPick: () => this.edit().insertSid(sid, t) }));
        if (!trans.length && !p.sid.trans) items.push({ header: 'TRANS', text: 'NONE', sel: true, onPick: () => {} });
        return items;
      }
    }
    let sids = ps.sids;
    const rw = this.isOrigin() ? p.origRwy : null;
    if (rw) sids = sids.filter((x) => !Object.keys(x.rw).length || FlightPlan.rwyTransKey(x.rw, rw.id));
    return sids.map((sid) => ({
      text: sid.id,
      onPick: () => this.ensureOrigin(() => {
        const e = this.edit();
        const trans = Object.keys(sid.en);
        e.insertSid(sid, trans.length === 1 ? trans[0] : null);
      }),
    }));
  }

  private ensureOrigin(f: () => void) {
    const e = this.edit();
    if (e.origin?.ident !== this.a.apt.ident) e.setOrigin(this.a.apt);
    f();
  }
}
registerPage('DEPART', (c, a) => new DepartPage(c, a));

class ArrivalPage extends ProcPage {
  titleText() { return `ARRIVAL ${this.a.apt.ident}`; }
  headers(): [string, string] { return ['APPROACHES', 'STARS']; }
  private isDest() { return this.plan().dest?.ident === this.a.apt.ident; }

  leftItems(): Item[] {
    const ps = this.ps;
    const p = this.plan();
    const apt = this.a.apt;
    const exec = this.a.which === 'ACT' && !fms.mod;
    if (this.isDest() && p.app) {
      const app = ps?.apps.find((x) => x.id === p.app!.id);
      const items: Item[] = [{ text: p.app.name, sel: !exec, act: exec, onPick: () => this.edit().clearApproach() }];
      if (app) {
        if (p.app.trans) items.push({ header: 'TRANS', text: p.app.trans, sel: !exec, act: exec, onPick: () => this.edit().insertApproach(app, null) });
        else {
          const tr = Object.keys(app.tr).sort();
          items.push({ header: 'TRANS', text: 'VECTORS', sel: true, onPick: () => {} });
          tr.forEach((t) => items.push({ text: t, onPick: () => this.edit().insertApproach(app, t) }));
        }
      }
      return items;
    }
    const items: Item[] = [];
    const apps = [...(ps?.apps ?? [])].sort((a, b) => runwaySortKey(a.rwy || '99') - runwaySortKey(b.rwy || '99') || (a.ty < b.ty ? -1 : 1));
    for (const app of apps) {
      items.push({ text: approachName(app), onPick: () => this.ensureDest(() => this.edit().insertApproach(app, null)) });
    }
    const rws = [...apt.runways].sort((a, b) => runwaySortKey(a.id) - runwaySortKey(b.id));
    rws.forEach((r, i) => items.push({ header: i === 0 ? 'RUNWAYS' : undefined, text: 'RW' + r.id, onPick: () => this.ensureDest(() => this.edit().insertRunwayArrival(r)) }));
    return items;
  }

  rightItems(): Item[] {
    const ps = this.ps;
    if (!ps) return [];
    const p = this.plan();
    const exec = this.a.which === 'ACT' && !fms.mod;
    if (this.isDest() && p.star) {
      const star = ps.stars.find((x) => x.id === p.star!.id);
      if (star) {
        const items: Item[] = [{ text: star.id, sel: !exec, act: exec, onPick: () => this.edit().clearStar() }];
        if (p.star.trans) items.push({ header: 'TRANS', text: p.star.trans, sel: !exec, act: exec, onPick: () => this.edit().insertStar(star, null) });
        else Object.keys(star.en).sort().forEach((t, i) => items.push({ header: i === 0 ? 'TRANS' : undefined, text: t, onPick: () => this.edit().insertStar(star, t) }));
        return items;
      }
    }
    return ps.stars.map((star) => ({
      text: star.id,
      onPick: () => this.ensureDest(() => {
        const trans = Object.keys(star.en);
        this.edit().insertStar(star, trans.length === 1 ? trans[0] : null);
      }),
    }));
  }

  private ensureDest(f: () => void) {
    const e = this.edit();
    if (e.dest?.ident !== this.a.apt.ident) {
      if (!e.origin) { this.cdu.error('ENTER ORIGIN'); return; }
      e.setDest(this.a.apt);
    }
    f();
  }
}
registerPage('ARRIVAL', (c, a) => new ArrivalPage(c, a));

export { dashes };
