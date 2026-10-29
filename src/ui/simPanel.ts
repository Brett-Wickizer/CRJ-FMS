// Simulation control panel (web UI). Mirrors the MCDU SIM pages.
import { sim } from '../sim/sim';
import { fms } from '../fms/fms';
import { navdb } from '../nav/navdb';
import * as control from '../sim/control';
import { cdu } from '../cdu/cdu';
import { fmtZulu, parseWind } from '../cdu/fmt';

const RATES = [1, 2, 4, 8, 16, 32, 64];

export class SimPanel {
  root: HTMLElement;
  private evEl!: HTMLElement;
  private rateBtns: HTMLButtonElement[] = [];

  constructor(private toast: (t: string) => void, private openHelp: () => void) {
    this.root = document.createElement('section');
    this.root.className = 'panel view view-sim';
    this.root.innerHTML = `
      <div class="sheet">
        <h3>Simulation</h3>
        <div class="row" data-rates>${RATES.map((r) => `<button class="tbtn" data-rate="${r}">${r}×</button>`).join('')}<button class="tbtn" data-act="pause">Pause</button></div>
        <div class="row">
          <button class="tbtn" data-act="gate">At gate</button>
          <button class="tbtn" data-act="lineup">Line up</button>
          <button class="tbtn primary" data-act="toga">Takeoff / TOGA</button>
          <button class="tbtn warn" data-act="reset">Reset flight</button>
        </div>
        <h3>Quick setup</h3>
        <div class="row"><input class="field wide" data-f="route" placeholder="KDEN BAYLR6.HBU J240 MTU JAZZZ1 KSLC" autocomplete="off" autocapitalize="characters" spellcheck="false"></div>
        <div class="row">
          <button class="tbtn" data-act="load">Load route (MOD)</button>
          <button class="tbtn primary" data-act="demo">Demo flight KDEN → KSLC</button>
          <button class="tbtn" data-act="help">How to program</button>
        </div>
        <p class="note">Load route puts the route in a MOD flight plan; review it on the FPLN/LEGS pages and press EXEC. The demo programs a full preflight (route, SID, STAR, ILS, PERF INIT, takeoff speeds) and lines up on KDEN runway 34L.</p>
        <h3>Aircraft</h3>
        <div class="row">
          <label>Fuel lb</label><input class="field" data-f="fuel" inputmode="numeric" style="width:96px">
          <button class="tbtn" data-act="setfuel">Set</button>
          <button class="tbtn" data-act="crew">Auto crew</button>
          <button class="tbtn" data-act="atc">ATC altitudes</button>
        </div>
        <p class="note">Auto crew flies configuration (flaps, gear, speed brakes, thrust) and arms the approach. ATC altitudes sets climb and descent clearances in ALT SEL. Turn them off to fly the panel yourself.</p>
        <h3>Weather</h3>
        <div class="row">
          <label>Sfc wind</label><input class="field" data-f="sfc" placeholder="340/12" style="width:92px">
          <label>Aloft</label><input class="field" data-f="aloft" placeholder="270/60" style="width:92px">
          <label>ISA</label><input class="field" data-f="isa" placeholder="+0" style="width:60px">
          <button class="tbtn" data-act="wx">Apply</button>
        </div>
        <h3>Events</h3>
        <div class="events" data-f="events"></div>
        <p class="note">Navigation data: FAA NASR and CIFP cycle ${navdb.meta?.cycle.ident ?? ''} (US airports, navaids, fixes, airways, SIDs, STARs and approaches) and OurAirports (worldwide airports and navaids). For training only; not for real-world navigation.</p>
      </div>`;
    this.evEl = this.root.querySelector('[data-f="events"]') as HTMLElement;
    this.rateBtns = [...this.root.querySelectorAll<HTMLButtonElement>('[data-rate]')];
    this.root.addEventListener('click', (e) => this.onClick(e));
    const fuel = this.root.querySelector('[data-f="fuel"]') as HTMLInputElement;
    fuel.value = String(Math.round(sim.ac.s.fuel));
    this.refresh();
  }

  private val(f: string): string {
    return ((this.root.querySelector(`[data-f="${f}"]`) as HTMLInputElement)?.value ?? '').trim().toUpperCase();
  }

  private async onClick(e: Event) {
    const b = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null;
    if (!b) return;
    if (b.dataset.rate) { sim.rate = +b.dataset.rate; this.refresh(); return; }
    const err = (x: string | null) => { if (x) this.toast(x); };
    switch (b.dataset.act) {
      case 'pause': sim.paused = !sim.paused; break;
      case 'gate': err(control.atGate()); break;
      case 'lineup': err(control.lineUp()); break;
      case 'toga': err(control.toga()); break;
      case 'reset': control.resetFlight(); cdu.show('STATUS'); this.toast('FLIGHT RESET'); break;
      case 'load': {
        const r = this.val('route');
        if (!r) { this.toast('ENTER A ROUTE'); return; }
        const plan = fms.editPlan();
        const er = await fms.loadRouteString(plan, r);
        if (er) { this.toast(er); return; }
        if (plan.origin && sim.ac.s.onGround) sim.placeAtGate(plan.origin);
        cdu.show('FPLN');
        this.toast('ROUTE LOADED - REVIEW AND EXEC');
        break;
      }
      case 'demo': await this.demo(); break;
      case 'help': this.openHelp(); break;
      case 'setfuel': {
        const v = parseInt(this.val('fuel'), 10);
        if (!(v >= 0 && v <= 19594)) { this.toast('FUEL 0-19594 LB'); return; }
        control.setFuel(v);
        this.toast(`FUEL ${v} LB`);
        break;
      }
      case 'crew': sim.ac.fcp.autoCrew = !sim.ac.fcp.autoCrew; break;
      case 'atc': control.settings.atcAlt = !control.settings.atcAlt; break;
      case 'wx': {
        const sfc = this.val('sfc'), al = this.val('aloft'), isa = this.val('isa');
        if (sfc) { const w = parseWind(sfc); if (!w) { this.toast('WIND FORMAT 340/12'); return; } sim.env.sfcWind = w; }
        if (al) { const w = parseWind(al); if (!w) { this.toast('WIND FORMAT 270/60'); return; } sim.env.aloftWind = w; }
        if (isa) { const v = parseInt(isa, 10); if (Number.isNaN(v) || Math.abs(v) > 40) { this.toast('ISA DEV -40..+40'); return; } sim.env.isaDev = v; }
        this.toast('WEATHER SET');
        break;
      }
    }
    this.refresh();
  }

  /** Program a complete preflight like a crew would. */
  async demo() {
    control.resetFlight();
    const plan = fms.editPlan();
    const er = await fms.loadRouteString(plan, 'KDEN BAYLR6.HBU J240 MTU JAZZZ1.MTU KSLC');
    if (er) { this.toast(er); return; }
    const den = plan.origin!;
    await navdb.ensureProcedures(den.ident);
    plan.setOrigRwy(den.runways.find((r) => r.id === '34L') ?? null);
    const ps = await navdb.ensureProcedures('KSLC');
    const app = ps?.apps.find((a) => a.id === 'I34R');
    if (app) plan.insertApproach(app, 'JAZZZ');
    plan.fltNo = 'SKW3412';
    const p = fms.editPerf();
    p.crzAlt = 35000; p.pax = 66; p.cargo = 1200;
    p.winds.crz = { dir: 270, spd: 45 };
    fms.exec();
    sim.env.aloftWind = { dir: 270, spd: 45 };
    control.setFuel(9500);
    sim.placeAtGate(den);
    control.lineUp();
    fms.setPosition({ lat: sim.ac.s.lat, lon: sim.ac.s.lon });
    fms.computeTakeoff(fms.perf);
    fms.perf.takeoff.confirmed = true;
    sim.ac.fcp.altSel = 15000;
    control.syncWeights();
    cdu.show('LEGS');
    this.toast('DEMO READY - PRESS TAKEOFF');
  }

  refresh() {
    this.rateBtns.forEach((b) => b.classList.toggle('on', +b.dataset.rate! === sim.rate));
    const t = (act: string, on: boolean, label?: string) => {
      const b = this.root.querySelector(`[data-act="${act}"]`) as HTMLElement | null;
      if (b) { b.classList.toggle('on', on); if (label) b.textContent = label; }
    };
    t('pause', sim.paused, sim.paused ? 'Resume' : 'Pause');
    t('crew', sim.ac.fcp.autoCrew, `Auto crew ${sim.ac.fcp.autoCrew ? 'ON' : 'OFF'}`);
    t('atc', control.settings.atcAlt, `ATC altitudes ${control.settings.atcAlt ? 'ON' : 'OFF'}`);
    const html = sim.events.slice(0, 20).map((e) => `<div><span>${fmtZulu(e.time)}Z</span>${e.text}</div>`).join('');
    if (this.evEl.innerHTML !== html) this.evEl.innerHTML = html;
  }
}
