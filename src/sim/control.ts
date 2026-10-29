// High-level simulation controls shared by the CDU SIM pages and the web UI.
import { fms } from '../fms/fms';
import { sim } from './sim';
import { navdb, Airport, Runway } from '../nav/navdb';
import { distance } from '../util/geo';

export const settings = {
  /** Virtual ATC issues climb/descent altitude clearances into ALT SEL. */
  atcAlt: true,
};

let lastToast: ((t: string) => void) | null = null;
export function onToast(f: (t: string) => void) {
  lastToast = f;
}
const toast = (t: string) => lastToast?.(t);

function departureRunway(): { apt: Airport; rw: Runway } | null {
  const p = fms.active.origin ? fms.active : fms.plan;
  if (p.origin && p.origRwy) return { apt: p.origin, rw: p.origRwy };
  if (p.origin) {
    const rw = [...p.origin.runways].sort((a, b) => b.length - a.length)[0];
    if (rw) return { apt: p.origin, rw };
  }
  return null;
}

export function lineUp(): string | null {
  const d = departureRunway();
  if (!d) return 'ENTER ORIGIN';
  if (!sim.ac.s.onGround) return 'AIRBORNE';
  sim.lineUp(d.apt, d.rw);
  fms.lastPos = { lat: sim.ac.s.lat, lon: sim.ac.s.lon };
  syncWeights();
  toast(`LINED UP ${d.apt.ident} RW${d.rw.id}`);
  return null;
}

export function atGate(): string | null {
  const p = fms.active.origin ? fms.active : fms.plan;
  const apt = p.origin ?? sim.nearestAirport();
  if (!apt) return 'ENTER ORIGIN';
  sim.placeAtGate(apt);
  fms.lastPos = { lat: sim.ac.s.lat, lon: sim.ac.s.lon };
  syncWeights();
  toast(`AT GATE ${apt.ident}`);
  return null;
}

/** Start the takeoff roll (from line-up) or command a go-around in flight. */
export function toga(): string | null {
  const s = sim.ac.s;
  if (s.onGround) {
    if (s.phase === 'ROLLOUT') return 'LANDING ROLL';
    if (!fms.active.origin) return 'NO ACTIVE FPLN';
    const d = departureRunway();
    if (s.phase === 'PARKED' || (d && distance({ lat: s.lat, lon: s.lon }, { lat: d.rw.endLat, lon: d.rw.endLon }) > 0.6)) {
      const err = lineUp();
      if (err) return err;
    }
    syncWeights();
    if (!fms.posInit) fms.setPosition({ lat: s.lat, lon: s.lon });
    if (!fms.perf.takeoff.v1) fms.computeTakeoff(fms.perf);
    if (sim.ac.fcp.altSel < (sim.ac.s.alt + 1000)) sim.ac.fcp.altSel = Math.max(10000, Math.ceil((s.alt + 5000) / 1000) * 1000);
    sim.ac.toga(sim.inputs);
    return null;
  }
  fms.guidance.goAround = true;
  if (!fms.active.missedActive) {
    // Sequence into the missed approach
    const plan = fms.active;
    const mapIdx = plan.legs.findIndex((l) => l.seg === 'MAP');
    if (mapIdx > 0) {
      plan.activeIdx = mapIdx;
      plan.missedActive = true;
      const firstMa = plan.legs[mapIdx];
      if (firstMa?.alt) sim.ac.fcp.altSel = firstMa.alt.a1;
      else {
        const ma = plan.legs.slice(mapIdx).find((l) => l.alt);
        if (ma?.alt) sim.ac.fcp.altSel = ma.alt.a1;
      }
      fms.changed();
    }
  }
  sim.ac.toga(sim.inputs);
  return null;
}

export function syncWeights() {
  sim.ac.s.zfw = fms.zfw(fms.perf);
}

export function setFuel(lb: number) {
  sim.ac.s.fuel = lb;
}

export function resetFlight() {
  const apt = fms.active.origin;
  fms.resetFlight();
  sim.ac.fcp.vnav = false;
  sim.ac.fcp.appr = false;
  sim.events = [];
  if (apt) sim.placeAtGate(apt);
}

/** Virtual ATC: altitude clearances so a flight can be flown hands-off. */
let atcPhase = 0;
export function atcUpdate() {
  // Auto crew: go around when the MAP was passed without landing
  if (fms.guidance.missedAuto && sim.ac.fcp.autoCrew && !sim.ac.s.onGround) {
    fms.guidance.missedAuto = false;
    const ma = fms.active.legs.slice(fms.active.activeIdx).find((l) => l.alt);
    if (ma?.alt) sim.ac.fcp.altSel = ma.alt.a1;
    sim.ac.toga(sim.inputs);
    toast('GO AROUND - MISSED APPROACH');
  }
  if (!settings.atcAlt) return;
  const s = sim.ac.s, f = sim.ac.fcp;
  const crz = fms.perf.crzAlt;
  if (s.onGround) { atcPhase = 0; return; }
  const elev = fms.active.origin?.elev ?? 0;
  if (atcPhase === 0 && crz && s.alt - elev > 1500 && (fms.phase === 'CLIMB' || fms.phase === 'TAKEOFF')) {
    if (f.altSel < crz) { f.altSel = crz; toast(`ATC: CLIMB TO ${crz >= 18000 ? 'FL' + crz / 100 : crz}`); }
    atcPhase = 1;
  }
  const v = fms.guidance.vnav;
  if (atcPhase <= 1 && crz && v.todDist != null && v.todDist < 25 && (fms.phase === 'CRUISE' || fms.phase === 'CLIMB')) {
    const plan = fms.active;
    const faf = plan.legs.find((l) => l.faf && l.alt && l.seg === 'APP');
    const tgt = faf?.alt ? faf.alt.a1 : (plan.dest?.elev ?? 0) + 3000;
    const t = Math.ceil(tgt / 100) * 100;
    if (f.altSel > t) { f.altSel = t; toast(`ATC: DESCEND VIA, ALT ${t}`); }
    atcPhase = 2;
  }
  // Missed approach altitude once established on the glideslope or final path
  if (atcPhase === 2 && (f.vert === 'GS' || fms.guidance.vnav.finalApp)) {
    const ma = fms.active.legs.find((l) => l.seg === 'MAP' && l.alt);
    if (ma?.alt) f.altSel = ma.alt.a1;
    atcPhase = 3;
  }
}

export function nearestRunway(): { apt: Airport; rw: Runway } | null {
  const s = sim.ac.s;
  const p = { lat: s.lat, lon: s.lon };
  let best: { apt: Airport; rw: Runway } | null = null;
  let bd = 1e9;
  for (const a of navdb.airportsNear(p, 5)) {
    for (const r of a.runways) {
      const d = distance(p, { lat: r.endLat, lon: r.endLon });
      if (d < bd) { bd = d; best = { apt: a, rw: r }; }
    }
  }
  return best;
}
