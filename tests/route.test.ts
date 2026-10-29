import './setup-node';
import { navdb } from '../src/nav/navdb';
import { fms } from '../src/fms/fms';
import { legDisplayIdent } from '../src/fms/flightplan';
import { computeGeometry } from '../src/fms/geometry';
import { trueToMag } from '../src/util/magvar';

function dump(label: string) {
  const p = fms.plan;
  console.log(`--- ${label} (active ${p.activeIdx})`);
  p.legs.forEach((l, i) => {
    const g = l.geo;
    const crs = g && l.fix ? Math.round(trueToMag(g.crsIn, l.fix.lat, l.fix.lon)) : '';
    const alt = l.alt ? `${l.alt.t}${l.alt.a1}${l.alt.a2 ? '/' + l.alt.a2 : ''}` : '';
    const pr = l.pred ? `| ${l.pred.dist.toFixed(1)}nm ${Math.round(l.pred.ete / 60)}m ${l.pred.alt}ft ${l.pred.spd}kt ${Math.round(l.pred.fuel)}lb` : '';
    console.log(String(i).padStart(3), l.seg.padEnd(4), l.pt.padEnd(5), (l.pt === 'DISCO' ? '--DISCO--' : legDisplayIdent(l)).padEnd(10), l.via.padEnd(10), String(crs).padStart(4), g ? g.length.toFixed(1).padStart(6) : '     -', alt.padEnd(14), pr);
  });
}

await navdb.load();
console.log('DB loaded', navdb.meta.cycle);
const plan = fms.editPlan();
plan.setOrigin(navdb.getAirport('KDEN')!);
plan.setDest(navdb.getAirport('KSLC')!);
const rw = plan.origin!.runways.find((r) => r.id === '34L')!;
plan.setOrigRwy(rw);
const err = await fms.loadRouteString(plan, 'KDEN BAYLR6.HBU J240 MTU JAZZZ1.MTU KSLC');
console.log('route err', err);
plan.setOrigRwy(rw);
const ps = await navdb.ensureProcedures('KSLC');
const app = ps!.apps.find((a) => a.id === 'I34R')!;
plan.insertApproach(app, 'JAZZZ');
const ctx = { airborne: false, climbGrad: 600, holdTas: 200, originElev: 5434 };
computeGeometry(plan, ctx);
fms.perf.crzAlt = 35000; fms.perf.pax = 66; fms.fuelQty = 9000;
fms.exec();
fms.ac = { pos: { lat: rw.lat, lon: rw.lon }, alt: 5434, ias: 0, tas: 0, gs: 0, trk: rw.brg, hdg: rw.brg, vs: 0, onGround: true, mach: 0 };
computeGeometry(fms.active, ctx);
fms.runPredictions();
dump('ACTIVE');
console.log('route string:', fms.routeString());
console.log('elements', fms.active.routeElements().map((e) => `${e.disco ? '--DISCO--' : e.via + ' -> ' + e.to}`).join(' | '));
const pr = fms.pred!;
console.log('TOC', pr.toc?.dist.toFixed(1), 'TOD', pr.tod?.dist.toFixed(1), 'dest', pr.destDist.toFixed(1), 'ETE', (pr.destEte / 60).toFixed(1), 'min fuel', Math.round(pr.destFuel), 'unable', pr.unable);
