// ISA atmosphere and airspeed conversions. Altitudes in feet, speeds in knots.

const T0 = 288.15;
const A0 = 661.4786; // kt, sea-level speed of sound
const TROP = 36089;

export function isaTempK(altFt: number): number {
  return altFt < TROP ? T0 - 0.0019812 * altFt : 216.65;
}
export const isaTempC = (altFt: number): number => isaTempK(altFt) - 273.15;

/** Pressure ratio delta at pressure altitude. */
export function pressureRatio(altFt: number): number {
  if (altFt < TROP) return Math.pow(1 - 6.8755856e-6 * altFt, 5.2558797);
  return 0.2233609 * Math.exp(-4.806346e-5 * (altFt - TROP));
}

export function speedOfSound(tempK: number): number {
  return 38.967854 * Math.sqrt(tempK);
}

export function casToMach(cas: number, altFt: number): number {
  const qcp0 = Math.pow(1 + 0.2 * (cas / A0) ** 2, 3.5) - 1;
  const qcp = qcp0 / pressureRatio(altFt);
  return Math.sqrt(5 * (Math.pow(qcp + 1, 2 / 7) - 1));
}

export function machToCas(mach: number, altFt: number): number {
  const qcp = Math.pow(1 + 0.2 * mach * mach, 3.5) - 1;
  const qcp0 = qcp * pressureRatio(altFt);
  return A0 * Math.sqrt(5 * (Math.pow(qcp0 + 1, 2 / 7) - 1));
}

export function machToTas(mach: number, altFt: number, isaDev = 0): number {
  return mach * speedOfSound(isaTempK(altFt) + isaDev);
}

export function casToTas(cas: number, altFt: number, isaDev = 0): number {
  return machToTas(casToMach(cas, altFt), altFt, isaDev);
}

export function tasToCas(tas: number, altFt: number, isaDev = 0): number {
  const m = tas / speedOfSound(isaTempK(altFt) + isaDev);
  return machToCas(m, altFt);
}

/** Altitude where a CAS and a Mach number give the same TAS (crossover). */
export function crossoverAlt(cas: number, mach: number): number {
  let lo = 0, hi = 45000;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (casToMach(cas, mid) < mach) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Total air temperature (C) from SAT and Mach. */
export function tatC(satC: number, mach: number): number {
  return (satC + 273.15) * (1 + 0.2 * mach * mach) - 273.15;
}
