#!/usr/bin/env node
// Builds the FMS navigation database used by the web app.
//
// Sources:
//   - FAA NASR + CIFP (via the @squawk/*-data npm packages, MIT): US airports,
//     runways, ILS, navaids, fixes, airways and every SID/STAR/IAP.
//   - OurAirports (public domain): non-US airports, runways and navaids.
//     Run scripts/fetch-ourairports.sh first to download the CSV files.
//
// Output (public/navdata):
//   meta.json, airports.json, navaids.json, fixes.json, airways.json,
//   proc/<AIRPORT>.json (one file per airport with procedures)

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { magvar } = require('magvar');

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(ROOT, 'public', 'navdata');
const OA_DIR = path.join(ROOT, 'navsrc', 'ourairports');

function loadSquawk(pkg, file) {
  const p = path.join(ROOT, 'node_modules', '@squawk', pkg, 'data', file);
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(p)).toString('utf8'));
}

const r5 = (x) => Math.round(x * 1e5) / 1e5;
const r6 = (x) => Math.round(x * 1e6) / 1e6;
const r1 = (x) => Math.round(x * 10) / 10;
const D2R = Math.PI / 180;

function bearing(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * D2R, p2 = lat2 * D2R, dl = (lon2 - lon1) * D2R;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) / D2R + 360) % 360;
}
function distNm(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * D2R, p2 = lat2 * D2R;
  const a = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(((lon2 - lon1) * D2R) / 2) ** 2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(a))) * 3440.065;
}
function destPoint(lat, lon, brgDeg, dNm) {
  const d = dNm / 3440.065, b = brgDeg * D2R, p1 = lat * D2R, l1 = lon * D2R;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [p2 / D2R, ((l2 / D2R + 540) % 360) - 180];
}

// Decimal year for the WMM evaluation (mid-cycle).
const CYCLE = { ident: '2611', eff: '2026-10-29', exp: '2026-11-25', prevIdent: '2610', prevEff: '2026-10-01', prevExp: '2026-10-28' };
const DECIMAL_YEAR = 2026 + (302 + 14) / 365;
const wmm = (lat, lon) => {
  try { return r1(magvar(lat, lon, 0, DECIMAL_YEAR)); } catch { return 0; }
};

const HARD = /^(ASPH|CONC|PEM|BIT|ASP|CON|ASF|BET|TAR|PAVED|PAV|MAC|COP|ASPHALT|CONCRETE|BITUMINOUS|PSP)/i;

// ---------------------------------------------------------------------------
console.log('Loading FAA data...');
const faaAirports = loadSquawk('airport-data', 'airports.json.gz');
const faaNavaids = loadSquawk('navaid-data', 'navaids.json.gz');
const faaFixes = loadSquawk('fix-data', 'fixes.json.gz');
const faaAirways = loadSquawk('airway-data', 'airways.json.gz');
const faaProcs = loadSquawk('procedure-data', 'procedures.json.gz');

const procAirports = new Set();
for (const r of faaProcs.records) for (const a of r.airports) procAirports.add(a);

// ---------------------------------------------------------------------------
// Airports
const airports = new Map(); // ident -> record
const ilsNavaids = [];

function addRunwaysFaa(a) {
  const out = [];
  for (const rw of a.runways || []) {
    const ends = rw.ends || [];
    if (ends.length !== 2) continue;
    const [e1, e2] = ends;
    if (e1.lat == null || e2.lat == null || e1.lon == null || e2.lon == null) continue;
    if (!/^\d{1,2}[LRC]?$/.test(e1.id) || !/^\d{1,2}[LRC]?$/.test(e2.id)) continue;
    const hard = HARD.test(rw.surfaceType || '');
    for (const [e, o] of [[e1, e2], [e2, e1]]) {
      const brg = bearing(e.lat, e.lon, o.lat, o.lon);
      const ils = e.ils;
      let ilsFreq = 0, ilsId = '', ilsCrs = 0, gs = 0;
      if (ils && ils.localizerFrequencyMhz) {
        ilsFreq = ils.localizerFrequencyMhz;
        ilsId = (ils.identifier || '').replace(/^I-/, 'I').replace(/-/g, '');
        ilsCrs = ils.localizerMagneticCourseDeg ? r1(ils.localizerMagneticCourseDeg) : 0;
        gs = ils.glideSlopeAngleDeg || 0;
        // Localizer antenna sits roughly 1000 ft beyond the far runway end.
        const [lla, llo] = destPoint(o.lat, o.lon, brg, 0.16);
        ilsNavaids.push([ilsId, `${a.icao || a.faaId} RW${e.id}`, gs ? 'IG' : 'IL', r5(lla), r5(llo), ilsFreq, ilsCrs, Math.round(e.elevationFt || a.elevationFt || 0)]);
      }
      out.push([
        e.id,
        r6(e.lat), r6(e.lon),
        r1(brg),
        rw.lengthFt || Math.round(distNm(e.lat, e.lon, o.lat, o.lon) * 6076),
        rw.widthFt || 100,
        Math.round(e.tdzElevationFt ?? e.elevationFt ?? a.elevationFt ?? 0),
        e.displacedThresholdFt || 0,
        ilsFreq, ilsId, ilsCrs, gs,
        e.thresholdCrossingHeightFt || 50,
        hard ? 1 : 0,
      ]);
    }
  }
  return out;
}

let faaAptCount = 0;
for (const a of faaAirports.records) {
  if (a.facilityType !== 'AIRPORT' || a.status !== 'OPEN') continue;
  const ident = a.icao || a.faaId;
  const runways = addRunwaysFaa(a);
  const longestHard = Math.max(0, ...runways.filter((r) => r[13]).map((r) => r[4]));
  const hasProc = procAirports.has(ident) || procAirports.has(a.faaId);
  if (!(a.icao || hasProc || longestHard >= 3000)) continue;
  if (!runways.length) continue;
  airports.set(ident, {
    ident,
    name: (a.name || '').toUpperCase(),
    lat: r6(a.lat), lon: r6(a.lon),
    elev: Math.round(a.elevationFt || 0),
    mv: wmm(a.lat, a.lon),
    ta: 18000,
    proc: hasProc ? 1 : 0,
    city: (a.city || '').toUpperCase(),
    cc: a.country || 'US',
    rw: runways,
    faa: a.faaId,
  });
  faaAptCount++;
}
console.log('FAA airports', faaAptCount);

// ---------------------------------------------------------------------------
// OurAirports (non-US)
function parseCsv(text) {
  const rows = [];
  let i = 0, field = '', row = [], q = false;
  while (i < text.length) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
    i++;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const head = rows.shift();
  return rows.map((r) => Object.fromEntries(head.map((h, k) => [h, r[k] ?? ''])));
}

const TA_BY_COUNTRY = { US: 18000, CA: 18000, MX: 18500, GB: 6000, IE: 5000, DE: 5000, FR: 5000, NL: 3000, BE: 4500, ES: 6000, IT: 6000, CH: 7000, AT: 10000, AU: 10000, NZ: 13000, JP: 14000, CN: 9800, BR: 7000 };

const oaAirportsFile = path.join(OA_DIR, 'airports.csv');
let worldApt = 0, worldNav = 0;
const worldNavaids = [];
if (fs.existsSync(oaAirportsFile)) {
  console.log('Loading OurAirports...');
  const oaA = parseCsv(fs.readFileSync(oaAirportsFile, 'utf8'));
  const oaR = parseCsv(fs.readFileSync(path.join(OA_DIR, 'runways.csv'), 'utf8'));
  const oaN = parseCsv(fs.readFileSync(path.join(OA_DIR, 'navaids.csv'), 'utf8'));
  const rwByApt = new Map();
  for (const r of oaR) {
    if (r.closed === '1') continue;
    if (!rwByApt.has(r.airport_ref)) rwByApt.set(r.airport_ref, []);
    rwByApt.get(r.airport_ref).push(r);
  }
  for (const a of oaA) {
    if (a.iso_country === 'US') continue;
    if (!(a.type === 'large_airport' || a.type === 'medium_airport' || (a.type === 'small_airport' && a.scheduled_service === 'yes'))) continue;
    const ident = (a.icao_code || a.gps_code || a.ident || '').toUpperCase();
    if (!/^[A-Z]{4}$/.test(ident)) continue;
    if (airports.has(ident)) continue;
    const lat = +a.latitude_deg, lon = +a.longitude_deg;
    const runways = [];
    for (const r of rwByApt.get(a.id) || []) {
      const hard = HARD.test(r.surface || '');
      const len = +r.length_ft || 0;
      if (!r.le_latitude_deg || !r.he_latitude_deg) continue;
      if (!/^\d{1,2}[LRC]?$/.test(r.le_ident) || !/^\d{1,2}[LRC]?$/.test(r.he_ident)) continue;
      const le = [+r.le_latitude_deg, +r.le_longitude_deg], he = [+r.he_latitude_deg, +r.he_longitude_deg];
      const elev = +a.elevation_ft || 0;
      for (const [id, e, o, el, dt] of [
        [r.le_ident, le, he, r.le_elevation_ft, r.le_displaced_threshold_ft],
        [r.he_ident, he, le, r.he_elevation_ft, r.he_displaced_threshold_ft],
      ]) {
        runways.push([
          id.padStart(2, '0').replace(/^0(\d[LRC]?)$/, '0$1'),
          r6(e[0]), r6(e[1]),
          r1(bearing(e[0], e[1], o[0], o[1])),
          len || Math.round(distNm(e[0], e[1], o[0], o[1]) * 6076),
          +r.width_ft || 100,
          Math.round(el ? +el : elev),
          Math.round(+dt || 0),
          0, '', 0, 0, 50, hard ? 1 : 0,
        ]);
      }
    }
    if (!runways.length) continue;
    airports.set(ident, {
      ident,
      name: (a.name || '').toUpperCase().replace(/ INTERNATIONAL AIRPORT$/, ' INTL').replace(/ AIRPORT$/, ''),
      lat: r6(lat), lon: r6(lon),
      elev: Math.round(+a.elevation_ft || 0),
      mv: wmm(lat, lon),
      ta: TA_BY_COUNTRY[a.iso_country] || 10000,
      proc: 0,
      city: (a.municipality || '').toUpperCase(),
      cc: a.iso_country,
      rw: runways,
    });
    worldApt++;
  }
  const typeMap = { VOR: 'V', 'VOR-DME': 'VD', VORTAC: 'VT', TACAN: 'T', DME: 'D', NDB: 'N', 'NDB-DME': 'ND' };
  for (const n of oaN) {
    if (n.iso_country === 'US') continue;
    const t = typeMap[n.type];
    if (!t) continue;
    const lat = +n.latitude_deg, lon = +n.longitude_deg;
    let freq = +n.frequency_khz || 0;
    if (t !== 'N' && t !== 'ND') freq = Math.round(freq / 10) / 100; // MHz
    const mv = n.slaved_variation_deg !== '' ? +n.slaved_variation_deg : (n.magnetic_variation_deg !== '' ? +n.magnetic_variation_deg : wmm(lat, lon));
    worldNavaids.push([n.ident.toUpperCase(), (n.name || '').toUpperCase(), t, r5(lat), r5(lon), freq, r1(mv), Math.round(+n.elevation_ft || 0), n.iso_country]);
    worldNav++;
  }
}
console.log('World airports', worldApt, 'world navaids', worldNav);

// ---------------------------------------------------------------------------
// Navaids
const navTypeMap = { VOR: 'V', 'VOR/DME': 'VD', VORTAC: 'VT', TACAN: 'T', DME: 'D', NDB: 'N', 'NDB/DME': 'ND' };
const navaids = [];
for (const n of faaNavaids.records) {
  const t = navTypeMap[n.type];
  if (!t) continue;
  const freq = n.frequencyMhz ?? n.frequencyKhz ?? 0;
  let mv = n.magneticVariationDeg != null ? n.magneticVariationDeg * (n.magneticVariationDirection === 'W' ? -1 : 1) : wmm(n.lat, n.lon);
  navaids.push([n.identifier, (n.name || '').toUpperCase(), t, r5(n.lat), r5(n.lon), freq, r1(mv), Math.round(n.elevationFt || 0), n.country || 'US']);
}
for (const w of worldNavaids) {
  const dup = navaids.some((n) => n[0] === w[0] && n[2][0] === w[2][0] && distNm(n[3], n[4], w[3], w[4]) < 3);
  if (!dup) navaids.push(w);
}
// ILS/LOC: [ident, name, type, lat, lon, freq, magCourse, elev]
for (const l of ilsNavaids) navaids.push([l[0], l[1], l[2], l[3], l[4], l[5], l[6], l[7], 'US']);
console.log('Navaids', navaids.length);

// ---------------------------------------------------------------------------
// Fixes
const fixes = [];
for (const f of faaFixes.records) {
  if (f.useCode === 'VFR') continue;
  fixes.push([f.identifier, r5(f.lat), r5(f.lon), f.icaoRegionCode || '']);
}
console.log('Fixes', fixes.length);

// ---------------------------------------------------------------------------
// Airways
const airways = {};
for (const aw of faaAirways.records) {
  if (aw.type === 'SPECIAL') continue;
  const seg = [];
  for (const w of aw.waypoints) {
    const id = w.identifier || w.name;
    if (!id) continue;
    seg.push([id, r5(w.lat), r5(w.lon), w.waypointType === 'NAVAID' ? 'N' : 'F', w.minimumEnrouteAltitudeFt || w.gnssMinimumEnrouteAltitudeFt || 0]);
  }
  if (seg.length < 2) continue;
  (airways[aw.designation] ||= []).push(seg);
}
console.log('Airways', Object.keys(airways).length);

// ---------------------------------------------------------------------------
// Procedures, sharded per airport.
const navaidIndex = new Map();
for (const n of navaids) {
  if (!navaidIndex.has(n[0])) navaidIndex.set(n[0], []);
  navaidIndex.get(n[0]).push(n);
}
function resolveNavaid(ident, nearLat, nearLon) {
  const c = navaidIndex.get(ident);
  if (!c) return null;
  let best = null, bd = 1e9;
  for (const n of c) {
    const d = distNm(nearLat, nearLon, n[3], n[4]);
    if (d < bd) { bd = d; best = n; }
  }
  return bd < 250 ? best : null;
}

const NEED_NAVAID = new Set(['AF', 'CD', 'FD', 'VD', 'CR', 'VR']);
function compactLeg(l, refLat, refLon) {
  const o = { p: l.pathTerminator };
  if (l.fixIdentifier) o.f = l.fixIdentifier;
  if (l.lat != null) { o.la = r6(l.lat); o.lo = r6(l.lon); }
  if (l.category) o.k = l.category[0]; // F N A R
  if (l.courseDeg != null) o.c = l.courseDeg;
  if (l.distanceNm != null) o.d = l.distanceNm;
  if (l.holdTimeMin != null) o.ht = l.holdTimeMin;
  if (l.turnDirection) o.t = l.turnDirection;
  if (l.turnDirectionValid) o.tv = 1;
  if (l.altitudeConstraint) {
    const a = l.altitudeConstraint;
    o.a = [a.descriptor, a.primaryFt ?? null, a.secondaryFt ?? null];
  }
  if (l.speedConstraint) o.s = [l.speedConstraint.descriptor, l.speedConstraint.speedKt];
  if (l.recommendedNavaid) {
    o.rn = l.recommendedNavaid;
    if (l.thetaDeg != null) o.th = l.thetaDeg;
    if (l.rhoNm != null) o.rh = l.rhoNm;
    if (NEED_NAVAID.has(l.pathTerminator) || l.pathTerminator === 'PI') {
      const n = resolveNavaid(l.recommendedNavaid, l.lat ?? refLat, l.lon ?? refLon);
      if (n) { o.rla = n[3]; o.rlo = n[4]; o.rmv = n[2][0] === 'I' ? 0 : n[6]; }
    }
  }
  if (l.arcRadiusNm != null) o.r = l.arcRadiusNm;
  if (l.centerFix) o.cf = l.centerFix;
  if (l.isFlyover) o.fo = 1;
  if (l.isFinalApproachFix) o.faf = 1;
  if (l.isMissedApproachPoint) o.map = 1;
  if (l.isInitialApproachFix) o.iaf = 1;
  if (l.isIntermediateFix) o.iif = 1;
  if (l.isFinalApproachCourseFix) o.facf = 1;
  if (l.verticalAngleDeg != null && l.verticalAngleDeg !== 0) o.vpa = l.verticalAngleDeg;
  if (l.rnpNm != null) o.rnp = l.rnpNm;
  return o;
}
const compactLegs = (legs, a) => legs.map((l) => compactLeg(l, a?.lat ?? 0, a?.lon ?? 0));

const APP_TYPE = (name, approachType) => {
  const n = name.toUpperCase();
  if (n.startsWith('ILS')) return 'ILS';
  if (n.startsWith('LOC/DME BC') || n.startsWith('LOC BC') || n.includes(' BC ')) return 'LOCB';
  if (n.startsWith('LOC')) return 'LOC';
  if (n.startsWith('RNAV_RNP') || n.startsWith('RNAV (RNP)')) return 'RNP';
  if (n.startsWith('RNAV') || n.startsWith('GPS')) return 'RNAV';
  if (n.startsWith('VOR')) return 'VOR';
  if (n.startsWith('NDB')) return 'NDB';
  if (n.startsWith('LDA')) return 'LDA';
  if (n.startsWith('SDF')) return 'SDF';
  if (n.startsWith('TACAN')) return 'TACAN';
  if (n.startsWith('GLS')) return 'GLS';
  if (n.startsWith('IGS')) return 'IGS';
  return (approachType || 'APP').toUpperCase();
};

const procByApt = new Map();
const getApt = (id) => {
  if (!procByApt.has(id)) procByApt.set(id, { sids: [], stars: [], apps: [] });
  return procByApt.get(id);
};
for (const r of faaProcs.records) {
  for (const aptId of r.airports) {
    const apt = airports.get(aptId);
    if (!apt) continue;
    const bucket = getApt(aptId);
    if (r.type === 'SID' || r.type === 'STAR') {
      const p = { id: r.identifier, rw: {}, cm: [], en: {}, ta: r.transitionAltitudeFt || 18000 };
      for (const cr of r.commonRoutes) {
        if (cr.airports && !cr.airports.includes(aptId)) continue;
        if (cr.runway) p.rw['RW' + cr.runway.replace(/^RW/, '')] = compactLegs(cr.legs, apt);
        else if (!p.cm.length) p.cm = compactLegs(cr.legs, apt);
      }
      for (const t of r.transitions) {
        const legs = compactLegs(t.legs, apt);
        if (/^RW\d/.test(t.name) || t.name === 'ALL') p.rw[t.name] = legs;
        else p.en[t.name] = legs;
      }
      (r.type === 'SID' ? bucket.sids : bucket.stars).push(p);
    } else if (r.type === 'IAP') {
      const final = [];
      for (const cr of r.commonRoutes) {
        if (cr.airports && !cr.airports.includes(aptId)) continue;
        if (!final.length) final.push(...cr.legs);
      }
      const p = {
        id: r.identifier,
        n: r.name.replace(/_/g, ' '),
        ty: APP_TYPE(r.name, r.approachType),
        rwy: r.runway ? r.runway.replace(/^RW/, '') : '',
        tr: {},
        fn: compactLegs(final, apt),
        ma: compactLegs((r.missedApproach && r.missedApproach.legs) || [], apt),
      };
      for (const t of r.transitions) p.tr[t.name] = compactLegs(t.legs, apt);
      bucket.apps.push(p);
    }
  }
}

// ---------------------------------------------------------------------------
// Write files
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'proc'), { recursive: true });

const aptArr = [...airports.values()]
  .sort((a, b) => (a.ident < b.ident ? -1 : 1))
  .map((a) => [a.ident, a.name, a.lat, a.lon, a.elev, a.mv, a.ta, procByApt.has(a.ident) ? 1 : 0, a.city, a.cc, a.rw]);

const write = (name, data) => {
  const s = JSON.stringify(data);
  fs.writeFileSync(path.join(OUT, name), s);
  return s.length;
};

let total = 0;
total += write('airports.json', aptArr);
total += write('navaids.json', navaids);
total += write('fixes.json', fixes);
total += write('airways.json', airways);
let procBytes = 0;
for (const [id, p] of procByApt) {
  p.sids.sort((a, b) => (a.id < b.id ? -1 : 1));
  p.stars.sort((a, b) => (a.id < b.id ? -1 : 1));
  procBytes += write(`proc/${id}.json`, p);
}
const meta = {
  name: 'WORLD',
  cycle: CYCLE,
  counts: { airports: aptArr.length, navaids: navaids.length, fixes: fixes.length, airways: Object.keys(airways).length, procAirports: procByApt.size },
  sources: [
    `FAA NASR ${faaAirports.meta.nasrCycleDate} / CIFP ${faaProcs.meta.cifpCycleDate} via @squawk data packages`,
    'OurAirports (public domain) for non-US airports and navaids',
  ],
  generated: new Date().toISOString(),
};
write('meta.json', meta);
console.log('Core bytes', total, 'procedure bytes', procBytes, 'proc airports', procByApt.size);
console.log(meta.counts);
