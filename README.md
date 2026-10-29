# CRJ700 FMS Simulator

A browser-based simulator of the Collins FMS-4200 control display unit (CDU) used in the Bombardier CRJ700, with a live flight simulation, Pro Line 4 style PFD and MFD, and a real navigation database.

## Features

- **CDU hardware** laid out like the CRJ700 unit: six line select keys per side, MSG, DIR INTC, FPLN, DEP ARR, HOLD, PREV/NEXT PAGE, INDEX, FIX, LEGS, SEC FPLN, VNAV, MCDU MENU, EXEC (with light), RADIO, PROG, PERF, MFD DATA/MENU/ADV, BRT/DIM, full alphanumeric keypad. 24 x 14 character color display with large/small fonts.
- **Pages**: STATUS, POS INIT, INDEX, FPLN, SEC FPLN, LEGS (with RTE DATA), DEP/ARR INDEX, DEPART, ARRIVAL, DIR-INTC, HOLD, FIX INFO, PROGRESS, PERF MENU, PERF INIT 1-3, VNAV CLIMB/CRUISE/DESCENT, TAKEOFF REF, APPROACH REF, PERF DATA, FUEL MGMT, FLT LOG, RADIO, VOR CTL, GPS STATUS, DATA BASE, PILOT WPT LIST, DEFINE PILOT WPT, ROUTE MENU, NEAREST APTS, CONVERSION, DEFAULTS, MFD MENU, MFD ADVANCE, MFD DATA, MESSAGES, SELECT WPT (duplicate identifiers), MCDU MENU, SIM CONTROL, SIM WEATHER.
- **Flight planning**: ACT/MOD/SEC plans with EXEC and CANCEL MOD; airways (including airway-to-airway intersections); SIDs, STARs and approaches with transitions and runway transitions; discontinuities; direct-to and intercept courses; holds (direct, teardrop and parallel entries); speed/altitude constraints; PBD, PB/PB, along-track and lat/lon waypoints; saved pilot routes.
- **Full ARINC 424 leg support**: IF, TF, CF, DF, FA, FC, FD, FM, CA, CD, CI, CR, RF, AF, VA, VD, VI, VM, VR, PI, HA, HF, HM.
- **Predictions**: TOC/TOD, geometric descent path honoring constraints, ETE/ETA and fuel at every waypoint, CRJ700 performance model, takeoff speeds (V1/VR/V2/VT), VREF/VAPP and field lengths.
- **Flight simulation**: LNAV with turn anticipation and fly-by arcs, VNAV (VFLCH, VPATH, VALT), ILS localizer/glideslope capture, autoland flare, go-around into the missed approach, sim rate up to 64x, winds and temperature.
- **Displays**: PFD (attitude, FD cue, speed tape with V-speed bugs and limits, altitude/VS tapes, FMA, HSI) and MFD (MAP/ROSE/PLAN, flight plan, holds, TOC/TOD, airports, navaids, fixes, FPL PROGRESS and NAV STATUS data).
- Works on phones (tabbed layout) and desktops; physical keyboard supported.

## Navigation data

- FAA NASR and CIFP (AIRAC cycle 2611, effective 29 Oct 2026) for US airports, runways, ILS, navaids, fixes, airways and every published SID, STAR and instrument approach, via the MIT-licensed `@squawk/*-data` packages.
- [OurAirports](https://ourairports.com/data/) (public domain) for airports and navaids outside the US.

Rebuild the database with:

```bash
scripts/fetch-ourairports.sh
npm run navdata
```

**For training and entertainment only. Not for real-world navigation.**

## Development

```bash
npm install
npm run dev        # local dev server
npm run typecheck
npm run build      # production build in dist/
npx tsx tests/flight.test.ts   # headless full flight KDEN -> KSLC
npx tsx tests/cdu.test.ts      # headless CDU key sequence
```

Deployed on Netlify (`netlify.toml` builds with `npm run build` and publishes `dist`).
