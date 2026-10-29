import './setup-node';
import { navdb } from '../src/nav/navdb';
import { fms } from '../src/fms/fms';
import { sim } from '../src/sim/sim';
import { cdu } from '../src/cdu/cdu';
import '../src/cdu/pages/all';
import type { Screen } from '../src/cdu/screen';

const dump = (s: Screen, label = '') => {
  console.log(`+------------------------+ ${label}`);
  for (const row of s.cells) console.log('|' + row.map((c) => c.ch).join('') + '|');
  console.log('+------------------------+');
};
const press = (...keys: string[]) => { for (const k of keys) cdu.key(k); };
const type = (t: string) => { for (const ch of t) cdu.key(ch === ' ' ? 'SP' : ch); };
const entry = (t: string, lsk: string) => { type(t); press(lsk); if (cdu.page.id === 'SELECT WPT') press('L1'); };
const flush = () => new Promise((r) => setTimeout(r, 50));

await navdb.load();
const den = navdb.getAirport('KDEN')!;
sim.placeAtGate(den);
sim.step(0.1);
cdu.show('STATUS');
dump(cdu.screen, 'STATUS');
press('R6'); // POS INIT
press('R3'); // GPS pos -> set pos
dump(cdu.screen, 'POS INIT');
press('FPLN');
entry('KDEN', 'L1');
entry('KSLC', 'R1');
await flush();
entry('34L', 'L3');
entry('N702SK', 'R3');
await flush();
dump(cdu.screen, 'FPLN after orig/dest/rwy');
press('DEPARR');
await flush();
cdu.render();
dump(cdu.screen, 'DEPART');
// pick BAYLR6 on right side
const findRight = (name: string) => {
  for (let p = 0; p < 10; p++) {
    for (let n = 1; n <= 5; n++) {
      const row = cdu.screen.cells[n * 2].map((c) => c.ch).join('');
      if (row.includes(name)) return n;
    }
    press('NEXT');
  }
  return 0;
};
let n = findRight('BAYLR6');
press('R' + n);
dump(cdu.screen, 'DEPART after SID');
n = findRight('HBU');
press('R' + n);
dump(cdu.screen, 'DEPART after TRANS');
press('FPLN');
press('NEXT');
dump(cdu.screen, 'FPLN p2');
// Find entry slot: type J240 into VIA then MTU into TO
const findSlot = () => {
  for (let p = 0; p < 6; p++) {
    for (let n = 1; n <= 5; n++) {
      if (cdu.page.page === 1 && n < 4) continue;
      const row = cdu.screen.cells[n * 2].map((c) => c.ch).join('');
      if (row.startsWith('-----')) return n;
    }
    press('NEXT');
  }
  return 0;
};
let slot = findSlot();
entry('J240', 'L' + slot);
entry('MTU', 'R' + slot);
dump(cdu.screen, 'FPLN after J240 MTU');
// Arrival
const ps = await navdb.ensureProcedures('KSLC');
cdu.show('ARRIVAL', { apt: navdb.getAirport('KSLC'), which: 'ACT' });
cdu.render();
dump(cdu.screen, 'ARRIVAL');
n = findRight('JAZZZ1'); press('R' + n);
dump(cdu.screen, 'ARRIVAL after STAR');
n = findRight('MTU'); press('R' + n);
// approach on the left
const findLeft = (name: string) => {
  for (let p = 0; p < 12; p++) {
    for (let n = 1; n <= 5; n++) {
      const row = cdu.screen.cells[n * 2].map((c) => c.ch).join('');
      if (row.slice(0, 12).includes(name)) return n;
    }
    press('NEXT');
  }
  return 0;
};
n = findLeft('ILS34R'); press('L' + n);
dump(cdu.screen, 'ARRIVAL after ILS34R');
n = findLeft('JAZZZ'); press('L' + n);
dump(cdu.screen, 'ARRIVAL after APP TRANS');
press('EXEC');
press('PERF');
dump(cdu.screen, 'PERF INIT 1');
press('NEXT');
entry('350', 'L1');
entry('270/45', 'L4');
dump(cdu.screen, 'PERF INIT 2');
press('NEXT');
entry('66/190', 'R1');
entry('1200', 'L2');
dump(cdu.screen, 'PERF INIT 3');
press('R6');
press('EXEC');
fms.computeTakeoff(fms.perf);
sim.ac.s.zfw = fms.zfw(); sim.ac.s.fuel = 9000;
for (let i = 0; i < 30; i++) sim.step(0.1);
fms.runPredictions();
press('LEGS');
dump(cdu.screen, 'LEGS 1');
press('NEXT');
dump(cdu.screen, 'LEGS 2');
press('NEXT'); press('NEXT');
dump(cdu.screen, 'LEGS 4');
press('FPLN');
dump(cdu.screen, 'FPLN 1 final');
press('NEXT');
dump(cdu.screen, 'FPLN 2 final');
cdu.show('TAKEOFF'); press('NEXT');
dump(cdu.screen, 'TAKEOFF 2');
press('PROG');
dump(cdu.screen, 'PROG');
press('DIR');
dump(cdu.screen, 'DIR');
press('HOLD');
entry('MTU', 'L1');
dump(cdu.screen, 'HOLD MTU');
press('INDEX');
dump(cdu.screen, 'INDEX');
console.log('msgs', fms.messages.map((m) => m.text));
