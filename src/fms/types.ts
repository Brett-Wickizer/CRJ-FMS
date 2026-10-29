import type { LatLon } from '../util/geo';
import type { Airport, Runway, Waypoint } from '../nav/navdb';

export type PathTerm =
  | 'IF' | 'TF' | 'CF' | 'DF' | 'FA' | 'FC' | 'FD' | 'FM'
  | 'CA' | 'CD' | 'CI' | 'CR' | 'RF' | 'AF' | 'VA' | 'VD'
  | 'VI' | 'VM' | 'VR' | 'PI' | 'HA' | 'HF' | 'HM';

export type SegKind = 'ORIG' | 'SID' | 'ENR' | 'STAR' | 'APP' | 'MAP' | 'DEST';

/** AT, AT OR ABOVE, AT OR BELOW, WINDOW (a1 upper, a2 lower). */
export type AltType = 'AT' | 'AB' | 'BL' | 'WIN';
export interface AltCstr {
  t: AltType;
  a1: number;
  a2?: number;
}

export type SpdType = 'AT' | 'AB' | 'BL';
export interface SpdCstr {
  t: SpdType;
  kt: number;
}

export interface HoldSpec {
  inbound: number; // magnetic inbound course
  turn: 'L' | 'R';
  legTime?: number; // minutes
  legDist?: number; // NM
  efc?: string; // HHMM
  spd?: number;
  exitArmed?: boolean;
}

export interface PathLine {
  type: 'line';
  a: LatLon;
  b: LatLon;
}
export interface PathArc {
  type: 'arc';
  c: LatLon;
  r: number;
  /** True bearing from center to start point. */
  start: number;
  /** Signed sweep in degrees, positive clockwise. */
  sweep: number;
  a: LatLon;
  b: LatLon;
}
export type PathSeg = PathLine | PathArc;

export interface LegGeo {
  start: LatLon;
  end: LatLon;
  segs: PathSeg[];
  length: number;
  crsIn: number;
  crsOut: number;
  /** True when the end of the leg is a published fix. */
  endIsFix: boolean;
  /** Manual termination: no defined end. */
  manual?: boolean;
  /** Hold racetrack drawn at the leg fix. */
  holdTrack?: PathSeg[];
  /** Expected altitude at the end of altitude-terminated legs. */
  endAlt?: number;
  /** Direct distance across a preceding discontinuity (used for predictions only). */
  discoGap?: number;
}

export interface LegPred {
  dist: number; // cumulative distance from aircraft (or origin) to leg end
  ete: number; // seconds from now
  alt: number; // predicted altitude at leg end
  spd: number; // predicted IAS at leg end
  mach: number;
  fuel: number; // predicted fuel remaining (lb)
  wind?: { dir: number; spd: number };
}

export interface FPLeg {
  uid: number;
  pt: PathTerm | 'DISCO';
  fix?: Waypoint;
  crs?: number; // magnetic
  dist?: number;
  time?: number;
  turn?: 'L' | 'R';
  turnForced?: boolean;
  alt?: AltCstr;
  spd?: SpdCstr;
  nav?: { ident: string; lat: number; lon: number; dec: number };
  theta?: number;
  rho?: number;
  arcR?: number;
  flyover?: boolean;
  faf?: boolean;
  map?: boolean;
  iaf?: boolean;
  vpa?: number;
  seg: SegKind;
  via: string;
  trans?: string;
  userAlt?: boolean;
  userSpd?: boolean;
  hold?: HoldSpec;
  /** Direct-to leg starting at a captured present position. */
  ppos?: LatLon;
  /** Intercept course (magnetic) for DIR-INTC legs. */
  intcCrs?: number;
  /** Computed */
  geo?: LegGeo;
  pred?: LegPred;
}

export interface ProcSel {
  id: string;
  trans: string | null;
}

export interface AppSel extends ProcSel {
  name: string;
  type: string;
  rwy: string;
}

export interface FlightPlanData {
  origin: Airport | null;
  dest: Airport | null;
  altn: Airport | null;
  origRwy: Runway | null;
  destRwy: Runway | null;
  sid: ProcSel | null;
  star: ProcSel | null;
  app: AppSel | null;
  fltNo: string;
  routeName: string;
  legs: FPLeg[];
  activeIdx: number;
}

export type { Airport, Runway, Waypoint };
