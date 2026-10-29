// Simulated environment: winds aloft, temperature and pressure.
import { isaTempC } from '../util/atmos';

export interface WindLayer {
  alt: number;
  dir: number;
  spd: number;
}

export class Environment {
  sfcWind = { dir: 0, spd: 0 };
  aloftWind = { dir: 270, spd: 0 };
  aloftAlt = 34000;
  isaDev = 0;
  qnh = 29.92;
  gust = 0;

  windAt(alt: number, elev = 0): { dir: number; spd: number } {
    const agl = Math.max(0, alt - elev);
    // Surface wind up to 2000 ft AGL, then blend linearly to the winds aloft
    if (agl < 2000 || this.aloftAlt <= elev + 2000) return { ...this.sfcWind };
    const f = Math.min(1, (alt - elev - 2000) / Math.max(1, this.aloftAlt - elev - 2000));
    const toV = (w: { dir: number; spd: number }) => {
      const r = (w.dir * Math.PI) / 180;
      return { x: Math.sin(r) * w.spd, y: Math.cos(r) * w.spd };
    };
    const a = toV(this.sfcWind), b = toV(this.aloftWind);
    const x = a.x + (b.x - a.x) * f, y = a.y + (b.y - a.y) * f;
    const spd = Math.hypot(x, y);
    const dir = spd < 0.5 ? 0 : ((Math.atan2(x, y) * 180) / Math.PI + 360) % 360;
    return { dir, spd };
  }

  satC(alt: number): number {
    return isaTempC(alt) + this.isaDev;
  }
}
