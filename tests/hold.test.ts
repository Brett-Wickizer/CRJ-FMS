import './setup-node';
import { navdb } from '../src/nav/navdb';
import { fms } from '../src/fms/fms';
import { sim } from '../src/sim/sim';
import * as control from '../src/sim/control';
import { legDisplayIdent, isHold } from '../src/fms/flightplan';
import { distance, destination, bearing } from '../src/util/geo';

await navdb.load();
const plan = fms.editPlan();
await fms.loadRouteString(plan, 'KDEN BAYLR6.HBU J240 MTU MTU.JAZZZ1 KSLC');
const ps = await navdb.ensureProcedures('KSLC');
plan.insertApproach(ps!.apps.find((a) => a.id === 'I34R')!, 'JAZZZ');
const p = fms.editPerf();
p.crzAlt = 23000; p.pax = 50;
fms.exec();
sim.ac.s.zfw = fms.zfw(); sim.ac.s.fuel = 8000;
// Put the aircraft 30 NM before MTU on J240, active leg MTU
const mtuIdx = fms.active.legs.findIndex((l) => l.fix?.ident === 'MTU');
const mtu = fms.active.legs[mtuIdx].fix!;
const hbu = fms.active.legs[mtuIdx - 1].fix!;
const start = destination(mtu, bearing(mtu, hbu), 30);
sim.placeAirborne(start, 23000, bearing(start, mtu), 280);
fms.setPosition(start);
fms.active.activeIdx = mtuIdx;
sim.ac.fcp.lat = 'HDG'; sim.ac.fcp.latArmed = 'LNAV'; sim.ac.fcp.vert = 'VALT'; sim.ac.fcp.vnav = true; sim.ac.fcp.altSel = 23000; sim.ac.fcp.ap = true;
control.settings.atcAlt = false;
// Hold at THISL (next fix) with the CDU HOLD page logic
const e = fms.editPlan();
const thIdx = e.legs.findIndex((l) => l.fix?.ident === 'THISL');
const spec = fms.defaultHold(thIdx);
spec.turn = 'L'; spec.inbound = (spec.inbound + 180) % 360; // force a non-direct entry
e.insertHoldAt(thIdx, spec);
fms.exec();
console.log('hold spec', spec, 'legs', fms.active.legs.slice(mtuIdx, mtuIdx + 4).map((l) => `${l.pt}:${legDisplayIdent(l)}`).join(' '));
let last = '';
let circuits = 0, maxXtk = 0, armed = false, exitedAt = -1;
const t0 = sim.utc;
for (let i = 0; i < 2 * 3600 * 10; i++) {
  sim.step(0.1);
  const leg = fms.active.legs[fms.active.activeIdx];
  const h = fms.guidance.holdInfo();
  const st = `${legDisplayIdent(leg)} ${h ? h.entry + '/' + h.phase : ''}`;
  if (st !== last) {
    console.log(`${Math.round((sim.utc - t0) / 6) / 10}min`, st, 'xtk', fms.guidance.lnav.xtk.toFixed(2), 'trk', Math.round(sim.ac.s.trk), 'alt', Math.round(sim.ac.s.alt));
    if (h?.phase === 'TURN1') circuits++;
    last = st;
  }
  if (h && ['OUTBOUND', 'INBOUND'].includes(h.phase)) maxXtk = Math.max(maxXtk, Math.abs(fms.guidance.lnav.xtk));
  if (circuits >= 3 && !armed && leg.hold) { leg.hold.exitArmed = true; armed = true; console.log('EXIT ARMED'); }
  if (armed && !isHold(leg) && exitedAt < 0) { exitedAt = sim.utc; console.log('EXITED HOLD to', legDisplayIdent(leg)); }
  if (exitedAt > 0 && sim.utc - exitedAt > 120) break;
}
console.log('hold max xtk (outbound/inbound legs):', maxXtk.toFixed(2));

// Direct-to RUSHN from present position
const rush = fms.active.legs.find((l) => l.fix?.ident === 'RUSHN')!.fix!;
fms.editPlan().directTo(rush, { lat: sim.ac.s.lat, lon: sim.ac.s.lon });
fms.exec();
console.log('DIR RUSHN, active', legDisplayIdent(fms.active.legs[fms.active.activeIdx]));
for (let i = 0; i < 20 * 60 * 10; i++) {
  sim.step(0.1);
  if (legDisplayIdent(fms.active.legs[fms.active.activeIdx]) !== 'RUSHN') break;
}
console.log('after direct: active', legDisplayIdent(fms.active.legs[fms.active.activeIdx]), 'dist to RUSHN', distance(sim.ac.s, rush).toFixed(2));
