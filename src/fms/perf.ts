// CRJ700 (CRJ701ER, CF34-8C5B1) performance model used by FMS predictions and the
// flight simulation. Values approximate published airline data.

export const CRJ700 = {
  type: 'CRJ-700',
  engines: 'CF34-8C5B1',
  mtow: 75000,
  mrw: 75250,
  mlw: 67000,
  mzfw: 62300,
  maxFuel: 19594,
  bow: 44245,
  paxMax: 78,
  vmo: 335,
  mmo: 0.85,
  ceiling: 41000,
  vfe: { 0: 335, 1: 230, 8: 230, 20: 220, 30: 185, 45: 170 } as Record<number, number>,
  vlo: 220,
  vle: 250,
};

function interp(table: [number, number][], x: number): number {
  if (x <= table[0][0]) return table[0][1];
  for (let i = 1; i < table.length; i++) {
    if (x <= table[i][0]) {
      const [x0, y0] = table[i - 1];
      const [x1, y1] = table[i];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return table[table.length - 1][1];
}

const ROC: [number, number][] = [
  [0, 3300], [5000, 3150], [10000, 2950], [15000, 2650], [20000, 2250], [25000, 1850],
  [30000, 1350], [33000, 1050], [35000, 820], [37000, 580], [39000, 360], [41000, 160],
];

/** Climb rate (fpm) at the climb speed schedule. */
export function climbRate(alt: number, gw: number, isaDev = 0): number {
  const w = Math.pow(65000 / Math.max(45000, gw), 1.7);
  const t = 1 - 0.018 * Math.max(0, isaDev);
  return Math.max(100, interp(ROC, alt) * w * t);
}

const CLB_FF: [number, number][] = [[0, 6500], [10000, 5600], [20000, 4700], [30000, 3850], [37000, 3350], [41000, 3050]];
export function climbFuelFlow(alt: number, gw: number): number {
  return interp(CLB_FF, alt) * Math.sqrt(gw / 65000);
}

const CRZ_FF: [number, number][] = [
  [10000, 4600], [15000, 4180], [20000, 3760], [25000, 3380], [29000, 3070], [31000, 2920],
  [33000, 2800], [35000, 2700], [37000, 2650], [39000, 2660], [41000, 2740],
];
/** Cruise fuel flow (lb/h, both engines) at M.77 or the equivalent speed. */
export function cruiseFuelFlow(alt: number, mach: number, gw: number, isaDev = 0): number {
  const base = interp(CRZ_FF, alt);
  const m = Math.pow(Math.max(0.4, mach) / 0.77, 2.2);
  // Heavier aircraft need more lift -> more induced drag, stronger at altitude
  const wExp = 0.6 + 0.9 * Math.min(1, alt / 41000);
  const w = Math.pow(gw / 65000, wExp);
  const t = 1 + 0.004 * isaDev;
  return base * m * w * t;
}

const DES_FF: [number, number][] = [[0, 1500], [10000, 1250], [20000, 1050], [30000, 900], [41000, 800]];
export const descentFuelFlow = (alt: number): number => interp(DES_FF, alt);
export const approachFuelFlow = (): number => 2200;
export const taxiFuelFlow = (): number => 950;
export const takeoffFuelFlow = (): number => 7600;
export const holdFuelFlow = (alt: number, gw: number): number => cruiseFuelFlow(Math.max(alt, 10000), 0.6, gw) * 0.92;

/** Optimum and maximum cruise altitude for a gross weight. */
export function optimumAlt(gw: number): number {
  const t: [number, number][] = [[50000, 41000], [55000, 41000], [60000, 39000], [65000, 37000], [70000, 35000], [75000, 33000]];
  return Math.round(interp(t, gw) / 1000) * 1000;
}
export function maxAlt(gw: number, isaDev = 0): number {
  const t: [number, number][] = [[50000, 41000], [60000, 41000], [65000, 40000], [70000, 38000], [75000, 36000]];
  return Math.min(41000, Math.round((interp(t, gw) - Math.max(0, isaDev) * 150) / 100) * 100);
}

export interface TakeoffSpeeds {
  v1: number;
  vr: number;
  v2: number;
  vt: number;
}

const TO8: [number, number, number, number][] = [
  [48000, 110, 111, 122],
  [50000, 112, 113, 124],
  [55000, 119, 120, 130],
  [60000, 126, 127, 136],
  [65000, 132, 133, 142],
  [70000, 138, 139, 147],
  [75000, 143, 145, 152],
];

export function takeoffSpeeds(gw: number, flaps: number, elevFt: number, oatC: number, rwyLen = 10000): TakeoffSpeeds {
  const pick = (k: 1 | 2 | 3) => interp(TO8.map((r) => [r[0], r[k]] as [number, number]), gw);
  let v1 = pick(1), vr = pick(2), v2 = pick(3);
  if (flaps === 20) { v1 -= 6; vr -= 6; v2 -= 6; }
  // High/hot fields: VR and V2 rise slightly in IAS due to VMCA/thrust effects
  const da = elevFt + Math.max(0, oatC - (15 - (elevFt / 1000) * 2)) * 120;
  vr += Math.max(0, da / 4000);
  v2 += Math.max(0, da / 5000);
  // Short runways: lower V1 for stopping capability
  if (rwyLen < 7000) v1 -= Math.min(8, (7000 - rwyLen) / 400);
  v1 = Math.max(108, Math.min(v1, vr));
  const vt = v2 + (flaps === 20 ? 44 : 38);
  return { v1: Math.round(v1), vr: Math.round(vr), v2: Math.round(v2), vt: Math.round(vt) };
}

const VREF45: [number, number][] = [[42000, 118], [45000, 121], [50000, 126], [55000, 131], [60000, 136], [65000, 141], [67000, 143], [70000, 146], [75000, 151]];
export function vref(gw: number, flaps: number): number {
  const v = interp(VREF45, gw);
  return Math.round(flaps === 30 ? v + 7 : flaps === 20 ? v + 14 : v);
}

/** Approach speed additive: half the steady headwind plus full gust, 5..20 kt. */
export function vappAdditive(headwind: number, gust: number): number {
  return Math.round(Math.min(20, Math.max(5, Math.max(0, headwind) / 2 + Math.max(0, gust))));
}

/** Unfactored landing distance, flaps 45, dry runway (ft). */
export function landingDistance(gw: number, elevFt: number, wet = false): number {
  const base = 2900 + (gw - 50000) * 0.075;
  const alt = 1 + elevFt / 1000 * 0.035;
  return Math.round(base * alt * (wet ? 1.15 : 1));
}

/** Takeoff field length, flaps 8 (ft). */
export function takeoffFieldLength(gw: number, flaps: number, elevFt: number, oatC: number): number {
  const base = 3500 + Math.max(0, gw - 50000) * 0.085;
  const isa = 15 - (elevFt / 1000) * 2;
  const f = (1 + elevFt / 1000 * 0.07) * (1 + Math.max(0, oatC - isa) * 0.012) * (flaps === 20 ? 0.92 : 1);
  return Math.round(base * f);
}

/** Takeoff N1 target (%). */
export function takeoffN1(elevFt: number, oatC: number): number {
  const isa = 15 - (elevFt / 1000) * 2;
  const n = 92.5 + elevFt / 1000 * 0.35 - Math.max(0, oatC - isa) * 0.12 - Math.max(0, isa - oatC) * 0.04;
  return Math.round(Math.min(98.4, n) * 10) / 10;
}

/** Final takeoff / clean maneuvering, flap retraction and approach speed limits. */
export const flapRetractSpeeds = (v2: number) => ({ f20: v2 + 10, f8: v2 + 20, f1: v2 + 30 });
