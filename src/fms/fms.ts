// Flight Management System core: plans, performance, guidance, predictions, messages.
import { LatLon, distance, bearing, destination, parseLatLon, norm360, intersection } from '../util/geo';
import { trueToMag, magToTrue } from '../util/magvar';
import { navdb, Waypoint, Airport } from '../nav/navdb';
import { FlightPlan, sameFix, aptWpt } from './flightplan';
import { computeGeometry } from './geometry';
import { computePredictions, Predictions, PerfParams, Wind } from './predict';
import { Guidance, AcState } from './guidance';
import { CRJ700, takeoffSpeeds, vref, landingDistance, takeoffFieldLength, takeoffN1, optimumAlt, maxAlt } from './perf';
import type { HoldSpec } from './types';

export interface TakeoffData {
  rwyId: string;
  wind: Wind | null;
  oat: number | null;
  qnh: number | null; // inHg
  flaps: 8 | 20;
  cond: 'DRY' | 'WET';
  antiIce: 'OFF' | 'ENG' | 'ALL';
  v1: number | null;
  vr: number | null;
  v2: number | null;
  vt: number | null;
  pilotSpeeds: boolean;
  confirmed: boolean;
}

export interface ApproachData {
  flaps: 45 | 30;
  wind: Wind | null;
  gust: number;
  oat: number | null;
  qnh: number | null;
  vref: number | null;
  vapp: number | null;
  vga: number | null;
  pilotVref: boolean;
  pilotVapp: boolean;
  cond: 'DRY' | 'WET';
}

export interface PerfInit {
  acftType: string;
  tailNo: string;
  clbIas: number;
  clbMach: number;
  clbLimIas: number;
  clbLimAlt: number;
  crzMode: 'MACH' | 'LRC' | 'MAX';
  crzMach: number;
  desMach: number;
  desIas: number;
  desLimIas: number;
  desLimAlt: number;
  vpa: number;
  transAlt: number;
  transLvl: number;
  crzAlt: number | null;
  isaDev: number;
  winds: { clb: Wind; crz: Wind; des: Wind };
  bow: number;
  pax: number;
  paxWt: number;
  cargo: number;
  reserve: number;
  taxiFuel: number;
  fuelOverride: number | null;
  confirmed: boolean;
  takeoff: TakeoffData;
  approach: ApproachData;
}

export function defaultPerf(): PerfInit {
  return {
    acftType: CRJ700.type,
    tailNo: 'N702SK',
    clbIas: 290, clbMach: 0.74, clbLimIas: 250, clbLimAlt: 10000,
    crzMode: 'MACH', crzMach: 0.77,
    desMach: 0.77, desIas: 290, desLimIas: 250, desLimAlt: 10000, vpa: 3.0,
    transAlt: 18000, transLvl: 18000,
    crzAlt: null, isaDev: 0,
    winds: { clb: { dir: 0, spd: 0 }, crz: { dir: 0, spd: 0 }, des: { dir: 0, spd: 0 } },
    bow: CRJ700.bow, pax: 0, paxWt: 190, cargo: 0,
    reserve: 2200, taxiFuel: 300, fuelOverride: null,
    confirmed: false,
    takeoff: { rwyId: '', wind: null, oat: null, qnh: null, flaps: 8, cond: 'DRY', antiIce: 'OFF', v1: null, vr: null, v2: null, vt: null, pilotSpeeds: false, confirmed: false },
    approach: { flaps: 45, wind: null, gust: 0, oat: null, qnh: null, vref: null, vapp: null, vga: null, pilotVref: false, pilotVapp: false, cond: 'DRY' },
  };
}

export interface FmsMessage {
  text: string;
  alert: boolean;
  time: number;
  isNew: boolean;
}

export type FlightPhase = 'PREFLIGHT' | 'TAKEOFF' | 'CLIMB' | 'CRUISE' | 'DESCENT' | 'APPROACH' | 'MISSED' | 'LANDED';

export interface RadioState {
  com1: number; com1sby: number; com2: number; com2sby: number;
  nav1: number; nav1sby: number; nav2: number; nav2sby: number;
  nav1Auto: boolean; nav2Auto: boolean;
  adf1: number; adf2: number;
  atc: string; atcMode: 'STBY' | 'ON' | 'ALT' | 'TA' | 'TA/RA';
  tcasRange: number;
  dmeHold1: boolean;
}

export interface MfdSettings {
  apts: boolean; hiNav: boolean; loNav: boolean; inters: boolean; termWpts: boolean; ndbs: boolean;
  missedAppr: boolean; altnFpln: boolean; secFpln: boolean; progress: boolean; rangeRings: boolean;
  dataPage: 'NONE' | 'FPL PROG' | 'NAV STATUS' | 'FPL DATA';
  planCenter: number; // leg index for PLAN mode center
  side: 'L' | 'R';
}

export interface FlightLog {
  outTime: number | null; offTime: number | null; onTime: number | null; inTime: number | null;
  fuelAtOut: number | null; fuelAtOff: number | null; fuelAtOn: number | null;
  dist: number;
}

const ROUTES_KEY = 'crjfms.routes.v1';

export class FMS {
  active = new FlightPlan();
  mod: FlightPlan | null = null;
  sec = new FlightPlan();
  perf: PerfInit = defaultPerf();
  modPerf: PerfInit | null = null;
  guidance = new Guidance();
  pred: Predictions | null = null;
  secPred: Predictions | null = null;
  private predTimer = 0;
  private predVersion = -1;
  messages: FmsMessage[] = [];
  phase: FlightPhase = 'PREFLIGHT';
  posInit = false;
  fmsPos: LatLon = { lat: 0, lon: 0 };
  gpsPos: LatLon = { lat: 0, lon: 0 };
  lastPos: LatLon | null = null;
  posRefWpt: Waypoint | null = null;
  ac: AcState = { pos: { lat: 0, lon: 0 }, alt: 0, ias: 0, tas: 0, gs: 0, trk: 0, hdg: 0, vs: 0, onGround: true, mach: 0 };
  fuelQty = 0;
  satC = 15;
  windNow: Wind = { dir: 0, spd: 0 };
  altSel = 0;
  radios: RadioState = {
    com1: 118.7, com1sby: 121.9, com2: 121.5, com2sby: 122.8,
    nav1: 113.9, nav1sby: 110.3, nav2: 116.0, nav2sby: 108.5, nav1Auto: true, nav2Auto: true,
    adf1: 350, adf2: 415, atc: '2000', atcMode: 'TA/RA', tcasRange: 12, dmeHold1: false,
  };
  mfd: MfdSettings = {
    apts: true, hiNav: false, loNav: false, inters: false, termWpts: false, ndbs: false,
    missedAppr: true, altnFpln: false, secFpln: false, progress: true, rangeRings: true,
    dataPage: 'NONE', planCenter: 0, side: 'L',
  };
  log: FlightLog = { outTime: null, offTime: null, onTime: null, inTime: null, fuelAtOut: null, fuelAtOff: null, fuelAtOn: null, dist: 0 };
  utcSec = 0;
  /** Listeners notified when something visible changes. */
  onChange: (() => void) | null = null;
  onLegSequence: ((ident: string) => void) | null = null;
  private seenMessages = new Set<string>();
  approachArmedRwy: string | null = null;
  tocReached = false;

  constructor() {
    this.guidance.onSequence = (idx) => {
      if (this.mod) {
        const uid = this.active.legs[idx]?.uid;
        const mi = this.mod.legs.findIndex((l) => l.uid === uid);
        if (mi >= 0) this.mod.activeIdx = mi;
      }
      this.predTimer = 99;
      this.onLegSequence?.(this.active.legs[idx]?.fix?.ident ?? '');
    };
  }

  // -------------------------------------------------------------------------
  // MOD / EXEC

  /** Plan being edited (creates MOD on first edit). */
  editPlan(): FlightPlan {
    if (!this.mod) this.mod = this.active.clone();
    return this.mod;
  }
  /** Plan shown on pages. */
  get plan(): FlightPlan {
    return this.mod ?? this.active;
  }
  get isMod(): boolean {
    return !!this.mod || !!this.modPerf;
  }
  editPerf(): PerfInit {
    if (!this.modPerf) this.modPerf = structuredClone(this.perf);
    return this.modPerf;
  }
  get perfView(): PerfInit {
    return this.modPerf ?? this.perf;
  }

  exec(): boolean {
    if (!this.mod && !this.modPerf) return false;
    if (this.mod) {
      const activeUid = this.active.legs[this.active.activeIdx]?.uid;
      this.active = this.mod;
      this.mod = null;
      const newActive = this.active.legs[this.active.activeIdx];
      if (!newActive || newActive.uid !== activeUid) this.guidance.reset();
    }
    if (this.modPerf) {
      this.perf = this.modPerf;
      this.modPerf = null;
      this.perf.confirmed = true;
    }
    this.predTimer = 99;
    this.changed();
    return true;
  }

  cancelMod() {
    this.mod = null;
    this.modPerf = null;
    this.changed();
  }

  changed() {
    this.onChange?.();
  }

  // -------------------------------------------------------------------------
  // Weights

  zfw(p: PerfInit = this.perfView): number {
    return p.bow + p.pax * p.paxWt + p.cargo;
  }
  fuel(p: PerfInit = this.perfView): number {
    return p.fuelOverride ?? this.fuelQty;
  }
  gw(p: PerfInit = this.perfView): number {
    return this.zfw(p) + this.fuel(p);
  }

  perfParams(p: PerfInit = this.perf): PerfParams {
    const ap = p.approach;
    const gwLdg = this.estLandingWeight(p);
    const vr = ap.vref ?? vref(gwLdg, ap.flaps);
    const vapp = ap.vapp ?? vr + 5;
    return {
      crzAlt: p.crzAlt ?? 0,
      isaDev: p.isaDev,
      clbIas: p.clbIas, clbMach: p.clbMach, clbLimIas: p.clbLimIas, clbLimAlt: p.clbLimAlt,
      crzMach: p.crzMode === 'LRC' ? Math.min(p.crzMach, 0.74) : p.crzMode === 'MAX' ? 0.82 : p.crzMach,
      desMach: p.desMach, desIas: p.desIas, desLimIas: p.desLimIas, desLimAlt: p.desLimAlt, vpa: p.vpa,
      winds: p.winds,
      gw: this.gw(p),
      fuel: this.fuel(p),
      vapp,
    };
  }

  estLandingWeight(p: PerfInit = this.perf): number {
    const burn = this.pred?.valid ? this.pred.totalFuelBurn : 0;
    return Math.round(this.gw(p) - burn);
  }

  // -------------------------------------------------------------------------
  // Takeoff / approach speed computation

  computeTakeoff(p: PerfInit) {
    const t = p.takeoff;
    if (t.pilotSpeeds) return;
    const apt = this.active.origin ?? this.plan.origin;
    const rw = this.plan.origRwy ?? apt?.runways.find((r) => r.id === t.rwyId) ?? null;
    const elev = rw?.elev ?? apt?.elev ?? 0;
    const oat = t.oat ?? 15 - (elev / 1000) * 2;
    const tow = this.gw(p) - p.taxiFuel;
    const s = takeoffSpeeds(tow, t.flaps, elev, oat, rw?.length ?? 10000);
    t.v1 = s.v1; t.vr = s.vr; t.v2 = s.v2; t.vt = s.vt;
  }

  takeoffInfo(p: PerfInit = this.perfView) {
    const t = p.takeoff;
    const apt = this.plan.origin;
    const rw = this.plan.origRwy;
    const elev = rw?.elev ?? apt?.elev ?? 0;
    const oat = t.oat ?? Math.round(15 - (elev / 1000) * 2);
    const tow = this.gw(p) - p.taxiFuel;
    return {
      tow,
      tofl: takeoffFieldLength(tow, t.flaps, elev, oat),
      rwyLen: rw ? rw.length - rw.dispThr * 0 : null,
      n1: takeoffN1(elev, oat),
      elev,
      oat,
      overweight: tow > CRJ700.mtow,
    };
  }

  approachSpeeds(p: PerfInit = this.perfView) {
    const ap = p.approach;
    const lw = this.estLandingWeight(p);
    const vr = ap.pilotVref && ap.vref ? ap.vref : vref(lw, ap.flaps);
    let headwind = 0;
    const rw = this.plan.destRwy;
    if (ap.wind && rw) headwind = ap.wind.spd * Math.cos(((ap.wind.dir - trueToMag(rw.brg, rw.lat, rw.lon)) * Math.PI) / 180);
    const add = Math.round(Math.min(20, Math.max(5, Math.max(0, headwind) / 2 + ap.gust)));
    const vapp = ap.pilotVapp && ap.vapp ? ap.vapp : vr + add;
    const vga = vr + 15; // flaps 8 go-around reference
    const elev = rw?.elev ?? this.plan.dest?.elev ?? 0;
    return { lw, vref: vr, vapp, vga, ld: landingDistance(lw, elev, ap.cond === 'WET'), rwyLen: rw?.length ?? null, overweight: lw > CRJ700.mlw };
  }

  optAlt(): number {
    return optimumAlt(this.gw(this.perf));
  }
  maxAlt(): number {
    return maxAlt(this.gw(this.perf), this.perf.isaDev);
  }

  // -------------------------------------------------------------------------
  // Position init

  setPosition(p: LatLon) {
    this.fmsPos = { ...p };
    this.posInit = true;
    this.clearMessage('INITIALIZE POSITION');
    this.changed();
  }

  // -------------------------------------------------------------------------
  // Messages

  addMessage(text: string, alert = false) {
    if (this.messages.some((m) => m.text === text)) return;
    this.messages.unshift({ text, alert, time: this.utcSec, isNew: true });
    this.changed();
  }
  clearMessage(text: string) {
    const n = this.messages.length;
    this.messages = this.messages.filter((m) => m.text !== text);
    if (n !== this.messages.length) this.changed();
  }
  get hasNewMessage(): boolean {
    return this.messages.some((m) => m.isNew);
  }
  markMessagesRead() {
    for (const m of this.messages) m.isNew = false;
  }
  /** Raise a one-shot message (once per key). */
  private once(key: string, text: string, alert = false) {
    if (this.seenMessages.has(key)) return;
    this.seenMessages.add(key);
    this.addMessage(text, alert);
  }

  // -------------------------------------------------------------------------
  // Main update

  update(dt: number, ac: AcState, fuelQty: number, satC: number, wind: Wind, altSel: number, utcSec: number) {
    this.ac = ac;
    this.fuelQty = fuelQty;
    this.satC = satC;
    this.windNow = wind;
    this.altSel = altSel;
    this.utcSec = utcSec;
    this.gpsPos = ac.pos;
    if (this.posInit) this.fmsPos = ac.pos;
    else if (!this.messages.some((m) => m.text === 'INITIALIZE POSITION') && !this.seenMessages.has('posinit')) {
      this.seenMessages.add('posinit');
      this.addMessage('INITIALIZE POSITION', true);
    }
    const airborne = !ac.onGround;
    const originElev = this.active.origin?.elev ?? 0;
    const ctx = {
      acPos: ac.pos, acTrack: ac.trk, acAlt: ac.alt, airborne, climbGrad: 600, holdTas: Math.max(180, Math.min(ac.tas || 200, 260)), originElev,
    };
    computeGeometry(this.active, ctx);
    if (this.mod) computeGeometry(this.mod, ctx);
    if (this.mfd.secFpln || true) computeGeometry(this.sec, { ...ctx, airborne: false });

    if (this.posInit) this.guidance.updateLnav(this.active, ac);
    if (airborne) this.guidance.traveledSincePred += (ac.gs * dt) / 3600;

    this.predTimer += dt;
    if (this.predTimer > 2 || this.predVersion !== this.active.version) {
      this.predTimer = 0;
      this.predVersion = this.active.version;
      this.runPredictions();
    }
    this.updatePhase(ac);
    this.guidance.updateVnav(this.active, ac, this.pred, this.perfParams(), this.phase);
    this.autoTune(ac);
    this.checkMessages(ac);
    this.updateLog(ac);
  }

  runPredictions() {
    const ac = this.ac;
    const plan = this.active;
    this.pred = computePredictions({
      plan,
      perf: this.perfParams(),
      acAlt: ac.alt,
      airborne: !ac.onGround,
      activeDtg: this.guidance.activeDtg(),
      now: this.utcSec,
      originElev: plan.origin?.elev ?? 0,
      destElev: plan.dest?.elev ?? 0,
    });
    this.guidance.traveledSincePred = 0;
    if (this.mod) {
      computePredictions({
        plan: this.mod, perf: this.perfParams(this.modPerf ?? this.perf), acAlt: ac.alt, airborne: !ac.onGround,
        activeDtg: this.guidance.activeDtg(), now: this.utcSec, originElev: this.mod.origin?.elev ?? 0, destElev: this.mod.dest?.elev ?? 0,
      });
    }
  }

  private updatePhase(ac: AcState) {
    const plan = this.active;
    const crz = this.perf.crzAlt ?? 0;
    const prev = this.phase;
    if (ac.onGround) {
      if (this.phase === 'PREFLIGHT' && ac.ias > 40) this.phase = 'TAKEOFF';
      else if (this.phase !== 'PREFLIGHT' && this.phase !== 'TAKEOFF' && ac.ias < 60) this.phase = 'LANDED';
    } else {
      const agl = ac.alt - (plan.origin?.elev ?? 0);
      if (this.phase === 'PREFLIGHT' || this.phase === 'LANDED') this.phase = 'TAKEOFF';
      if (this.phase === 'TAKEOFF' && agl > 1500) this.phase = 'CLIMB';
      if (plan.missedActive) this.phase = 'MISSED';
      else if (this.phase === 'CLIMB' && crz && ac.alt >= crz - 150) { this.phase = 'CRUISE'; this.tocReached = true; }
      else if ((this.phase === 'CLIMB' || this.phase === 'CRUISE') && this.pred?.tod && this.pred.tod.dist - this.guidance.traveledSincePred <= 0.3) this.phase = 'DESCENT';
      else if (this.phase === 'CRUISE' && crz && ac.alt < crz - 1500 && ac.vs < -500) this.phase = 'DESCENT';
      const leg = plan.legs[plan.activeIdx];
      if ((this.phase === 'DESCENT' || this.phase === 'CRUISE') && leg && (leg.seg === 'APP') && plan.dest && distance(ac.pos, plan.dest) < 30) this.phase = 'APPROACH';
      if (this.phase === 'MISSED' && !plan.missedActive) this.phase = 'CLIMB';
    }
    if (prev !== this.phase) this.changed();
  }

  private autoTune(ac: AcState) {
    const plan = this.active;
    const r = this.radios;
    // ILS auto-tune when an ILS/LOC approach is active and within 30 NM
    const rw = plan.destRwy;
    const appType = plan.app?.type ?? '';
    if (rw && rw.ilsFreq && (appType === 'ILS' || appType === 'LOC' || appType === 'LOCB') && plan.dest && distance(ac.pos, plan.dest) < 30 && !ac.onGround) {
      if (r.nav1Auto && r.nav1 !== rw.ilsFreq) { r.nav1 = rw.ilsFreq; this.approachArmedRwy = rw.id; }
      if (r.nav2Auto && r.nav2 !== rw.ilsFreq) r.nav2 = rw.ilsFreq;
      return;
    }
    // Otherwise tune the nearest VOR on the route for DME/DME updating
    if (Math.floor(this.utcSec) % 10 !== 0) return;
    const near = navdb.navaidsNear(ac.pos, 120).filter((n) => n.kind === 'VOR' && n.freq && n.freq > 107 && n.freq < 118.5);
    if (!near.length) return;
    near.sort((a, b) => distance(ac.pos, a) - distance(ac.pos, b));
    if (r.nav1Auto && near[0]) r.nav1 = near[0].freq!;
    if (r.nav2Auto && near[1]) r.nav2 = near[1].freq!;
  }

  /** Navaid tuned on a frequency closest to the aircraft. */
  tunedStation(freq: number): Waypoint | null {
    const list = navdb.navaidsNear(this.ac.pos, 200).filter((n) => n.freq && Math.abs(n.freq - freq) < 0.001);
    const ils = this.active.destRwy && Math.abs(this.active.destRwy.ilsFreq - freq) < 0.001
      ? navdb.find(this.active.destRwy.ilsIdent).filter((w) => w.kind === 'ILS') : [];
    const all = [...ils, ...list];
    if (!all.length) return null;
    all.sort((a, b) => distance(this.ac.pos, a) - distance(this.ac.pos, b));
    return all[0];
  }

  private checkMessages(ac: AcState) {
    const plan = this.active;
    const lnav = this.guidance.lnav;
    if (lnav.disco && !ac.onGround) this.once('disco' + plan.legs[plan.activeIdx]?.uid, 'DISCONTINUITY', true);
    if (!lnav.disco) this.clearMessage('DISCONTINUITY');
    // TOD alert
    const v = this.guidance.vnav;
    if (v.todDist != null && v.todDist < ac.gs / 60 && v.todDist > 0 && this.phase === 'CRUISE') {
      this.once('tod' + plan.version, 'TOP OF DESCENT');
      if (this.altSel >= (this.perf.crzAlt ?? 0) - 100) this.once('altsel' + plan.version, 'RESET ALT SEL', true);
    }
    if (this.phase === 'DESCENT') this.clearMessage('TOP OF DESCENT');
    if (this.pred?.unable) this.once('unable' + plan.version, 'UNABLE NEXT ALT', true);
    // Fuel
    if (this.pred?.valid && this.perf.confirmed && this.pred.destFuel < this.perf.reserve && plan.dest) {
      this.once('fuel' + Math.floor(this.utcSec / 600), 'INSUFFICIENT FUEL', true);
    }
    if (lnav.endOfRoute && !ac.onGround && plan.legs.length > 1 && plan.activeIdx >= plan.legs.length - 1) this.once('eor' + plan.version, 'END OF FPLN');
    if (plan.missedActive) this.once('missed' + plan.version, 'MISSED APPROACH');
    // Hold
    const leg = plan.legs[plan.activeIdx];
    if (leg?.hold && leg.hold.exitArmed) this.once('hexit' + leg.uid, 'HOLD EXIT ARMED');
    // Speed above max speed for the configuration is handled by the sim (overspeed)
    if (ac.onGround && plan.origin && this.posInit && distance(ac.pos, plan.origin) > 3 && this.phase === 'PREFLIGHT') this.once('chkpos', 'CHECK POS', true);
  }

  private updateLog(ac: AcState) {
    const L = this.log;
    if (ac.onGround && ac.gs > 5 && L.outTime == null) { L.outTime = this.utcSec; L.fuelAtOut = this.fuelQty; }
    if (!ac.onGround && L.offTime == null) { L.offTime = this.utcSec; L.fuelAtOff = this.fuelQty; }
    if (ac.onGround && L.offTime != null && L.onTime == null) { L.onTime = this.utcSec; L.fuelAtOn = this.fuelQty; }
    if (ac.onGround && L.onTime != null && ac.gs < 2 && L.inTime == null) L.inTime = this.utcSec;
  }

  resetFlight() {
    this.active = new FlightPlan();
    this.mod = null;
    this.sec = new FlightPlan();
    this.modPerf = null;
    const keep = { tailNo: this.perf.tailNo, bow: this.perf.bow };
    this.perf = { ...defaultPerf(), ...keep };
    this.guidance.reset();
    this.pred = null;
    this.messages = [];
    this.seenMessages.clear();
    this.phase = 'PREFLIGHT';
    this.posInit = false;
    this.tocReached = false;
    this.log = { outTime: null, offTime: null, onTime: null, inTime: null, fuelAtOut: null, fuelAtOff: null, fuelAtOn: null, dist: 0 };
    this.changed();
  }

  // -------------------------------------------------------------------------
  // Waypoint entry parsing (PBD, PB/PB, LAT/LON, along-track)

  private pilotSeq = 1;
  nextPilotName(base: string): string {
    const b = base.replace(/[^A-Z0-9]/g, '').slice(0, 3) || 'WPT';
    for (;;) {
      const n = `${b}${String(this.pilotSeq++).padStart(2, '0')}`;
      if (!navdb.find(n).length) return n;
      if (this.pilotSeq > 99) this.pilotSeq = 1;
    }
  }

  /**
   * Parse a defined waypoint entry. Returns a new pilot waypoint, null when the
   * text is a plain identifier, or 'INVALID' when malformed.
   * `resolve` is used to look up reference waypoints (may be async through a select page).
   */
  parseDefinedWaypoint(text: string, ref: LatLon): Waypoint | 'INVALID' | null {
    const t = text.trim().toUpperCase();
    const ll = parseLatLon(t);
    if (ll) {
      const name = this.nextPilotName('LL');
      return { ident: name, lat: ll.lat, lon: ll.lon, kind: 'USR', def: t };
    }
    // PBD: IDENT/BRG/DIST
    let m = /^([A-Z0-9]{1,7})\/(\d{1,3}(?:\.\d)?)\/(\d{1,3}(?:\.\d+)?)$/.exec(t);
    if (m) {
      const base = navdb.findNear(m[1], ref)[0];
      if (!base) return 'INVALID';
      const brgMag = parseFloat(m[2]);
      if (brgMag > 360) return 'INVALID';
      const d = parseFloat(m[3]);
      const dec = base.kind === 'VOR' && base.dec != null ? base.dec : null;
      const brgT = dec != null ? norm360(brgMag + dec) : magToTrue(brgMag, base.lat, base.lon);
      const p = destination(base, brgT, d);
      return { ident: this.nextPilotName(base.ident), lat: p.lat, lon: p.lon, kind: 'USR', def: `${base.ident}/${m[2]}/${m[3]}` };
    }
    // PB/PB: IDENT/BRG/IDENT/BRG
    m = /^([A-Z0-9]{1,7})\/(\d{1,3})\/([A-Z0-9]{1,7})\/(\d{1,3})$/.exec(t);
    if (m) {
      const a = navdb.findNear(m[1], ref)[0];
      const b = navdb.findNear(m[3], ref)[0];
      if (!a || !b) return 'INVALID';
      const ta = a.kind === 'VOR' && a.dec != null ? norm360(+m[2] + a.dec) : magToTrue(+m[2], a.lat, a.lon);
      const tb = b.kind === 'VOR' && b.dec != null ? norm360(+m[4] + b.dec) : magToTrue(+m[4], b.lat, b.lon);
      const p = intersection(a, ta, b, tb);
      if (!p) return 'INVALID';
      return { ident: this.nextPilotName(a.ident), lat: p.lat, lon: p.lon, kind: 'USR', def: t };
    }
    // Along track: IDENT/-10 or IDENT/+10 (relative to the flight plan)
    m = /^([A-Z0-9]{1,7})\/([+-]?\d{1,3}(?:\.\d)?)$/.exec(t);
    if (m) {
      const plan = this.plan;
      const idx = plan.legs.findIndex((l) => l.fix?.ident === m![1]);
      if (idx < 0) return 'INVALID';
      const leg = plan.legs[idx];
      const d = parseFloat(m[2]);
      let p: LatLon | null = null;
      if (d < 0 && leg.geo) {
        const g = leg.geo;
        p = destination(g.end, norm360(g.crsOut + 180), -d);
      } else if (d > 0) {
        const nxt = plan.legs[idx + 1];
        const crs = nxt?.geo ? nxt.geo.crsIn : leg.geo?.crsOut ?? 0;
        p = destination(leg.fix!, crs, d);
      }
      if (!p) return 'INVALID';
      return { ident: this.nextPilotName(m[1]), lat: p.lat, lon: p.lon, kind: 'USR', def: t };
    }
    if (/^[A-Z0-9]{1,7}$/.test(t)) return null;
    return 'INVALID';
  }

  /** Default hold at a fix (inbound = course arriving at the fix). */
  defaultHold(idx: number): HoldSpec {
    const plan = this.plan;
    const leg = plan.legs[idx];
    let inbound = 0;
    if (leg?.fix) {
      // Inbound course: the course arriving at the fix
      const from = leg.ppos ?? plan.prevFixLeg(idx)?.fix ?? this.ac.pos;
      const crsT = leg.geo && leg.geo.length > 0.1 ? leg.geo.crsOut : distance(from, leg.fix) > 0.1 ? norm360(bearing(leg.fix, from) + 180) : this.ac.trk;
      inbound = Math.round(trueToMag(crsT, leg.fix.lat, leg.fix.lon));
    }
    return { inbound: inbound || 360, turn: 'R', legTime: this.ac.alt > 14000 ? 1.5 : 1.0 };
  }

  // -------------------------------------------------------------------------
  // Route strings and pilot routes

  routeString(plan: FlightPlan = this.active): string {
    const parts: string[] = [];
    if (plan.origin) parts.push(plan.origin.ident);
    for (const e of plan.routeElements()) {
      if (e.disco) continue;
      if (e.seg === 'SID') parts.push(e.via);
      else if (e.seg === 'STAR') parts.push(e.via);
      else if (e.seg === 'APP') continue;
      else if (e.via === 'DIRECT') parts.push(e.to);
      else parts.push(e.via, e.to);
    }
    if (plan.dest) parts.push(plan.dest.ident);
    return parts.join(' ');
  }

  /** Load a route such as "KDEN PLAIN2.AKO J80 DBL KSLC" into a plan. */
  async loadRouteString(plan: FlightPlan, route: string): Promise<string | null> {
    const toks = route.toUpperCase().replace(/[,]/g, ' ').split(/\s+/).filter((t) => t && t !== 'DCT');
    if (toks.length < 2) return 'INVALID ROUTE';
    const orig = navdb.getAirport(toks[0]);
    const dest = navdb.getAirport(toks[toks.length - 1]);
    if (!orig || !dest) return 'NOT IN DATA BASE';
    plan.setOrigin(orig);
    plan.setDest(dest);
    const [po, pd] = await Promise.all([navdb.ensureProcedures(orig.ident), navdb.ensureProcedures(dest.ident)]);
    const mids = toks.slice(1, -1);
    let pendingAirway: string | null = null;
    let ref: LatLon = orig;
    for (let i = 0; i < mids.length; i++) {
      const t = mids[i];
      const [a, b] = t.split('.');
      // SID
      if (i === 0 && po) {
        const sid = po.sids.find((s) => s.id === a || s.id === t);
        if (sid) {
          plan.insertSid(sid, b && sid.en[b] ? b : null);
          const last = plan.lastEnrouteFix();
          if (last) ref = last;
          continue;
        }
      }
      // STAR (last or second to last token)
      if (pd && i >= mids.length - 2) {
        const star = pd.stars.find((s) => s.id === a || s.id === b || s.id === t);
        if (star) {
          const trans = star.id === a ? (b && star.en[b] ? b : null) : a && star.en[a] ? a : null;
          plan.insertStar(star, trans);
          continue;
        }
      }
      if (navdb.hasAirway(t) && !navdb.find(t).length) {
        pendingAirway = t;
        continue;
      }
      const w = navdb.findNear(t, ref)[0];
      if (!w) return `NOT IN DATA BASE ${t}`;
      const err = plan.appendVia(pendingAirway ?? 'DIRECT', w);
      if (err && pendingAirway) plan.appendVia('DIRECT', w);
      pendingAirway = null;
      ref = w;
    }
    plan.routeName = '';
    return null;
  }

  savedRoutes(): { name: string; route: string }[] {
    try {
      return JSON.parse(localStorage.getItem(ROUTES_KEY) || '[]');
    } catch {
      return [];
    }
  }
  saveRoute(name: string, route: string) {
    const list = this.savedRoutes().filter((r) => r.name !== name);
    list.push({ name, route });
    try { localStorage.setItem(ROUTES_KEY, JSON.stringify(list.slice(-40))); } catch { /* storage unavailable */ }
  }
  deleteRoute(name: string) {
    const list = this.savedRoutes().filter((r) => r.name !== name);
    try { localStorage.setItem(ROUTES_KEY, JSON.stringify(list)); } catch { /* storage unavailable */ }
  }

  // -------------------------------------------------------------------------
  // Convenience

  distanceTo(w: LatLon): number {
    return distance(this.ac.pos, w);
  }
  bearingTo(w: LatLon): number {
    return bearing(this.ac.pos, w);
  }
  /** ETA (seconds of day) for an ETE in seconds. */
  eta(ete: number): number {
    return (this.utcSec + ete) % 86400;
  }

  activateSecondary() {
    const p = this.sec.clone();
    p.activeIdx = 1;
    this.mod = p;
  }
  copyActiveToSec() {
    this.sec = this.active.clone();
  }
  isDestAirport(a: Airport) {
    return this.plan.dest?.ident === a.ident;
  }
  sameFix = sameFix;
  aptWpt = aptWpt;
}

export const fms = new FMS();
