import '@fontsource/b612-mono/400.css';
import '@fontsource/b612-mono/700.css';
import './styles.css';
import { navdb } from './nav/navdb';
import { fms } from './fms/fms';
import { sim } from './sim/sim';
import * as control from './sim/control';
import { cdu } from './cdu/cdu';
import './cdu/pages/all';
import { loadDefaults } from './cdu/pages/index-pages';
import { CduView } from './ui/cduView';
import { MfdView } from './displays/mfd';
import { PfdView } from './displays/pfd';
import { FcpView } from './ui/fcp';
import { SimPanel } from './ui/simPanel';
import { distance } from './util/geo';
import { trueToMag } from './util/magvar';
import { fmtAlt, fmtDist } from './cdu/fmt';
import { legDisplayIdent } from './fms/flightplan';

const app = document.getElementById('app')!;
const bootEl = document.getElementById('boot')!;
const bootMsg = document.getElementById('boot-msg')!;
const bootBar = document.getElementById('boot-bar')!;

const ICONS = {
  cdu: '<svg viewBox="0 0 24 24"><rect x="5" y="2.5" width="14" height="19" rx="2"/><rect x="8" y="5" width="8" height="6" rx="1"/><path d="M8 14h2M11 14h2M14 14h2M8 17h2M11 17h2M14 17h2"/></svg>',
  mfd: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 17l-2-5 6-5"/><circle cx="16" cy="7" r="1"/></svg>',
  pfd: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 13l18-3"/><path d="M9 12.5h6"/></svg>',
  sim: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/></svg>',
};

function toastHost() {
  const wrap = document.createElement('div');
  wrap.className = 'toast-wrap';
  document.body.appendChild(wrap);
  return (text: string) => {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = text;
    wrap.appendChild(t);
    setTimeout(() => t.remove(), 3200);
    while (wrap.children.length > 3) wrap.firstElementChild?.remove();
  };
}

function helpHtml(): string {
  return `
    <h2>Programming the CRJ700 FMS</h2>
    <ol>
      <li><b>STATUS</b> appears at power-up. Check the active database, then press <code>POS INIT&gt;</code>.</li>
      <li><b>POS INIT</b>: press the LSK next to <code>GPS1 POS</code> to set the FMS position.</li>
      <li><b>FPLN</b>: type the origin (e.g. <code>KDEN</code>) and press 1L; destination at 1R; runway (<code>34L</code>) at 3L. On the dashed line enter an airway in VIA (<code>J240</code>) and the exit fix in TO, or just a TO waypoint for a direct.</li>
      <li><b>DEP ARR</b>: select the runway, SID and transition. After takeoff the same key shows the arrival: STAR, transition and approach.</li>
      <li>Press <b>EXEC</b> (lit bar) to activate. <code>CANCEL MOD</code> at 6L discards changes.</li>
      <li><b>PERF</b>: PERF INIT page 2 cruise altitude, page 3 passengers/cargo, then <code>CONFIRM INIT&gt;</code> and EXEC. INDEX → TAKEOFF for V-speeds, then <code>SET SPEEDS</code>.</li>
      <li>Open the <b>SIM</b> panel: <code>Line up</code>, then <code>Takeoff / TOGA</code>. NAV and VNAV arm automatically; the autopilot engages after takeoff.</li>
    </ol>
    <p class="note">LEGS: type a waypoint and press a left LSK to insert it, DEL then LSK to delete, and enter <code>250/10000A</code> on the right for constraints. DIR INTC for direct-to and intercepts, HOLD for holds (EXIT HOLD to leave), FIX for radial/distance crossings. Defined waypoints: <code>DEN/090/20</code>, <code>DEN/090/BJC/180</code>, <code>N3950.0W10500.0</code>.</p>
    <p class="note"><b>Keyboard:</b> letters/numbers type into the scratchpad, Backspace = CLR, Delete = DEL, Enter = EXEC, F1–F6 = left LSKs, Shift+F1–F6 = right LSKs, PgUp/PgDn = PREV/NEXT PAGE.</p>
    <p class="note">Data: FAA NASR/CIFP cycle ${navdb.meta?.cycle.ident ?? ''} and OurAirports. Training use only.</p>
    <div class="row" style="justify-content:flex-end"><button class="tbtn" data-close>Close</button></div>`;
}

async function boot() {
  const steps = ['SELF TEST IN PROGRESS', 'LOADING NAV DATA BASE', 'CHECKING DATA BASE', 'FMS1 READY'];
  bootMsg.textContent = steps[0];
  try {
    await navdb.load((f, frac) => {
      bootBar.style.width = `${Math.round(frac * 90)}%`;
      bootMsg.textContent = `${steps[1]}  ${f.replace('.json', '').toUpperCase()}`;
    });
  } catch (e) {
    bootMsg.textContent = 'NAV DATA BASE LOAD FAILED - RELOAD';
    console.error(e);
    return;
  }
  bootBar.style.width = '100%';
  bootMsg.textContent = steps[3];
  build();
  setTimeout(() => bootEl.classList.add('done'), 250);
  setTimeout(() => bootEl.remove(), 900);
}

function build() {
  const toast = toastHost();
  control.onToast(toast);
  loadDefaults();

  // ---------------- Header
  const top = document.createElement('header');
  top.className = 'topbar';
  top.innerHTML = `
    <div class="brand">CRJ700 FMS<small>Collins FMS-4200</small></div>
    <div class="flightstrip" data-strip></div>
    <div class="tb-btns">
      <button class="tbtn" data-act="sim">SIM</button>
      <button class="tbtn primary" data-act="toga">TAKEOFF</button>
      <button class="tbtn" data-act="help">HELP</button>
    </div>`;
  app.appendChild(top);
  const strip = top.querySelector('[data-strip]') as HTMLElement;

  // ---------------- Main
  const main = document.createElement('div');
  main.className = 'main';
  main.innerHTML = `
    <div class="left-col">
      <section class="panel fcp-host" data-fcp-desktop></section>
      <div class="screens">
        <section class="panel view view-pfd"><div class="display-frame" data-pfd></div><div data-fcp-phone></div></section>
        <section class="panel view view-mfd"><div class="display-frame" data-mfd></div>
          <div class="disp-ctl">
            <button class="dbtn" data-act="rng-">RANGE −</button>
            <button class="dbtn" data-act="mode">MAP</button>
            <button class="dbtn" data-act="rng+">RANGE +</button>
            <button class="dbtn" data-act="data">DATA</button>
          </div>
        </section>
      </div>
    </div>
    <div class="cdu-col view view-cdu active" data-cdu></div>`;
  app.appendChild(main);

  const cduView = new CduView(main.querySelector('[data-cdu]') as HTMLElement);
  const pfd = new PfdView(main.querySelector('[data-pfd]') as HTMLElement);
  const mfd = new MfdView(main.querySelector('[data-mfd]') as HTMLElement);
  const fcpDesk = main.querySelector('[data-fcp-desktop]') as HTMLElement;
  const fcpPhone = main.querySelector('[data-fcp-phone]') as HTMLElement;
  const fcp = new FcpView(fcpDesk, toast);

  // ---------------- Help modal + SIM panel
  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.innerHTML = '<div class="modal-box"></div>';
  document.body.appendChild(modal);
  const box = modal.querySelector('.modal-box') as HTMLElement;
  const openHelp = () => { box.innerHTML = helpHtml(); modal.classList.add('open'); };
  const simPanel = new SimPanel(toast, openHelp);
  const openSim = () => {
    box.innerHTML = '';
    box.appendChild(simPanel.root);
    box.insertAdjacentHTML('beforeend', '<div class="row" style="justify-content:flex-end;padding:0 10px 6px"><button class="tbtn" data-close>Close</button></div>');
    modal.classList.add('open');
  };
  modal.addEventListener('click', (e) => {
    if (e.target === modal || (e.target as HTMLElement).closest('[data-close]')) {
      modal.classList.remove('open');
      if (isPhone()) main.appendChild(simPanel.root);
    }
  });

  // ---------------- Tabs (phone)
  const tabs = document.createElement('nav');
  tabs.className = 'tabs';
  tabs.innerHTML = (['cdu', 'mfd', 'pfd', 'sim'] as const).map((t) => `<button data-tab="${t}" class="${t === 'cdu' ? 'active' : ''}">${ICONS[t]}${t.toUpperCase()}</button>`).join('');
  app.appendChild(tabs);
  const showTab = (t: string) => {
    tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
    main.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.classList.contains(`view-${t}`)));
  };
  tabs.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('[data-tab]') as HTMLElement | null;
    if (b) showTab(b.dataset.tab!);
  });

  const isPhone = () => window.matchMedia('(max-width: 760px)').matches;
  const layout = () => {
    if (isPhone()) {
      if (fcp.root.parentElement !== fcpPhone) fcpPhone.appendChild(fcp.root);
      if (simPanel.root.parentElement !== main && !modal.classList.contains('open')) main.appendChild(simPanel.root);
      fcpDesk.style.display = 'none';
    } else {
      if (fcp.root.parentElement !== fcpDesk) fcpDesk.appendChild(fcp.root);
      fcpDesk.style.display = '';
      if (simPanel.root.parentElement === main) simPanel.root.remove();
      main.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
      main.querySelector('.view-cdu')?.classList.add('active');
    }
  };
  window.matchMedia('(max-width: 760px)').addEventListener('change', layout);
  layout();

  // ---------------- Buttons
  top.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
    if (!b) return;
    if (b.dataset.act === 'sim') openSim();
    else if (b.dataset.act === 'help') openHelp();
    else if (b.dataset.act === 'toga') { const er = control.toga(); if (er) toast(er); }
  });
  main.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('.disp-ctl [data-act]') as HTMLElement | null;
    if (!b) return;
    const a = b.dataset.act;
    if (a === 'rng-') mfd.rangeDown();
    else if (a === 'rng+') mfd.rangeUp();
    else if (a === 'mode') { mfd.cycleMode(); b.textContent = mfd.mode; }
    else if (a === 'data') {
      const order = ['NONE', 'FPL PROG', 'NAV STATUS'] as const;
      fms.mfd.dataPage = order[(order.indexOf(fms.mfd.dataPage as any) + 1) % order.length];
    }
  });
  window.addEventListener('keydown', (e) => {
    if (modal.classList.contains('open')) return;
    if (cduView.handleKeyboard(e)) return;
  });

  // ---------------- Events
  sim.onEvent = (e) => {
    if (['LOC CAPTURE', 'GS CAPTURE', 'TOUCHDOWN', 'HARD LANDING', 'GO AROUND', 'LNAV DISCONNECT', 'LIFTOFF', 'STOPPED'].includes(e)) toast(e);
  };

  // ---------------- Initial state: cold FMS at the gate in Denver
  const home = navdb.getAirport('KDEN') ?? [...navdb.airports.values()][0];
  sim.placeAtGate(home);
  sim.ac.s.fuel = 9500;
  sim.ac.fcp.altSel = 10000;
  fms.lastPos = { lat: sim.ac.s.lat, lon: sim.ac.s.lon };
  sim.step(0.05);
  cdu.show('STATUS');

  // ---------------- Loop
  let last = performance.now();
  let cduTimer = 0, uiTimer = 0, dispTimer = 0;
  let lastOrigin = '';
  let lastVersion = -1;
  fms.onChange = () => { cduDirty = true; };
  let cduDirty = false;
  const frame = (now: number) => {
    const dt = Math.min(0.25, (now - last) / 1000);
    last = now;
    sim.tick(dt);
    control.atcUpdate();
    // Reposition to a newly executed origin while on the ground (sim convenience)
    const o = fms.active.origin?.ident ?? '';
    if (o && o !== lastOrigin && sim.ac.s.onGround && sim.ac.s.ias < 1) {
      const apt = fms.active.origin!;
      if (distance({ lat: sim.ac.s.lat, lon: sim.ac.s.lon }, apt) > 5) {
        sim.placeAtGate(apt);
        fms.lastPos = { lat: sim.ac.s.lat, lon: sim.ac.s.lon };
        if (fms.posInit) fms.setPosition({ lat: sim.ac.s.lat, lon: sim.ac.s.lon });
        toast(`AIRCRAFT MOVED TO ${apt.ident}`);
      }
    }
    lastOrigin = o;
    if (sim.ac.s.onGround) control.syncWeights();

    cduTimer += dt;
    if (cduDirty || (cdu.page.live && cduTimer > 0.3) || fms.active.version !== lastVersion) {
      cdu.render();
      cduTimer = 0;
      cduDirty = false;
      lastVersion = fms.active.version;
    }
    dispTimer += dt;
    const phone = isPhone();
    const interval = phone ? 1 / 30 : 1 / 45;
    if (dispTimer >= interval) {
      dispTimer = 0;
      if (!phone || main.querySelector('.view-pfd.active')) pfd.draw();
      if (!phone || main.querySelector('.view-mfd.active')) mfd.draw();
    }
    uiTimer += dt;
    if (uiTimer > 0.2) {
      uiTimer = 0;
      fcp.refresh();
      simPanel.refresh();
      updateStrip(strip);
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

function updateStrip(el: HTMLElement) {
  const s = sim.ac.s, f = sim.ac.fcp;
  const ta = fms.perf.transAlt;
  const hdg = Math.round(trueToMag(s.hdg, s.lat, s.lon)) % 360 || 360;
  const leg = fms.active.legs[fms.active.activeIdx];
  const ln = fms.guidance.lnav;
  const lat = { LNAV: 'LNV1', LOC: 'LOC1' } as Record<string, string>;
  const parts = [
    `<span class="fs"><span>ALT</span><b>${fmtAlt(s.alt, ta)}</b></span>`,
    `<span class="fs"><span>IAS</span><b>${Math.round(s.ias)}</b>${s.mach > 0.4 ? `<b>M.${Math.round(s.mach * 100)}</b>` : ''}</span>`,
    `<span class="fs fs-hdg"><span>HDG</span><b>${String(hdg).padStart(3, '0')}</b></span>`,
    `<span class="fs"><b>${lat[f.lat] ?? f.lat}</b><b>${f.vert === 'VFLC' ? 'VFLCH' : f.vert}</b></span>`,
  ];
  if (leg && ln.valid && leg.pt !== 'DISCO') parts.push(`<span class="fs fs-wpt"><b class="m">${legDisplayIdent(leg)}</b><b>${fmtDist(ln.dtg)}</b></span>`);
  if (sim.rate > 1) parts.push(`<span class="fs"><b>${sim.rate}×</b></span>`);
  if (sim.paused) parts.push('<span class="fs"><b class="m">PAUSED</b></span>');
  const html = parts.join(' ');
  if (el.innerHTML !== html) el.innerHTML = html;
}

void boot();
