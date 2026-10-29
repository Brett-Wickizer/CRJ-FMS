import './setup-node';
import { navdb } from '../src/nav/navdb';
import { fms } from '../src/fms/fms';
import { sim } from '../src/sim/sim';
import { legDisplayIdent } from '../src/fms/flightplan';
import { distance } from '../src/util/geo';

const ORIG = process.argv[2] ?? 'KDEN';
const RWY = process.argv[3] ?? '34L';
const ROUTE = process.argv[4] ?? 'KDEN BAYLR6.HBU J240 MTU MTU.JAZZZ1 KSLC';
const APP = process.argv[5] ?? 'I34R';
const APPTR = process.argv[6] ?? 'JAZZZ';
const CRZ = +(process.argv[7] ?? 35000);
const GA = process.argv[8] === 'GA';
let gaDone = false;

await navdb.load();
const plan = fms.editPlan();
const err = await fms.loadRouteString(plan, ROUTE);
if (err) throw new Error(err);
const orig = navdb.getAirport(ORIG)!;
const rw = orig.runways.find((r) => r.id === RWY)!;
plan.setOrigRwy(rw);
const dest = plan.dest!;
const ps = await navdb.ensureProcedures(dest.ident);
const app = ps?.apps.find((a) => a.id === APP);
if (app) plan.insertApproach(app, APPTR === '-' ? null : APPTR);
else if (APP.startsWith('RW')) {
  plan.insertRunwayArrival(dest.runways.find((r) => 'RW' + r.id === APP)!);
  // Pilot closes the discontinuity before the runway (DEL + LSK on LEGS)
  const di = plan.legs.findIndex((l, i) => l.pt === 'DISCO' && i > 1);
  if (di > 0) console.log('delete disco:', plan.deleteLeg(di));
}
const p = fms.editPerf();
p.crzAlt = CRZ; p.pax = 66; p.cargo = 1200;
fms.exec();
sim.ac.s.zfw = fms.zfw();
sim.ac.s.fuel = 9500;
sim.lineUp(orig, rw);
fms.setPosition({ lat: sim.ac.s.lat, lon: sim.ac.s.lon });
fms.computeTakeoff(fms.perf);
sim.ac.fcp.altSel = 10000;
sim.step(0.1);
console.log('TO speeds', fms.perf.takeoff, 'legs', fms.active.legs.length);
sim.ac.toga(sim.inputs);

let lastLat = '', lastVert = '', lastLeg = -1, lastPhase = '';
const t0 = sim.utc;
const fmt = (t: number) => `${Math.floor((t - t0) / 60).toString().padStart(3)}:${String(Math.floor((t - t0) % 60)).padStart(2, '0')}`;
let maxXtk = 0;
for (let i = 0; i < 3 * 3600 * 10; i++) {
  sim.step(0.1);
  const s = sim.ac.s, f = sim.ac.fcp;
  if (f.vert === 'GS' || fms.guidance.vnav.finalApp) { const ma = fms.active.legs.find((l) => l.seg === 'MAP' && l.alt); if (ma?.alt && f.altSel !== ma.alt.a1) { f.altSel = ma.alt.a1; console.log(fmt(sim.utc), 'MISSED APPROACH ALT SET', f.altSel); } }
  // ATC: climb clearance, descent clearance
  if (!s.onGround && s.alt > 3000 && f.altSel < CRZ && fms.phase === 'CLIMB') f.altSel = CRZ;
  const v = fms.guidance.vnav;
  if (v.todDist != null && v.todDist < 15 && f.altSel >= CRZ - 100) {
    const faf = fms.active.legs.find((l) => l.faf && l.alt);
    f.altSel = faf?.alt ? Math.round(faf.alt.a1 / 100) * 100 : dest.elev + 2000;
    console.log(fmt(sim.utc), 'ATC: descend to', f.altSel);
  }
  if (f.lat !== lastLat || f.vert !== lastVert) {
    console.log(fmt(sim.utc), `MODE ${f.lat}${f.latArmed ? '(' + f.latArmed + ')' : ''} / ${f.vert}  alt ${Math.round(s.alt)} ias ${Math.round(s.ias)} vs ${Math.round(s.vs)}`);
    lastLat = f.lat; lastVert = f.vert;
  }
  if (fms.active.activeIdx !== lastLeg) {
    const l = fms.active.legs[fms.active.activeIdx];
    console.log(fmt(sim.utc), `LEG -> ${fms.active.activeIdx} ${l?.pt} ${l ? legDisplayIdent(l) : ''}  alt ${Math.round(s.alt)} ias ${Math.round(s.ias)} gs ${Math.round(s.gs)} flaps ${s.flaps} xtk ${fms.guidance.lnav.xtk.toFixed(2)}`);
    lastLeg = fms.active.activeIdx;
  }
  if (fms.phase !== lastPhase) { console.log(fmt(sim.utc), 'PHASE', fms.phase); lastPhase = fms.phase; }
  if (f.lat === "LNAV" && !s.onGround) { const x = Math.abs(fms.guidance.lnav.xtk); if (x > 1 && i % 50 === 0) console.log(fmt(sim.utc), "XTK", x.toFixed(2), "leg", fms.active.activeIdx, fms.guidance.lnav.toIdent, "dtk", fms.guidance.lnav.dtk.toFixed(0), "trk", s.trk.toFixed(0), "bank", s.bank.toFixed(0), "hold", fms.guidance.lnav.holdState ?? ""); maxXtk = Math.max(maxXtk, x); }
  if (i % 3000 === 0 && !s.onGround) console.log(fmt(sim.utc), `  pos alt ${Math.round(s.alt)} ias ${Math.round(s.ias)} M${s.mach.toFixed(2)} vs ${Math.round(s.vs)} fuel ${Math.round(s.fuel)} vdev ${v.vdev?.toFixed(0)} tod ${v.todDist?.toFixed(1)} tgt ${v.tgtAlt}`);
  if (GA && !gaDone && !s.onGround && fms.phase === 'APPROACH' && s.radioAlt < 600 && s.vs < 0) {
    gaDone = true;
    console.log(fmt(sim.utc), '*** TOGA (go-around) at', Math.round(s.radioAlt), 'ft AGL');
    (await import('../src/sim/control')).toga();
  }
  if (GA && gaDone && fms.guidance.holdInfo()?.phase === 'OUTBOUND') { console.log(fmt(sim.utc), 'IN MISSED APPROACH HOLD', JSON.stringify(fms.guidance.holdInfo()), 'alt', Math.round(s.alt)); break; }
  if (s.phase === 'STOPPED' && i > 1000) break;
}
for (const e of sim.events.slice().reverse()) console.log('EVENT', fmt(e.time), e.text);
const s = sim.ac.s;
console.log('END', s.phase, 'dist to dest rwy', fms.active.destRwy ? distance(s, fms.active.destRwy).toFixed(2) : '-', 'fuel', Math.round(s.fuel), 'touchdown vs', Math.round(sim.ac.lastTouchdownVs), 'max LNAV xtk', maxXtk.toFixed(2));
console.log('messages', fms.messages.map((m) => m.text));
