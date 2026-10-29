// Simulation loop: couples the aircraft model, environment and the FMS.
import { LatLon, distance, bearing, destination, angDiff, norm360 } from '../util/geo';
import { trueToMag } from '../util/magvar';
import { navdb, Airport, Runway } from '../nav/navdb';
import { fms } from '../fms/fms';
import { takeoffSpeeds } from '../fms/perf';
import { Environment } from './env';
import { Aircraft, IlsBeam, SimInputs } from './aircraft';

export interface SimEvent {
  text: string;
  time: number;
}

export class Sim {
  env = new Environment();
  ac = new Aircraft(this.env);
  rate = 1;
  paused = false;
  utc: number;
  dateStr: string;
  events: SimEvent[] = [];
  onEvent: ((e: string) => void) | null = null;
  ils: IlsBeam | null = null;
  ils2: IlsBeam | null = null;
  private elevTimer = 0;
  private nearApt: Airport | null = null;
  inputs!: SimInputs;

  constructor() {
    const now = new Date();
    this.utc = now.getUTCHours() * 3600 + now.getUTCMinutes() * 60 + now.getUTCSeconds();
    this.dateStr = now.toISOString().slice(0, 10);
    this.inputs = this.buildInputs();
  }

  /** Advance by real time `realDt` seconds. */
  tick(realDt: number) {
    if (this.paused) return;
    let simDt = Math.min(realDt, 0.25) * this.rate;
    while (simDt > 1e-6) {
      const h = Math.min(0.1, simDt);
      this.step(h);
      simDt -= h;
    }
  }

  step(dt: number) {
    this.utc = (this.utc + dt) % 86400;
    this.elevTimer -= dt;
    if (this.elevTimer <= 0) { this.updateGroundElev(); this.elevTimer = 2; }
    this.ils = this.computeIls(fms.radios.nav1);
    this.ils2 = this.computeIls(fms.radios.nav2);
    this.inputs = this.buildInputs();
    this.ac.update(dt, this.inputs);
    const s = this.ac.s;
    const wind = this.env.windAt(s.alt, s.groundElev);
    fms.update(
      dt,
      { pos: { lat: s.lat, lon: s.lon }, alt: s.alt, ias: s.ias, tas: s.tas, gs: s.gs, trk: s.trk, hdg: s.hdg, vs: s.vs, onGround: s.onGround, mach: s.mach },
      s.fuel,
      this.env.satC(s.alt),
      wind,
      this.ac.fcp.altSel,
      this.utc,
    );
    while (this.ac.events.length) {
      const e = this.ac.events.shift()!;
      this.events.unshift({ text: e, time: this.utc });
      if (this.events.length > 30) this.events.pop();
      this.onEvent?.(e);
    }
  }

  private buildInputs(): SimInputs {
    const p = fms.perf;
    const t = p.takeoff;
    let v2 = t.v2, vr = t.vr;
    if (v2 == null || vr == null) {
      const apt = fms.active.origin;
      const s = takeoffSpeeds(fms.gw(p), t.flaps, apt?.elev ?? 0, 15);
      v2 = s.v2; vr = s.vr;
    }
    const ap = fms.approachSpeeds(p);
    const plan = fms.active;
    const leg = plan.legs[plan.activeIdx];
    const s = this.ac.s;
    const nearDest = plan.dest ? distance({ lat: s.lat, lon: s.lon }, plan.destRwy ?? plan.dest) : 999;
    const missed = plan.missedActive || this.ac.fcp.vert === 'GA';
    const inApproach = !s.onGround && !missed && (fms.phase === 'APPROACH' || leg?.seg === 'APP' || (nearDest < 12 && s.alt - (plan.dest?.elev ?? 0) < 4000 && fms.phase !== 'CLIMB' && fms.phase !== 'TAKEOFF'));
    return {
      lnav: fms.guidance.lnav,
      vnav: fms.guidance.vnav,
      ils: this.ils,
      v2, vr,
      vref: ap.vref,
      vapp: ap.vapp,
      toFlaps: t.flaps,
      destElev: plan.dest?.elev ?? 0,
      inApproach,
      nearDest,
      fmsValid: fms.posInit && plan.legs.length > 1,
      missed,
    };
  }

  private updateGroundElev() {
    const s = this.ac.s;
    const p = { lat: s.lat, lon: s.lon };
    const list = navdb.airportsNear(p, 12);
    let best: Airport | null = null, bd = 1e9;
    for (const a of list) {
      const d = distance(p, a);
      if (d < bd) { bd = d; best = a; }
    }
    this.nearApt = best;
    if (best) {
      // Use the nearest runway threshold elevation when close
      let elev = best.elev;
      let rd = 1e9;
      for (const r of best.runways) {
        const d = distance(p, r);
        if (d < rd) { rd = d; elev = r.elev; }
      }
      s.groundElev = elev;
    } else s.groundElev = s.onGround ? s.alt : -1000;
  }

  /** Localizer/glideslope geometry for a tuned frequency. */
  computeIls(freq: number): IlsBeam | null {
    const s = this.ac.s;
    const p = { lat: s.lat, lon: s.lon };
    let rw: Runway | null = null;
    const plan = fms.active;
    if (plan.destRwy && Math.abs(plan.destRwy.ilsFreq - freq) < 0.001) rw = plan.destRwy;
    if (!rw) {
      for (const a of navdb.airportsNear(p, 30)) {
        const r = a.runways.find((x) => Math.abs(x.ilsFreq - freq) < 0.001);
        if (r) { rw = r; break; }
      }
    }
    if (!rw || !rw.ilsFreq) return null;
    const far = destination({ lat: rw.endLat, lon: rw.endLon }, rw.brg, rw.length / 6076.12);
    const ant = destination(far, rw.brg, 0.16);
    const crsT = rw.brg;
    const brgToAnt = bearing(p, ant);
    const dist = distance(p, ant);
    const off = angDiff(crsT, brgToAnt);
    const locDev = -off;
    const locValid = Math.abs(off) < 35 && dist < 27;
    const gsAngle = rw.gsAngle || 3;
    const gsPt = destination(rw, rw.brg, (rw.tch || 50) / Math.tan((gsAngle * Math.PI) / 180) / 6076.12);
    const dGs = distance(p, gsPt);
    const along = Math.cos((angDiff(rw.brg, bearing(p, gsPt)) * Math.PI) / 180);
    const gsDev = (Math.atan2(s.alt - rw.elev, Math.max(30, dGs * 6076.12)) * 180) / Math.PI - gsAngle;
    const gsValid = !!rw.gsAngle && locValid && Math.abs(off) < 10 && dGs < 18 && along > 0;
    return {
      locDev, gsDev, dist, courseTrue: crsT, courseMag: rw.ilsCrs || Math.round(trueToMag(crsT, rw.lat, rw.lon)),
      gsValid, locValid, ident: rw.ilsIdent, freq: rw.ilsFreq, thrElev: rw.elev, gsAngle, thrDist: distance(p, rw),
    };
  }

  // -------------------------------------------------------------------------
  // Scenario placement

  placeAtGate(apt: Airport) {
    // Park near the airport reference point facing the longest runway direction
    const rw = [...apt.runways].sort((a, b) => b.length - a.length)[0];
    const hdg = rw ? rw.brg : 0;
    const p = rw ? destination(apt, norm360(hdg + 90), 0.15) : apt;
    this.ac.placeAt(p, apt.elev, hdg, false);
    this.updateGroundElev();
    this.ac.s.alt = this.ac.s.groundElev;
    this.syncFcpToAircraft();
  }

  lineUp(apt: Airport, rw: Runway) {
    // Start at the physical runway end, aligned with the runway
    const p: LatLon = { lat: rw.endLat, lon: rw.endLon };
    const start = destination(p, rw.brg, 0.03);
    this.ac.placeAt(start, rw.elev, rw.brg, true);
    this.ac.s.groundElev = rw.elev;
    this.syncFcpToAircraft();
    this.nearApt = apt;
  }

  private syncFcpToAircraft() {
    const s = this.ac.s;
    const f = this.ac.fcp;
    f.hdgSel = Math.round(trueToMag(s.hdg, s.lat, s.lon));
  }

  /** Reposition the aircraft in flight (for training) at a point along the plan. */
  placeAirborne(p: LatLon, alt: number, trkTrue: number, ias: number) {
    const s = this.ac.s;
    s.lat = p.lat; s.lon = p.lon; s.alt = alt; s.hdg = trkTrue; s.trk = trkTrue; s.ias = ias; s.vs = 0;
    s.onGround = false; s.phase = 'AIRBORNE'; s.gearDown = false; s.gearPos = 0; s.flaps = 0; s.flapSel = 0;
    s.pitch = 2; s.bank = 0;
    this.updateGroundElev();
  }

  nearestAirport(): Airport | null {
    return this.nearApt;
  }
}

export const sim = new Sim();
