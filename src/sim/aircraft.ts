// CRJ700 point-mass flight model with Pro Line 4 style autoflight modes.
import { LatLon, destination, norm360, angDiff, clamp, R2D, D2R } from '../util/geo';
import { casToMach, machToCas, casToTas, tasToCas, isaTempC } from '../util/atmos';
import { magToTrue, trueToMag } from '../util/magvar';
import { CRJ700, climbRate, climbFuelFlow, cruiseFuelFlow, descentFuelFlow, takeoffFuelFlow, taxiFuelFlow, approachFuelFlow, holdFuelFlow } from '../fms/perf';
import type { Environment } from './env';
import type { LnavOut, VnavOut } from '../fms/guidance';

export type LatMode = 'ROLL' | 'HDG' | 'LNAV' | 'LOC' | 'TO' | 'GA';
export type VertMode = 'PITCH' | 'ALT' | 'ALTS' | 'VS' | 'FLC' | 'VFLC' | 'VPATH' | 'VALT' | 'VALTS' | 'GS' | 'TO' | 'GA' | 'FLARE';

export interface FcpState {
  ap: boolean;
  fd: boolean;
  yd: boolean;
  hdgSel: number;
  crsSel: number;
  altSel: number;
  spdSel: number;
  machSel: number;
  spdMach: boolean;
  vsSel: number;
  lat: LatMode;
  latArmed: LatMode | null;
  vert: VertMode;
  vertArmed: VertMode[];
  vnav: boolean;
  appr: boolean;
  halfBank: boolean;
  autoCrew: boolean;
  navSource: 'FMS' | 'LOC';
  /** Altitude held by the ALT button (null = ALT SEL capture). */
  altHold: number | null;
}

export type AcPhase = 'PARKED' | 'TO_ROLL' | 'AIRBORNE' | 'FLARE' | 'ROLLOUT' | 'STOPPED';

export interface AcState {
  lat: number;
  lon: number;
  alt: number;
  ias: number;
  tas: number;
  gs: number;
  mach: number;
  hdg: number; // true
  trk: number; // true
  vs: number;
  pitch: number;
  bank: number;
  onGround: boolean;
  gearDown: boolean;
  gearPos: number;
  flaps: number;
  flapSel: number;
  spdbrk: number;
  fuel: number;
  ff: number;
  n1: number;
  phase: AcPhase;
  radioAlt: number;
  groundElev: number;
  zfw: number;
  thrust: 'IDLE' | 'CLB' | 'TO' | 'CRZ' | 'REV' | 'GA';
  tgtIas: number;
  tgtMach: number;
  useMach: boolean;
  /** Flight director commands (deg). */
  fdBank: number;
  fdPitch: number;
}

export interface IlsBeam {
  locDev: number; // degrees, + = aircraft right of course
  gsDev: number; // degrees, + = aircraft above path
  dist: number; // NM to localizer antenna
  courseTrue: number;
  courseMag: number;
  gsValid: boolean;
  locValid: boolean;
  ident: string;
  freq: number;
  thrElev: number;
  gsAngle: number;
  /** Distance from the aircraft to the runway threshold (NM). */
  thrDist: number;
}

export interface SimInputs {
  lnav: LnavOut;
  vnav: VnavOut;
  ils: IlsBeam | null;
  v2: number;
  vr: number;
  vref: number;
  vapp: number;
  toFlaps: number;
  destElev: number;
  inApproach: boolean;
  nearDest: number; // NM
  fmsValid: boolean;
  /** Missed approach in progress: no approach re-arming or landing configuration. */
  missed: boolean;
}

const VFE: Record<number, number> = CRJ700.vfe;
const FLAP_STEPS = [0, 1, 8, 20, 30, 45];

export function newFcp(): FcpState {
  return {
    ap: false, fd: true, yd: true,
    hdgSel: 0, crsSel: 0, altSel: 10000, spdSel: 250, machSel: 0.74, spdMach: false, vsSel: 0,
    lat: 'ROLL', latArmed: null, vert: 'PITCH', vertArmed: [],
    vnav: false, appr: false, halfBank: false, autoCrew: true, navSource: 'FMS', altHold: null,
  };
}

export function newAcState(): AcState {
  return {
    lat: 0, lon: 0, alt: 0, ias: 0, tas: 0, gs: 0, mach: 0, hdg: 0, trk: 0, vs: 0, pitch: 0, bank: 0,
    onGround: true, gearDown: true, gearPos: 1, flaps: 0, flapSel: 0, spdbrk: 0, fuel: 9000, ff: 0, n1: 20,
    phase: 'PARKED', radioAlt: 0, groundElev: 0, zfw: CRJ700.bow, thrust: 'IDLE', tgtIas: 0, tgtMach: 0, useMach: false, fdBank: 0, fdPitch: 0,
  };
}

export class Aircraft {
  s: AcState = newAcState();
  fcp: FcpState = newFcp();
  events: string[] = [];
  private captureVs = 0;
  private rotateStarted = false;
  private gaHdg = 0;
  private flareStartVs = 0;
  /** Previous altitude-select value, to detect changes. */
  private lastAltSel = 0;
  lastTouchdownVs = 0;

  constructor(public env: Environment) {}

  get gw(): number {
    return this.s.zfw + this.s.fuel;
  }

  // -------------------------------------------------------------------------
  placeAt(p: LatLon, elev: number, hdgTrue: number, onRunway: boolean) {
    const s = this.s;
    s.lat = p.lat; s.lon = p.lon; s.alt = elev; s.groundElev = elev; s.radioAlt = 0;
    s.ias = 0; s.tas = 0; s.gs = 0; s.mach = 0; s.vs = 0; s.pitch = 0; s.bank = 0;
    s.hdg = hdgTrue; s.trk = hdgTrue; s.onGround = true; s.gearDown = true; s.gearPos = 1;
    s.spdbrk = 0; s.phase = onRunway ? 'STOPPED' : 'PARKED'; s.thrust = 'IDLE'; s.n1 = 21; s.ff = 0;
    s.flaps = 0; s.flapSel = 0;
    const f = this.fcp;
    f.lat = 'ROLL'; f.vert = 'PITCH'; f.latArmed = null; f.vertArmed = []; f.ap = false; f.appr = false;
    f.hdgSel = Math.round(trueToMag(hdgTrue, p.lat, p.lon));
    this.rotateStarted = false;
  }

  /** TOGA on the runway starts the takeoff; airborne it commands a go-around. */
  toga(inp: SimInputs) {
    const s = this.s, f = this.fcp;
    if (s.onGround) {
      if (s.phase === 'ROLLOUT') return;
      s.phase = 'TO_ROLL';
      s.thrust = 'TO';
      f.lat = 'TO'; f.vert = 'TO';
      if (inp.fmsValid) f.latArmed = 'LNAV';
      if (inp.fmsValid && !f.vertArmed.includes('VFLC')) f.vnav = true;
      s.flapSel = inp.toFlaps;
      s.flaps = inp.toFlaps;
      this.gaHdg = s.hdg;
      this.events.push('TAKEOFF');
    } else {
      f.lat = 'GA'; f.vert = 'GA';
      f.appr = false;
      f.latArmed = inp.fmsValid ? 'LNAV' : null;
      f.vertArmed = [];
      s.thrust = 'GA';
      this.gaHdg = s.trk;
      if (s.flapSel > 8) s.flapSel = 8;
      this.events.push('GO AROUND');
    }
  }

  // -------------------------------------------------------------------------
  update(dt: number, inp: SimInputs) {
    const s = this.s, f = this.fcp;
    if (dt <= 0) return;
    const isa = this.env.isaDev;
    const wind = this.env.windAt(s.alt, s.groundElev);
    const elev = s.groundElev;

    // ---------------- Mode logic
    if (f.altSel !== this.lastAltSel) {
      // Holding at the old preselected altitude: VNAV re-evaluates its profile.
      if (f.vnav && (f.vert === 'ALT' || f.vert === 'ALTS')) f.vert = 'VALT';
      this.lastAltSel = f.altSel;
    }
    const agl = s.alt - elev;
    if (!s.onGround) {
      if (f.latArmed === 'LNAV' && inp.lnav.valid && !inp.lnav.disco && (f.lat !== 'TO' || agl > 400) && f.lat !== 'LOC') {
        f.lat = 'LNAV';
        f.latArmed = null;
      }
      if (f.lat === 'TO' && agl > 400 && !inp.fmsValid) f.lat = 'HDG';
      if (f.vert === 'TO' && agl > 1000) {
        f.vert = f.vnav && inp.vnav.valid ? 'VFLC' : 'FLC';
        if (!f.ap && f.autoCrew) f.ap = true;
      }
      if (f.vert === 'GA' && agl > 1500 && s.vs > 0) {
        f.vert = f.vnav && inp.vnav.valid ? 'VFLC' : 'FLC';
        f.spdSel = Math.max(f.spdSel, inp.vref + 20);
      }
      if (!f.ap && f.autoCrew && agl > 600 && f.lat !== 'TO') f.ap = true;
      // LNAV lost on discontinuity -> ROLL (heading hold)
      if (f.lat === 'LNAV' && (inp.lnav.disco || !inp.lnav.valid)) {
        f.lat = 'HDG';
        f.hdgSel = Math.round(trueToMag(s.hdg, s.lat, s.lon));
        this.events.push('LNAV DISCONNECT');
      }
      // Approach: LOC/GS capture
      if (f.appr && inp.ils && inp.ils.locValid) {
        if (f.lat !== 'LOC' && Math.abs(inp.ils.locDev) < 2.0 && Math.abs(angDiff(s.trk, inp.ils.courseTrue)) < 100) {
          f.lat = 'LOC';
          f.navSource = 'LOC';
          this.events.push('LOC CAPTURE');
        }
        if (f.lat === 'LOC' && inp.ils.gsValid && f.vert !== 'GS' && f.vert !== 'FLARE' && inp.ils.gsDev < 0.15 && inp.ils.gsDev > -0.6 && inp.ils.thrDist > 0.5) {
          f.vert = 'GS';
          f.vertArmed = f.vertArmed.filter((m) => m !== 'GS');
          this.events.push('GS CAPTURE');
        }
      }
      // VNAV mode management
      if (f.vnav && inp.vnav.valid && (f.vert !== 'GS' && f.vert !== 'TO' && f.vert !== 'GA' && f.vert !== 'FLARE')) this.vnavModes(inp);
      // Altitude capture for non-VNAV climb/descent modes
      if (['FLC', 'VS'].includes(f.vert)) {
        const d = f.altSel - s.alt;
        if (Math.abs(d) < Math.abs(s.vs) / 10 + 80 && Math.sign(d) === Math.sign(s.vs || d)) {
          f.vert = 'ALTS';
          f.altHold = null;
          this.captureVs = s.vs;
        }
      }
      if (f.vert === 'ALTS' && Math.abs(f.altSel - s.alt) < 25) { f.vert = 'ALT'; f.altHold = null; }
      if (f.vert === 'VALTS' && Math.abs((this.belowPathHold ?? this.capTarget ?? this.vnavLevelTarget(inp)) - s.alt) < 25) f.vert = 'VALT';
      if (f.vert === 'VALT' && this.capTarget == null) this.capTarget = this.vnavLevelTarget(inp);
      // Flare (ILS or RNAV path to the runway)
      if ((f.vert === 'GS' || (f.vert === 'VPATH' && inp.inApproach && inp.nearDest < 3)) && s.radioAlt < 45 && s.vs < 0) {
        f.vert = 'FLARE';
        this.flareStartVs = s.vs;
      }
    }

    // ---------------- Speed target
    let tgtIas = f.spdSel;
    let useMach = f.spdMach;
    let tgtMach = f.machSel;
    if (f.vnav && inp.vnav.valid && !['TO', 'GA', 'GS', 'FLARE'].includes(f.vert)) {
      tgtIas = inp.vnav.tgtIas;
      useMach = inp.vnav.useMach;
      tgtMach = inp.vnav.tgtMach;
    }
    if (f.vert === 'TO') { tgtIas = inp.v2 + 10; useMach = false; }
    if (f.vert === 'GA') { tgtIas = inp.vref + 20; useMach = false; }
    if (f.vert === 'GS' || f.vert === 'FLARE' || (f.lat === 'LOC' && inp.ils && inp.ils.thrDist < 8)) { tgtIas = inp.vapp; useMach = false; }
    if (useMach) tgtIas = machToCas(tgtMach, s.alt);
    // Configuration limits
    const vfe = VFE[s.flaps] ?? 335;
    const vmo = Math.min(CRJ700.vmo, machToCas(CRJ700.mmo, s.alt));
    tgtIas = Math.min(tgtIas, vfe - 5, vmo - 5, s.gearPos > 0.05 && !s.onGround ? CRJ700.vlo - 5 + 30 : 999);
    s.tgtIas = Math.round(tgtIas);
    s.tgtMach = tgtMach;
    s.useMach = useMach;

    // ---------------- Virtual crew: configuration
    if (f.autoCrew) this.autoConfig(inp, agl, dt);
    else this.moveConfig(inp, dt);

    // ---------------- Ground phases
    if (s.onGround) {
      this.groundUpdate(dt, inp, wind);
      this.integrate(dt, wind);
      this.burnFuel(dt);
      return;
    }

    // ---------------- Lateral
    let hdgCmd = s.hdg;
    let bankFF = 0;
    const maxBank = f.halfBank || s.alt > 31000 ? 17 : 25;
    switch (f.lat) {
      case 'TO':
      case 'ROLL':
        hdgCmd = f.lat === 'TO' ? this.gaHdg : s.hdg;
        break;
      case 'GA':
        hdgCmd = this.gaHdg;
        break;
      case 'HDG':
        hdgCmd = magToTrue(f.hdgSel, s.lat, s.lon);
        break;
      case 'LNAV': {
        const l = inp.lnav;
        hdgCmd = l.hdgLeg ? l.trkCmd : this.trackToHeading(l.trkCmd, wind);
        bankFF = l.bankFF;
        break;
      }
      case 'LOC': {
        const ils = inp.ils;
        if (ils) {
          const xtk = Math.sin(ils.locDev * D2R) * ils.dist; // NM, + right
          const look = clamp((s.gs / 60) * 0.5, 0.6, 2.5);
          const trk = norm360(ils.courseTrue - clamp(Math.atan2(xtk, look) * R2D, -30, 30));
          hdgCmd = this.trackToHeading(trk, wind);
        }
        break;
      }
    }
    let hdgErr = angDiff(s.hdg, hdgCmd);
    if (f.lat === 'LNAV' && inp.lnav.turnDir && Math.abs(hdgErr) > 150) hdgErr = inp.lnav.turnDir === 'R' ? Math.abs(hdgErr) : -Math.abs(hdgErr);
    let bankCmd = clamp(hdgErr * 1.6 + bankFF, -maxBank, maxBank);
    if (f.lat === 'ROLL') bankCmd = 0;
    if (agl < 200) bankCmd = clamp(bankCmd, -8, 8);
    s.fdBank = bankCmd;
    const rollRate = 4.5;
    s.bank += clamp(bankCmd - s.bank, -rollRate * dt, rollRate * dt);
    const turnRate = (1091 * Math.tan(s.bank * D2R)) / Math.max(80, s.tas);
    s.hdg = norm360(s.hdg + turnRate * dt);

    // ---------------- Vertical
    const gw = this.gw;
    let vsCmd = s.vs;
    let thrust: AcState['thrust'] = 'CRZ';
    const spdErr = tgtIas - s.ias;
    const climbAvail = climbRate(s.alt, gw, isa) * (s.flaps >= 8 ? 1.2 : 1) * (s.gearPos > 0.5 ? 0.8 : 1);
    switch (f.vert) {
      case 'TO': {
        thrust = 'TO';
        vsCmd = clamp(2200 + (s.ias - (inp.v2 + 10)) * 60, 900, 3800);
        break;
      }
      case 'GA': {
        thrust = 'GA';
        vsCmd = clamp(2000 + (s.ias - tgtIas) * 60, 500, 3500);
        break;
      }
      case 'FLC':
      case 'VFLC': {
        const target = f.vert === 'VFLC' ? this.vnavLevelTarget(inp) : f.altSel;
        if (target > s.alt + 50) {
          thrust = 'CLB';
          // Pitch on speed: climb rate reduced when slow, increased when fast
          vsCmd = clamp(climbAvail * (1 + clamp(-spdErr, -15, 15) / 25), 300, climbAvail * 1.4 + 500);
        } else if (target < s.alt - 50) {
          thrust = 'IDLE';
          const base = 1300 + Math.max(0, s.ias - 180) * 11;
          vsCmd = -clamp(base * (1 + clamp(-spdErr, -20, 20) / 30) * (1 + s.spdbrk * 0.6), 500, 5000);
        } else vsCmd = (target - s.alt) * 4;
        break;
      }
      case 'VS':
        vsCmd = f.vsSel;
        thrust = f.vsSel > 200 ? 'CLB' : f.vsSel < -200 ? 'IDLE' : 'CRZ';
        if (vsCmd > climbAvail) vsCmd = climbAvail;
        break;
      case 'ALTS':
      case 'VALTS': {
        const target = f.vert === 'VALTS' ? (this.belowPathHold ?? this.capTarget ?? this.vnavLevelTarget(inp)) : f.altSel;
        const d = target - s.alt;
        const lim = Math.max(400, Math.abs(this.captureVs));
        vsCmd = clamp(d * 5, -lim, lim);
        thrust = 'CRZ';
        break;
      }
      case 'ALT':
      case 'VALT': {
        const target = f.vert === 'VALT' ? (this.belowPathHold ?? this.capTarget ?? this.vnavLevelTarget(inp)) : (f.altHold ?? f.altSel);
        vsCmd = clamp((target - s.alt) * 3, -1500, 1500);
        thrust = 'CRZ';
        break;
      }
      case 'VPATH': {
        vsCmd = inp.vnav.vsCmd ?? -1000;
        // Do not descend through the altitude preselector (except on final approach)
        if (!inp.vnav.finalApp && s.alt + (vsCmd / 60) * 6 < f.altSel && vsCmd < 0) {
          f.vert = 'ALTS';
          this.captureVs = s.vs;
        }
        thrust = 'IDLE';
        break;
      }
      case 'GS': {
        const ils = inp.ils;
        if (ils) {
          const ang = ils.gsAngle || 3;
          const base = -s.gs * 101.27 * Math.tan(ang * D2R);
          const devFt = Math.tan(ils.gsDev * D2R) * ils.thrDist * 6076;
          vsCmd = clamp(base - devFt * 2.5, -2000, 300);
        }
        thrust = 'CRZ';
        break;
      }
      case 'FLARE': {
        vsCmd = clamp(-120 - (s.radioAlt / 45) * (Math.abs(this.flareStartVs) - 120), -900, -60);
        thrust = 'IDLE';
        break;
      }
      case 'PITCH':
        vsCmd = s.vs;
        break;
    }
    // Limit vertical speed by performance
    if (vsCmd > climbAvail * 1.5 + 600 && thrust !== 'TO' && thrust !== 'GA') vsCmd = climbAvail * 1.5 + 600;
    const vsRate = f.vert === 'FLARE' ? 900 : 1200; // fpm per second
    s.vs += clamp(vsCmd - s.vs, -vsRate * dt, vsRate * dt);

    // ---------------- Speed
    let accel: number;
    const pitchOnSpeed = f.vert === 'FLC' || f.vert === 'VFLC' || f.vert === 'TO' || f.vert === 'GA';
    if (pitchOnSpeed) accel = clamp(spdErr * 0.25, -1.5, 1.5);
    else {
      // Thrust on speed (virtual auto-throttle by the crew); level/path deceleration limits
      const maxAcc = s.vs > 500 ? 0.6 : 1.4;
      let maxDec = s.vs < -500 ? 0.45 + s.spdbrk * 1.0 : 1.1 + s.spdbrk * 0.6;
      if (s.flaps >= 20) maxDec += 0.4;
      accel = clamp(spdErr * 0.3, -maxDec, maxAcc);
      thrust = spdErr > 3 ? (s.vs > 500 ? 'CLB' : 'CRZ') : spdErr < -3 ? 'IDLE' : thrust;
    }
    s.ias = Math.max(0, s.ias + accel * dt);
    s.thrust = thrust;
    // Altitude
    s.alt += (s.vs / 60) * dt;
    s.radioAlt = Math.max(0, s.alt - s.groundElev);

    // Touchdown
    if (s.alt <= s.groundElev + 0.5 && s.vs <= 0 && s.groundElev > -500) {
      s.alt = s.groundElev;
      this.lastTouchdownVs = s.vs;
      s.vs = 0;
      s.onGround = true;
      s.phase = 'ROLLOUT';
      s.bank = 0;
      f.vert = 'PITCH';
      f.lat = 'ROLL';
      f.ap = false;
      f.appr = false;
      s.spdbrk = 1;
      this.events.push(this.lastTouchdownVs < -600 ? 'HARD LANDING' : 'TOUCHDOWN');
    }
    this.integrate(dt, wind);
    this.burnFuel(dt);
  }

  private vnavLevelTarget(inp: SimInputs): number {
    const f = this.fcp, s = this.s;
    const v = inp.vnav;
    if (this.belowPathHold != null && (f.vert === 'VALT' || f.vert === 'VALTS') && (v.phase === 'DES' || v.phase === 'APP')) {
      return Math.max(this.belowPathHold, f.altSel);
    }
    if (v.phase === 'CLB' || v.phase === 'PRE') return Math.min(v.tgtAlt || f.altSel, f.altSel);
    if (v.phase === 'CRZ') return Math.min(v.tgtAlt, f.altSel > s.alt + 100 ? v.tgtAlt : f.altSel);
    if (v.finalApp) return v.tgtAlt;
    return Math.max(v.tgtAlt, f.altSel);
  }

  /** Target altitude when the current VNAV level-off began. */
  private capTarget: number | null = null;
  /** Level-off altitude while waiting below the descent path. */
  private belowPathHold: number | null = null;

  private vnavModes(inp: SimInputs) {
    const f = this.fcp, s = this.s, v = inp.vnav;
    const target = this.vnavLevelTarget(inp);
    const d = target - s.alt;
    const desc = v.phase === 'DES' || v.phase === 'APP';
    const level = f.vert === 'VALT' || f.vert === 'VALTS' || f.vert === 'ALT' || f.vert === 'ALTS';
    const capture = (mode: VertMode) => { f.vert = mode; this.captureVs = s.vs; this.capTarget = target; };
    if (!desc) this.belowPathHold = null;
    if (level) {
      const held = this.capTarget ?? target;
      if (v.phase === 'CLB' && target > held + 50) { f.vert = 'VFLC'; this.capTarget = null; return; }
      if (desc && (f.altSel < s.alt - 200 || v.finalApp) && (target < s.alt - 100 || this.belowPathHold != null || v.finalApp)) {
        if (v.pathAlt == null || s.alt - v.pathAlt > 300) { f.vert = 'VFLC'; this.belowPathHold = null; this.capTarget = null; }
        else if (s.alt - v.pathAlt > -100) { f.vert = 'VPATH'; this.belowPathHold = null; this.capTarget = null; }
        else if (this.belowPathHold == null) this.belowPathHold = Math.round(s.alt / 100) * 100; // wait for the path
        return;
      }
      return;
    }
    if (f.vert === 'VFLC') {
      if (desc && v.pathAlt != null) {
        if (Math.abs(s.alt - v.pathAlt) < 150) { f.vert = 'VPATH'; return; }
        if (s.alt < v.pathAlt - 300) { this.belowPathHold = Math.round(s.alt / 100) * 100; f.vert = 'VALTS'; this.captureVs = s.vs; return; }
      }
      if (Math.abs(d) < Math.abs(s.vs) / 10 + 80 && (Math.sign(d) === Math.sign(s.vs) || Math.abs(d) < 60)) {
        capture(target === f.altSel && Math.abs(f.altSel - (v.tgtAlt || 0)) > 50 ? 'ALTS' : 'VALTS');
      }
      return;
    }
    if (f.vert === 'VPATH') {
      if (v.pathAlt == null) { this.belowPathHold = Math.round(s.alt / 100) * 100; f.vert = 'VALTS'; return; }
      if (s.alt - v.pathAlt > 600 && !v.finalApp) f.vert = 'VFLC';
      if (!v.finalApp && Math.abs(d) < Math.abs(s.vs) / 10 + 60 && d > -10) capture(target === f.altSel ? 'ALTS' : 'VALTS');
      return;
    }
    if (['FLC', 'VS', 'PITCH'].includes(f.vert)) f.vert = 'VFLC';
  }

  private trackToHeading(trk: number, wind: { dir: number; spd: number }): number {
    const s = this.s;
    if (s.tas < 60) return trk;
    const rel = (wind.dir - trk) * D2R;
    const cross = wind.spd * Math.sin(rel);
    const wca = Math.asin(clamp(cross / s.tas, -0.5, 0.5)) * R2D;
    return norm360(trk + wca);
  }

  private groundUpdate(dt: number, inp: SimInputs, _wind: { dir: number; spd: number }) {
    const s = this.s, f = this.fcp;
    if (s.phase === 'TO_ROLL') {
      const accel = clamp(3.6 - s.ias * 0.012, 1.6, 3.6) * (this.gw < 65000 ? 1.08 : 1);
      s.ias += accel * dt;
      s.thrust = 'TO';
      if (s.ias >= inp.vr) this.rotateStarted = true;
      if (this.rotateStarted) {
        s.pitch = Math.min(14, s.pitch + 3 * dt);
        if (s.pitch > 8 && s.ias >= inp.vr + 2) {
          s.onGround = false;
          s.phase = 'AIRBORNE';
          s.vs = 600;
          this.events.push('LIFTOFF');
        }
      }
    } else if (s.phase === 'ROLLOUT') {
      const dec = s.ias > 60 ? 5.5 : 3.0;
      s.ias = Math.max(0, s.ias - dec * dt);
      s.thrust = s.ias > 60 ? 'REV' : 'IDLE';
      s.pitch = Math.max(0, s.pitch - 2 * dt);
      if (s.ias < 1) { s.phase = 'STOPPED'; s.ias = 0; s.spdbrk = 0; this.events.push('STOPPED'); }
    } else {
      s.ias = Math.max(0, s.ias - 4 * dt);
      s.thrust = 'IDLE';
      s.pitch = 0;
    }
    s.vs = 0;
    s.alt = s.groundElev;
    s.radioAlt = 0;
    s.bank = 0;
    void f;
  }

  private integrate(dt: number, wind: { dir: number; spd: number }) {
    const s = this.s;
    const isa = this.env.isaDev;
    s.tas = s.ias > 1 ? casToTas(s.ias, s.alt, isa) : 0;
    s.mach = s.ias > 1 ? casToMach(s.ias, s.alt) : 0;
    // Wind triangle
    const hr = s.hdg * D2R, wr = wind.dir * D2R;
    let vx = s.tas * Math.sin(hr) - wind.spd * Math.sin(wr);
    let vy = s.tas * Math.cos(hr) - wind.spd * Math.cos(wr);
    if (s.onGround) {
      // On the ground the aircraft tracks its heading
      vx = s.tas * Math.sin(hr);
      vy = s.tas * Math.cos(hr);
      if (s.ias < 1) { vx = 0; vy = 0; }
    }
    s.gs = Math.hypot(vx, vy);
    if (s.gs > 1) s.trk = norm360(Math.atan2(vx, vy) * R2D);
    else s.trk = s.hdg;
    const d = (s.gs * dt) / 3600;
    if (d > 0) {
      const p = destination({ lat: s.lat, lon: s.lon }, s.trk, d);
      s.lat = p.lat;
      s.lon = p.lon;
    }
    // Attitude: pitch = flight path angle + angle of attack
    if (!s.onGround) {
      const gamma = s.tas > 50 ? Math.atan((s.vs / 101.27) / s.tas) * R2D : 0;
      const aoa = clamp(3.2 * (this.gw / 65000) * (190 / Math.max(110, s.ias)) ** 2 - s.flaps * 0.07, -1, 12);
      const target = gamma + aoa;
      s.pitch += clamp(target - s.pitch, -3 * dt, 3 * dt);
      s.fdPitch = target;
    }
    // N1 for display
    const n1Tgt = { IDLE: s.onGround ? 21 : 32, CLB: 88, TO: 92, GA: 91, CRZ: 80, REV: 70 }[s.thrust];
    s.n1 += clamp(n1Tgt - s.n1, -6 * dt, 6 * dt);
    void isaTempC; void tasToCas;
  }

  private burnFuel(dt: number) {
    const s = this.s;
    let ff: number;
    if (s.onGround) ff = s.thrust === 'TO' ? takeoffFuelFlow() : s.thrust === 'REV' ? 3000 : s.phase === 'PARKED' ? 0 : taxiFuelFlow();
    else if (s.thrust === 'TO' || s.thrust === 'GA') ff = takeoffFuelFlow() * (1 - s.alt / 60000);
    else if (s.thrust === 'CLB') ff = climbFuelFlow(s.alt, this.gw);
    else if (s.thrust === 'IDLE') ff = descentFuelFlow(s.alt);
    else if (s.flaps >= 8 || s.gearDown) ff = approachFuelFlow();
    else if (s.ias < 240 && s.alt < 25000) ff = holdFuelFlow(s.alt, this.gw);
    else ff = cruiseFuelFlow(s.alt, Math.max(0.5, s.mach), this.gw, this.env.isaDev);
    if (s.phase === 'PARKED' && s.thrust === 'IDLE' && s.ias < 1) ff = 0;
    s.ff = ff;
    s.fuel = Math.max(0, s.fuel - (ff * dt) / 3600);
  }

  // -------------------------------------------------------------------------
  private flapTimer = 0;

  private autoConfig(inp: SimInputs, agl: number, dt: number) {
    const s = this.s, f = this.fcp;
    if (s.onGround) {
      if (s.phase === 'ROLLOUT' && s.ias < 60) s.flapSel = 0;
      this.moveConfig(inp, dt);
      return;
    }
    // Gear up after liftoff
    if (s.gearDown && s.vs > 300 && agl > 50 && f.vert !== 'GS' && f.vert !== 'FLARE' && !inp.inApproach) { s.gearDown = false; this.events.push('GEAR UP'); }
    if (s.gearDown && f.vert === 'GA' && s.vs > 300 && agl > 50) s.gearDown = false;
    // Flap retraction on the climb out
    const climbing = s.vs > 300 && !inp.inApproach;
    if (climbing && agl > 800) {
      if (s.flapSel >= 20 && s.ias > inp.v2 + 12) s.flapSel = 8;
      else if (s.flapSel === 8 && s.ias > inp.v2 + 22) s.flapSel = 1;
      else if (s.flapSel === 1 && s.ias > inp.v2 + 38) s.flapSel = 0;
    }
    // Climb-out after a go-around: clean up like a departure
    if (inp.missed && s.vs > 300 && agl > 400) {
      if (s.gearDown) { s.gearDown = false; this.events.push('GEAR UP'); }
      if (s.flapSel > 8) s.flapSel = 8;
      if (agl > 1000 && s.flapSel === 8 && s.ias > inp.vref + 25) s.flapSel = 1;
      if (agl > 1000 && s.flapSel === 1 && s.ias > inp.vref + 45) s.flapSel = 0;
    }
    // Approach configuration
    if (!inp.missed && (inp.inApproach || f.vert === 'GS' || f.lat === 'LOC')) {
      const thr = inp.ils?.thrDist ?? inp.nearDest;
      if (s.flapSel < 1 && s.ias < 225 && thr < 25) s.flapSel = 1;
      if (s.flapSel < 8 && s.ias < 215 && thr < 16) s.flapSel = 8;
      if (s.flapSel < 20 && s.ias < 205 && thr < 11) s.flapSel = 20;
      if (!s.gearDown && thr < 9 && s.ias < 215) { s.gearDown = true; this.events.push('GEAR DOWN'); }
      if (s.flapSel < 30 && s.gearDown && s.ias < 182 && thr < 8) s.flapSel = 30;
      if (s.flapSel < 45 && s.gearDown && s.ias < 168 && thr < 6.5) s.flapSel = 45;
      // arm the approach automatically when an ILS is tuned and an approach is active
      if (!f.appr && !inp.missed && f.vert !== 'GA' && inp.ils && inp.ils.locValid && thr < 25 && agl < 9000) { f.appr = true; this.events.push('APPR ARMED'); }
    }
    // Speed brakes: too fast in descent or high on path
    const tooFast = s.ias > s.tgtIas + 12 && s.vs < -300;
    const high = inp.vnav.vdev != null && inp.vnav.vdev > 400 && (f.vert === 'VPATH' || f.vert === 'VFLC');
    const want = !s.onGround && (tooFast || high) && s.flaps < 30 ? 1 : 0;
    s.spdbrk += clamp(want - s.spdbrk, -0.5, 0.5) * 0.2;
    // Flap motion (approx 2 s per step) and gear transit
    this.moveConfig(inp, dt);
  }

  /** Flaps move one detent every ~3 s; gear takes ~8 s. */
  private moveConfig(_inp: SimInputs, dt: number) {
    const s = this.s;
    const tgtIdx = FLAP_STEPS.indexOf(s.flapSel);
    const curIdx = FLAP_STEPS.indexOf(s.flaps);
    this.flapTimer -= dt;
    if (curIdx !== tgtIdx && tgtIdx >= 0 && this.flapTimer <= 0) {
      const next = FLAP_STEPS[curIdx + Math.sign(tgtIdx - curIdx)];
      if (next < s.flaps || s.ias <= (VFE[next] ?? 335) + 2) {
        s.flaps = next;
        this.flapTimer = 3;
      }
    }
    s.gearPos = clamp(s.gearPos + (s.gearDown ? 1 : -1) * (dt / 8), 0, 1);
  }
}

export { trueToMag };
