// CDU controller: key handling, scratchpad and page management.
import { Screen, Color } from './screen';
import { fms } from '../fms/fms';
import { navdb, Waypoint } from '../nav/navdb';
import type { LatLon } from '../util/geo';

export type Side = 'L' | 'R';

export abstract class Page {
  page = 1;
  pages = 1;
  /** Re-render periodically (pages showing live data). */
  live = false;
  constructor(public cdu: Cdu) {}
  abstract render(s: Screen): void;
  lsk(_side: Side, _n: number): void {
    this.cdu.error('INVALID ENTRY');
  }
  next(): void {
    if (this.pages > 1) this.page = this.page >= this.pages ? 1 : this.page + 1;
  }
  prev(): void {
    if (this.pages > 1) this.page = this.page <= 1 ? this.pages : this.page - 1;
  }
  /** Called before each render to recompute page count, etc. */
  update(): void {}
  /** Identifier used by function keys to toggle/return. */
  id = '';
}

type Factory = (cdu: Cdu, arg?: any) => Page;
const REGISTRY = new Map<string, Factory>();
export function registerPage(id: string, f: Factory) {
  REGISTRY.set(id, f);
}

export class Cdu {
  screen = new Screen();
  scratch = '';
  private msg: { text: string; color: Color } | null = null;
  page!: Page;
  private back: Page | null = null;
  brightness = 1;
  onRender: ((s: Screen) => void) | null = null;
  onBrightness: ((b: number) => void) | null = null;
  /** Message currently shown from the FMS message queue. */
  private fmsMsgShown: string | null = null;
  private clrDownAt = 0;

  show(id: string, arg?: any): Page {
    const f = REGISTRY.get(id);
    if (!f) throw new Error('Unknown page ' + id);
    const p = f(this, arg);
    p.id = id;
    this.setPage(p);
    return p;
  }

  setPage(p: Page) {
    if (this.page && this.page.id !== 'SELECT WPT' && this.page.id !== 'MESSAGES') this.back = this.page;
    this.page = p;
    this.render();
  }

  returnToPrevious() {
    if (this.back) {
      this.page = this.back;
      this.back = null;
      this.render();
    } else this.show('INDEX');
  }

  // -------------------------------------------------------------------------
  // Scratchpad

  /** Error / advisory text in the scratchpad (replaces the entry until CLR). */
  error(text: string, color: Color = 'a') {
    this.msg = { text, color };
    this.render();
  }

  get hasEntry(): boolean {
    return !this.msg && this.scratch.length > 0;
  }
  get isDelete(): boolean {
    return !this.msg && this.scratch === 'DELETE';
  }
  peek(): string {
    return this.msg ? '' : this.scratch;
  }
  /** Consume the scratchpad entry. */
  take(): string {
    const s = this.scratch;
    this.scratch = '';
    return s;
  }
  clearScratch() {
    this.scratch = '';
    this.msg = null;
  }
  setScratch(text: string) {
    this.msg = null;
    this.scratch = text.slice(0, 24);
    this.render();
  }

  // -------------------------------------------------------------------------
  // Keys

  keyDown(k: string) {
    if (k === 'CLR') this.clrDownAt = performance.now();
  }

  key(k: string) {
    if (k.length === 1 && /[A-Z0-9./ ]/.test(k)) {
      this.typeChar(k);
      return;
    }
    switch (k) {
      case 'SP': this.typeChar(' '); return;
      case '+/-': {
        if (this.msg) this.msg = null;
        const last = this.scratch.slice(-1);
        if (last === '-') this.scratch = this.scratch.slice(0, -1) + '+';
        else if (last === '+') this.scratch = this.scratch.slice(0, -1) + '-';
        else if (this.scratch.length < 24) this.scratch += '-';
        this.render();
        return;
      }
      case 'CLR': {
        const long = this.clrDownAt && performance.now() - this.clrDownAt > 700;
        this.clrDownAt = 0;
        if (this.msg) this.msg = null;
        else if (this.fmsMsgShown && !this.scratch) {
          fms.markMessagesRead();
          this.fmsMsgShown = null;
        } else if (long || this.scratch === 'DELETE') this.scratch = '';
        else this.scratch = this.scratch.slice(0, -1);
        this.render();
        return;
      }
      case 'CLRALL':
        this.scratch = '';
        this.msg = null;
        this.render();
        return;
      case 'DEL':
        if (this.msg) this.msg = null;
        if (!this.scratch) this.scratch = 'DELETE';
        else if (this.scratch === 'DELETE') this.scratch = '';
        else this.scratch = this.scratch.slice(0, -1);
        this.render();
        return;
      case 'EXEC':
        if (!fms.exec()) { this.render(); return; }
        this.render();
        return;
      case 'PREV':
        this.page.prev();
        this.render();
        return;
      case 'NEXT':
        this.page.next();
        this.render();
        return;
      case 'BRT':
        this.brightness = Math.min(1, this.brightness + 0.1);
        this.onBrightness?.(this.brightness);
        return;
      case 'DIM':
        this.brightness = Math.max(0.25, this.brightness - 0.1);
        this.onBrightness?.(this.brightness);
        return;
    }
    const lsk = /^([LR])([1-6])$/.exec(k);
    if (lsk) {
      // A displayed FMS message is acknowledged by any entry
      try {
        this.page.lsk(lsk[1] as Side, parseInt(lsk[2], 10));
      } catch (e) {
        console.error(e);
        this.error('INVALID ENTRY');
      }
      this.render();
      return;
    }
    const fkeys: Record<string, string> = {
      INDEX: 'INDEX', FPLN: 'FPLN', LEGS: 'LEGS', DEPARR: 'DEPARR', DIR: 'DIR', HOLD: 'HOLD', FIX: 'FIX',
      PROG: 'PROG', PERF: 'PERF', VNAV: 'VNAV', RADIO: 'RADIO', SECFPLN: 'SECFPLN', MFDMENU: 'MFD MENU',
      MFDADV: 'MFD ADV', MFDDATA: 'MFD DATA', MCDU: 'MCDU MENU', MSG: 'MESSAGES',
    };
    const id = fkeys[k];
    if (id) {
      if (id === 'MESSAGES' && this.page.id === 'MESSAGES') { this.returnToPrevious(); return; }
      if (id === 'MESSAGES') fms.markMessagesRead();
      this.show(id);
    }
  }

  private typeChar(c: string) {
    if (this.msg) this.msg = null;
    if (this.fmsMsgShown) { fms.markMessagesRead(); this.fmsMsgShown = null; }
    if (this.scratch === 'DELETE') this.scratch = '';
    if (this.scratch.length < 24) this.scratch += c;
    this.render();
  }

  // -------------------------------------------------------------------------
  // Waypoint entry with duplicate resolution

  resolveWaypoint(text: string, ref: LatLon | null, cb: (w: Waypoint) => void) {
    const t = text.trim().toUpperCase();
    const def = fms.parseDefinedWaypoint(t, ref ?? fms.ac.pos);
    if (def === 'INVALID') { this.error('INVALID ENTRY'); return; }
    if (def) { cb(def); return; }
    const list = navdb.findNear(t, ref ?? fms.ac.pos);
    if (!list.length) { this.error('NOT IN DATA BASE'); return; }
    if (list.length === 1) { cb(list[0]); return; }
    const caller = this.page;
    this.show('SELECT WPT', {
      list, ref: ref ?? fms.ac.pos,
      pick: (w: Waypoint) => {
        this.page = caller;
        cb(w);
        this.render();
      },
      cancel: () => { this.page = caller; this.render(); },
    });
  }

  // -------------------------------------------------------------------------
  render() {
    const s = this.screen;
    s.clear();
    try {
      this.page.update();
      this.page.render(s);
    } catch (e) {
      console.error(e);
    }
    // Scratchpad
    if (this.msg) s.scratch(this.msg.text, this.msg.color);
    else if (this.scratch) s.scratch(this.scratch, 'w');
    else {
      const m = fms.messages.find((x) => x.isNew);
      if (m) {
        this.fmsMsgShown = m.text;
        s.scratch(m.text, m.alert ? 'a' : 'w');
      } else this.fmsMsgShown = null;
    }
    this.onRender?.(s);
  }

  get execLit(): boolean {
    return fms.isMod;
  }
  get msgLit(): boolean {
    return fms.hasNewMessage;
  }
}

export const cdu = new Cdu();
