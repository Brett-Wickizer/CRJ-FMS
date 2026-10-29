// Navigation database: airports, runways, navaids, fixes, airways and procedures.
import { LatLon, distance, destination, bearing } from '../util/geo';

export type WptKind = 'APT' | 'VOR' | 'NDB' | 'FIX' | 'RWY' | 'ILS' | 'USR';

export interface Runway {
  id: string; // e.g. 16R
  endLat: number;
  endLon: number;
  lat: number; // landing threshold (displacement applied)
  lon: number;
  brg: number; // true runway heading
  length: number;
  width: number;
  elev: number;
  dispThr: number;
  ilsFreq: number;
  ilsIdent: string;
  ilsCrs: number; // magnetic
  gsAngle: number;
  tch: number;
  hard: boolean;
  aptIdent: string;
}

export interface Airport {
  ident: string;
  name: string;
  lat: number;
  lon: number;
  elev: number;
  magvar: number;
  transAlt: number;
  hasProcs: boolean;
  city: string;
  country: string;
  runways: Runway[];
  longest: number;
}

export interface Waypoint {
  ident: string;
  lat: number;
  lon: number;
  kind: WptKind;
  /** Navaid subtype: V VD VT T D N ND IL IG */
  sub?: string;
  name?: string;
  freq?: number;
  /** VOR station declination (east +) or ILS magnetic course for localizers. */
  dec?: number;
  elev?: number;
  region?: string;
  country?: string;
  apt?: Airport;
  rwy?: Runway;
  /** Pilot waypoint definition text (e.g. DEN/090/20). */
  def?: string;
}

export interface RawLeg {
  p: string;
  f?: string;
  la?: number;
  lo?: number;
  k?: string;
  c?: number;
  d?: number;
  ht?: number;
  t?: 'L' | 'R';
  tv?: 1;
  a?: [string, number | null, number | null];
  s?: [string, number];
  rn?: string;
  th?: number;
  rh?: number;
  rla?: number;
  rlo?: number;
  rmv?: number;
  r?: number;
  cf?: string;
  fo?: 1;
  faf?: 1;
  map?: 1;
  iaf?: 1;
  iif?: 1;
  facf?: 1;
  vpa?: number;
  rnp?: number;
}

export interface SidStar {
  id: string;
  rw: Record<string, RawLeg[]>;
  cm: RawLeg[];
  en: Record<string, RawLeg[]>;
  ta: number;
}

export interface Approach {
  id: string;
  n: string;
  ty: string;
  rwy: string;
  tr: Record<string, RawLeg[]>;
  fn: RawLeg[];
  ma: RawLeg[];
}

export interface ProcSet {
  sids: SidStar[];
  stars: SidStar[];
  apps: Approach[];
}

export interface NavMeta {
  name: string;
  cycle: { ident: string; eff: string; exp: string; prevIdent: string; prevEff: string; prevExp: string };
  counts: Record<string, number>;
  sources: string[];
}

type AirwayPoint = [string, number, number, string, number];

const NAV_KIND: Record<string, WptKind> = { V: 'VOR', VD: 'VOR', VT: 'VOR', T: 'VOR', D: 'VOR', N: 'NDB', ND: 'NDB', IL: 'ILS', IG: 'ILS' };

class Grid<T extends LatLon> {
  private cells = new Map<number, T[]>();
  private key(lat: number, lon: number) {
    return (Math.floor(lat + 90) * 360) + Math.floor(lon + 180);
  }
  add(item: T) {
    const k = this.key(item.lat, item.lon);
    let c = this.cells.get(k);
    if (!c) this.cells.set(k, (c = []));
    c.push(item);
  }
  query(center: LatLon, rangeNm: number, out: T[] = []): T[] {
    const dLat = rangeNm / 60;
    const dLon = rangeNm / (60 * Math.max(0.1, Math.cos((center.lat * Math.PI) / 180)));
    const la0 = Math.floor(center.lat - dLat), la1 = Math.floor(center.lat + dLat);
    const lo0 = Math.floor(center.lon - dLon), lo1 = Math.floor(center.lon + dLon);
    for (let la = la0; la <= la1; la++) {
      for (let lo = lo0; lo <= lo1; lo++) {
        const lon = ((lo + 180 + 360) % 360) - 180;
        const c = this.cells.get((Math.floor(la + 90) * 360) + Math.floor(lon + 180));
        if (c) for (const it of c) out.push(it);
      }
    }
    return out;
  }
}

const PILOT_KEY = 'crjfms.pilotwpts.v1';

export class NavDB {
  meta!: NavMeta;
  airports = new Map<string, Airport>();
  private byIdent = new Map<string, Waypoint[]>();
  private aptGrid = new Grid<Airport>();
  private navGrid = new Grid<Waypoint>();
  private fixGrid = new Grid<Waypoint>();
  private airways = new Map<string, AirwayPoint[][]>();
  private procCache = new Map<string, Promise<ProcSet | null>>();
  pilotWpts: Waypoint[] = [];
  loaded = false;
  base = './navdata/';

  async load(progress?: (msg: string, frac: number) => void): Promise<void> {
    const files = ['meta.json', 'airports.json', 'navaids.json', 'fixes.json', 'airways.json'];
    let done = 0;
    const get = async (f: string) => {
      const r = await fetch(this.base + f);
      if (!r.ok) throw new Error(`Failed to load ${f}`);
      const j = await r.json();
      done++;
      progress?.(f, done / files.length);
      return j;
    };
    const [meta, apts, navs, fixes, awys] = await Promise.all(files.map(get));
    this.meta = meta;
    this.ingestAirports(apts);
    this.ingestNavaids(navs);
    this.ingestFixes(fixes);
    for (const [k, v] of Object.entries(awys as Record<string, AirwayPoint[][]>)) this.airways.set(k, v);
    this.loadPilotWpts();
    this.loaded = true;
  }

  private addIdent(w: Waypoint) {
    let a = this.byIdent.get(w.ident);
    if (!a) this.byIdent.set(w.ident, (a = []));
    a.push(w);
  }

  private ingestAirports(rows: any[]) {
    for (const r of rows) {
      const [ident, name, lat, lon, elev, mv, ta, proc, city, cc, rws] = r;
      const apt: Airport = { ident, name, lat, lon, elev, magvar: mv, transAlt: ta, hasProcs: !!proc, city, country: cc, runways: [], longest: 0 };
      for (const w of rws) {
        const [id, la, lo, brg, len, wid, el, disp, ilsF, ilsId, ilsC, gs, tch, hard] = w;
        const thr = disp > 0 ? destination({ lat: la, lon: lo }, brg, disp / 6076.12) : { lat: la, lon: lo };
        const rw: Runway = {
          id, endLat: la, endLon: lo, lat: thr.lat, lon: thr.lon, brg, length: len, width: wid, elev: el, dispThr: disp,
          ilsFreq: ilsF, ilsIdent: ilsId, ilsCrs: ilsC, gsAngle: gs, tch: tch || 50, hard: !!hard, aptIdent: ident,
        };
        apt.runways.push(rw);
        if (hard && len > apt.longest) apt.longest = len;
        if (!hard && apt.longest === 0) apt.longest = Math.max(apt.longest, 0);
      }
      apt.runways.sort((a, b) => runwaySortKey(a.id) - runwaySortKey(b.id));
      this.airports.set(ident, apt);
      this.aptGrid.add(apt);
      this.addIdent({ ident, lat, lon, kind: 'APT', name, elev, apt, country: cc });
    }
  }

  private ingestNavaids(rows: any[]) {
    for (const r of rows) {
      const [ident, name, sub, lat, lon, freq, dec, elev, cc] = r;
      const w: Waypoint = { ident, name, sub, lat, lon, freq, dec, elev, kind: NAV_KIND[sub] || 'VOR', country: cc };
      this.addIdent(w);
      if (w.kind !== 'ILS') this.navGrid.add(w);
    }
  }

  private ingestFixes(rows: any[]) {
    for (const r of rows) {
      const [ident, lat, lon, region] = r;
      const w: Waypoint = { ident, lat, lon, kind: 'FIX', region };
      this.addIdent(w);
      this.fixGrid.add(w);
    }
  }

  // -------------------------------------------------------------------------
  // Pilot waypoints

  private loadPilotWpts() {
    try {
      const raw = localStorage.getItem(PILOT_KEY);
      if (raw) this.pilotWpts = JSON.parse(raw).map((w: any) => ({ ...w, kind: 'USR' }));
    } catch {
      this.pilotWpts = [];
    }
  }
  savePilotWpts() {
    try {
      localStorage.setItem(PILOT_KEY, JSON.stringify(this.pilotWpts.map(({ ident, lat, lon, def }) => ({ ident, lat, lon, def }))));
    } catch {
      /* storage unavailable */
    }
  }
  addPilotWpt(w: Waypoint): boolean {
    if (this.pilotWpts.length >= 100) return false;
    this.pilotWpts = this.pilotWpts.filter((p) => p.ident !== w.ident);
    this.pilotWpts.push({ ...w, kind: 'USR' });
    this.savePilotWpts();
    return true;
  }
  deletePilotWpt(ident: string) {
    this.pilotWpts = this.pilotWpts.filter((p) => p.ident !== ident);
    this.savePilotWpts();
  }

  // -------------------------------------------------------------------------
  // Queries

  getAirport(ident: string): Airport | undefined {
    const id = ident.toUpperCase();
    return this.airports.get(id) || (id.length === 3 ? this.airports.get('K' + id) : undefined);
  }

  /** All database waypoints with this identifier, pilot waypoints first. */
  find(ident: string): Waypoint[] {
    const id = ident.toUpperCase();
    const out: Waypoint[] = [];
    for (const p of this.pilotWpts) if (p.ident === id) out.push(p);
    const db = this.byIdent.get(id);
    if (db) out.push(...db);
    return out;
  }

  /** Waypoints sorted by distance from a reference position. */
  findNear(ident: string, ref: LatLon | null): Waypoint[] {
    const list = this.find(ident);
    if (ref && list.length > 1) list.sort((a, b) => distance(ref, a) - distance(ref, b));
    return list;
  }

  airportsNear(p: LatLon, rangeNm: number): Airport[] {
    return this.aptGrid.query(p, rangeNm).filter((a) => distance(p, a) <= rangeNm);
  }
  navaidsNear(p: LatLon, rangeNm: number): Waypoint[] {
    return this.navGrid.query(p, rangeNm).filter((a) => distance(p, a) <= rangeNm);
  }
  fixesNear(p: LatLon, rangeNm: number): Waypoint[] {
    return this.fixGrid.query(p, rangeNm).filter((a) => distance(p, a) <= rangeNm);
  }

  nearestAirports(p: LatLon, n: number, minRwy = 4000): { apt: Airport; dist: number; brg: number }[] {
    let r = 60;
    let list: Airport[] = [];
    while (r <= 960) {
      list = this.aptGrid.query(p, r).filter((a) => a.longest >= minRwy);
      if (list.length >= n) break;
      r *= 2;
    }
    return list
      .map((apt) => ({ apt, dist: distance(p, apt), brg: bearing(p, apt) }))
      .sort((a, b) => a.dist - b.dist)
      .slice(0, n);
  }

  /** Runway waypoint for an airport (e.g. RW16R). */
  runwayWaypoint(apt: Airport, rwId: string): Waypoint | null {
    const id = rwId.replace(/^RW/, '').padStart(2, '0');
    const rwy = apt.runways.find((r) => r.id === id || r.id === rwId.replace(/^RW/, ''));
    if (!rwy) return null;
    return { ident: 'RW' + rwy.id, lat: rwy.lat, lon: rwy.lon, kind: 'RWY', elev: rwy.elev, apt, rwy };
  }

  hasAirway(name: string): boolean {
    return this.airways.has(name.toUpperCase());
  }

  /**
   * Waypoints along an airway from `from` (exclusive) to `to` (inclusive).
   * Returns null when the airway does not connect them.
   */
  airwaySegment(name: string, from: Waypoint, toIdent: string): Waypoint[] | null {
    const segs = this.airways.get(name.toUpperCase());
    if (!segs) return null;
    for (const seg of segs) {
      const i = seg.findIndex((p) => p[0] === from.ident && distance(from, { lat: p[1], lon: p[2] }) < 3);
      if (i < 0) continue;
      const j = seg.findIndex((p) => p[0] === toIdent);
      if (j < 0 || j === i) continue;
      const pts = i < j ? seg.slice(i + 1, j + 1) : seg.slice(j, i).reverse();
      return pts.map((p) => this.airwayPointToWpt(p));
    }
    return null;
  }

  /** First fix shared by two airways after `from` along airway `a`. */
  airwayIntersection(a: string, from: Waypoint, b: string): string | null {
    const sa = this.airways.get(a.toUpperCase());
    const sb = this.airways.get(b.toUpperCase());
    if (!sa || !sb) return null;
    const bIds = new Set<string>();
    for (const s of sb) for (const p of s) bIds.add(p[0]);
    for (const seg of sa) {
      const i = seg.findIndex((p) => p[0] === from.ident && distance(from, { lat: p[1], lon: p[2] }) < 3);
      if (i < 0) continue;
      // Search outward in both directions, prefer the nearest shared fix.
      let best: string | null = null;
      let bestD = Infinity;
      for (let k = 0; k < seg.length; k++) {
        if (k === i) continue;
        if (bIds.has(seg[k][0])) {
          const d = Math.abs(k - i);
          if (d < bestD) { bestD = d; best = seg[k][0]; }
        }
      }
      if (best) return best;
    }
    return null;
  }

  airwayContains(name: string, ident: string): boolean {
    const segs = this.airways.get(name.toUpperCase());
    return !!segs && segs.some((s) => s.some((p) => p[0] === ident));
  }

  private airwayPointToWpt(p: AirwayPoint): Waypoint {
    const [ident, lat, lon, t] = p;
    const c = this.byIdent.get(ident);
    if (c) {
      let best: Waypoint | null = null, bd = 5;
      for (const w of c) {
        const d = distance(w, { lat, lon });
        if (d < bd) { bd = d; best = w; }
      }
      if (best) return best;
    }
    return { ident, lat, lon, kind: t === 'N' ? 'VOR' : 'FIX' };
  }

  loadProcedures(aptIdent: string): Promise<ProcSet | null> {
    const apt = this.getAirport(aptIdent);
    if (!apt || !apt.hasProcs) return Promise.resolve(null);
    let p = this.procCache.get(apt.ident);
    if (!p) {
      p = fetch(`${this.base}proc/${apt.ident}.json`)
        .then((r) => (r.ok ? (r.json() as Promise<ProcSet>) : null))
        .catch(() => null);
      this.procCache.set(apt.ident, p);
    }
    return p;
  }

  /** Synchronous access to procedures already loaded. */
  private procSync = new Map<string, ProcSet | null>();
  async ensureProcedures(aptIdent: string): Promise<ProcSet | null> {
    const ps = await this.loadProcedures(aptIdent);
    this.procSync.set(aptIdent, ps);
    return ps;
  }
  proceduresIfLoaded(aptIdent: string): ProcSet | null | undefined {
    return this.procSync.get(aptIdent);
  }
}

export function runwaySortKey(id: string): number {
  const n = parseInt(id, 10) || 0;
  const s = id.slice(-1);
  return n * 10 + (s === 'L' ? 1 : s === 'C' ? 2 : s === 'R' ? 3 : 0);
}

export function navaidTypeName(w: Waypoint): string {
  switch (w.sub) {
    case 'V': return 'VOR';
    case 'VD': return 'VOR/DME';
    case 'VT': return 'VORTAC';
    case 'T': return 'TACAN';
    case 'D': return 'DME';
    case 'N': return 'NDB';
    case 'ND': return 'NDB/DME';
    case 'IL': return 'LOC';
    case 'IG': return 'ILS';
    default:
      return w.kind === 'APT' ? 'AIRPORT' : w.kind === 'FIX' ? 'WAYPOINT' : w.kind === 'RWY' ? 'RUNWAY' : w.kind === 'USR' ? 'PILOT WPT' : w.kind;
  }
}

export const navdb = new NavDB();
