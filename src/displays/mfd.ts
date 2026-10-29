// Pro Line 4 style MFD navigation map.
import { fms } from '../fms/fms';
import { sim } from '../sim/sim';
import { navdb } from '../nav/navdb';
import { FlightPlan, legDisplayIdent, endsAtFix, isHold } from '../fms/flightplan';
import type { PathSeg } from '../fms/types';
import { LatLon, distance, destination, bearing, norm360, D2R } from '../util/geo';
import { trueToMag, magVar } from '../util/magvar';
import { fmtAlt, fmtCstrAlt, fmtDist, fmtEte, fmtZulu, fmtFuelK, fmtCrs, fmtTemp } from '../cdu/fmt';
import { fixInfo } from '../cdu/pages/dir';
import { pointOnSeg } from '../fms/predict';
import { tatC } from '../util/atmos';

export type MfdMode = 'MAP' | 'ROSE' | 'PLAN';
export const RANGES = [2.5, 5, 10, 25, 50, 100, 200, 300, 600];

const C = {
  white: '#f2f2f2',
  green: '#35f04a',
  cyan: '#38d9f5',
  magenta: '#ff4cf0',
  amber: '#ffb13b',
  gray: '#8a8f96',
  dim: '#5b6066',
};

export class MfdView {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  mode: MfdMode = 'MAP';
  range = 25;
  private W = 600;
  private H = 600;
  private dpr = 1;
  // projection state
  private c0: LatLon = { lat: 0, lon: 0 };
  private rot = 0; // display up direction (true)
  private cx = 300;
  private cy = 300;
  private scale = 1; // px per NM

  constructor(parent: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'mfd-canvas';
    parent.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    new ResizeObserver(() => this.resize()).observe(parent);
    this.resize();
  }

  private resize() {
    const r = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.W = Math.max(200, r.width);
    this.H = Math.max(200, r.height);
    this.canvas.width = Math.round(this.W * this.dpr);
    this.canvas.height = Math.round(this.H * this.dpr);
  }

  rangeUp() { const i = RANGES.indexOf(this.range); this.range = RANGES[Math.min(RANGES.length - 1, i + 1)]; }
  rangeDown() { const i = RANGES.indexOf(this.range); this.range = RANGES[Math.max(0, i - 1)]; }
  cycleMode() { this.mode = this.mode === 'MAP' ? 'ROSE' : this.mode === 'ROSE' ? 'PLAN' : 'MAP'; }

  private proj(p: LatLon): [number, number] {
    const dx = (p.lon - this.c0.lon) * Math.cos(this.c0.lat * D2R) * 60;
    const dy = (p.lat - this.c0.lat) * 60;
    const a = -this.rot * D2R;
    const x = dx * Math.cos(a) - dy * Math.sin(a);
    const y = dx * Math.sin(a) + dy * Math.cos(a);
    return [this.cx + x * this.scale, this.cy - y * this.scale];
  }

  draw() {
    const ctx = this.ctx;
    const W = this.W, H = this.H;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    const ac = sim.ac.s;
    const acPos = { lat: ac.lat, lon: ac.lon };
    const S = Math.min(W, H);
    const plan = fms.plan;
    const radius = this.mode === 'MAP' ? S * 0.62 : S * 0.4;
    this.scale = radius / this.range;
    if (this.mode === 'PLAN') {
      const leg = plan.legs[fms.mfd.planCenter];
      this.c0 = leg?.fix ?? plan.origin ?? acPos;
      this.rot = 0;
      this.cx = W / 2;
      this.cy = H / 2 + S * 0.02;
    } else {
      this.c0 = acPos;
      this.rot = ac.hdg;
      this.cx = W / 2;
      this.cy = this.mode === 'MAP' ? H * 0.5 + S * 0.3 : H / 2 + S * 0.02;
    }
    const fontPx = Math.max(10, S * 0.03);
    const font = (px = fontPx, bold = false) => `${bold ? '600 ' : ''}${px}px "B612 Mono", monospace`;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // ---- Clip region
    ctx.save();
    ctx.beginPath();
    if (this.mode === 'MAP') {
      ctx.rect(0, S * 0.08, W, H);
    } else {
      ctx.arc(this.cx, this.cy, radius + 2, 0, Math.PI * 2);
    }
    ctx.clip();
    this.drawOverlays(ctx, font, fontPx);
    // Fix info
    if (fixInfo.ref) this.drawFixInfo(ctx);
    // Flight plans
    if (fms.mfd.secFpln && fms.sec.legs.length) this.drawPlan(ctx, fms.sec, 'sec', font, fontPx);
    this.drawPlan(ctx, fms.active, 'act', font, fontPx);
    if (fms.mod) this.drawPlan(ctx, fms.mod, 'mod', font, fontPx);
    // Pseudo waypoints
    const pr = fms.pred;
    if (pr?.valid && fms.mfd.progress) {
      for (const pw of [pr.toc, pr.tod]) {
        if (!pw) continue;
        if (pw.kind === 'TOC' && fms.phase !== 'CLIMB' && fms.phase !== 'TAKEOFF' && fms.phase !== 'PREFLIGHT') continue;
        if (pw.kind === 'TOD' && (fms.phase === 'DESCENT' || fms.phase === 'APPROACH')) continue;
        const [x, y] = this.proj(pw.pos);
        ctx.strokeStyle = C.green;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, fontPx * 0.45, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = C.green;
        ctx.font = font(fontPx * 0.9);
        ctx.textAlign = 'left';
        ctx.fillText(pw.kind, x + fontPx * 0.7, y + fontPx * 0.35);
      }
    }
    ctx.restore();

    // ---- Compass
    if (this.mode !== 'PLAN') this.drawCompass(ctx, radius, font, fontPx);
    else this.drawPlanRose(ctx, radius, font, fontPx);

    // ---- Aircraft symbol
    {
      let x = this.cx, y = this.cy, hdg = 0;
      if (this.mode === 'PLAN') { [x, y] = this.proj(acPos); hdg = ac.hdg; }
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(hdg * D2R);
      const s = fontPx * 1.1;
      ctx.strokeStyle = C.white;
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.moveTo(0, -s);
      ctx.lineTo(0, s * 0.9);
      ctx.moveTo(-s * 0.8, -s * 0.1);
      ctx.lineTo(s * 0.8, -s * 0.1);
      ctx.moveTo(-s * 0.35, s * 0.8);
      ctx.lineTo(s * 0.35, s * 0.8);
      ctx.stroke();
      ctx.restore();
    }

    // ---- Data fields
    this.drawData(ctx, font, fontPx);
  }

  private drawOverlays(ctx: CanvasRenderingContext2D, font: (px?: number, b?: boolean) => string, fontPx: number) {
    const m = fms.mfd;
    const center = this.c0;
    const R = this.range * (this.mode === 'MAP' ? 1.25 : 1.1);
    ctx.font = font(fontPx * 0.78);
    ctx.textAlign = 'left';
    let budget = 260;
    if (m.apts) {
      const skip = new Set([fms.plan.origin?.ident, fms.plan.dest?.ident]);
      const apts = navdb.airportsNear(center, R).filter((a) => !skip.has(a.ident) && a.longest >= (this.range > 100 ? 7000 : this.range > 25 ? 5000 : 3000));
      for (const a of apts) {
        if (budget-- <= 0) break;
        const [x, y] = this.proj(a);
        if (this.range <= 10) {
          // runways
          ctx.strokeStyle = C.white;
          ctx.lineWidth = 3;
          for (const r of a.runways) {
            const far = destination({ lat: r.endLat, lon: r.endLon }, r.brg, r.length / 6076);
            const [x1, y1] = this.proj({ lat: r.endLat, lon: r.endLon });
            const [x2, y2] = this.proj(far);
            ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
          }
        }
        ctx.strokeStyle = C.cyan;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.arc(x, y, fontPx * 0.38, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = C.cyan;
        ctx.fillText(a.ident, x + fontPx * 0.5, y - fontPx * 0.35);
      }
    }
    if ((m.hiNav || m.loNav || m.ndbs) && this.range <= 300) {
      for (const n of navdb.navaidsNear(center, R)) {
        if (budget-- <= 0) break;
        if (n.kind === 'NDB' && !m.ndbs) continue;
        if (n.kind === 'VOR' && !(m.hiNav || m.loNav)) continue;
        if (n.kind === 'VOR' && !m.loNav && this.range < 50) continue;
        const [x, y] = this.proj(n);
        ctx.strokeStyle = C.cyan;
        ctx.lineWidth = 1.4;
        const s = fontPx * 0.42;
        ctx.beginPath();
        if (n.kind === 'NDB') {
          ctx.arc(x, y, s * 0.6, 0, Math.PI * 2);
          ctx.setLineDash([1.5, 2.5]);
          ctx.stroke();
          ctx.setLineDash([]);
        } else {
          for (let k = 0; k <= 6; k++) {
            const a = (k * 60 + 30) * D2R;
            const px = x + Math.cos(a) * s, py = y + Math.sin(a) * s;
            if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
          }
          ctx.stroke();
        }
        ctx.fillStyle = C.cyan;
        ctx.fillText(n.ident, x + fontPx * 0.5, y - fontPx * 0.3);
      }
    }
    if ((m.inters || m.termWpts) && this.range <= 50) {
      for (const f of navdb.fixesNear(center, R)) {
        if (budget-- <= 0) break;
        const [x, y] = this.proj(f);
        const s = fontPx * 0.36;
        ctx.strokeStyle = C.cyan;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(x, y - s); ctx.lineTo(x + s * 0.87, y + s * 0.5); ctx.lineTo(x - s * 0.87, y + s * 0.5); ctx.closePath();
        ctx.stroke();
        ctx.fillStyle = C.cyan;
        ctx.fillText(f.ident, x + fontPx * 0.45, y - fontPx * 0.3);
      }
    }
  }

  private segPoints(s: PathSeg): LatLon[] {
    if (s.type === 'line') {
      const d = distance(s.a, s.b);
      const n = Math.max(1, Math.min(40, Math.ceil(d / 25)));
      if (n === 1) return [s.a, s.b];
      const brg = bearing(s.a, s.b);
      const pts: LatLon[] = [];
      for (let i = 0; i <= n; i++) pts.push(destination(s.a, brg, (d * i) / n));
      return pts;
    }
    const n = Math.max(4, Math.ceil(Math.abs(s.sweep) / 5));
    const len = (Math.abs(s.sweep) * D2R) * s.r;
    const pts: LatLon[] = [];
    for (let i = 0; i <= n; i++) pts.push(pointOnSeg(s, (len * i) / n));
    return pts;
  }

  private strokeSegs(ctx: CanvasRenderingContext2D, segs: PathSeg[]) {
    ctx.beginPath();
    for (const s of segs) {
      const pts = this.segPoints(s);
      pts.forEach((p, i) => {
        const [x, y] = this.proj(p);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
    }
    ctx.stroke();
  }

  private drawPlan(ctx: CanvasRenderingContext2D, plan: FlightPlan, kind: 'act' | 'mod' | 'sec', font: (px?: number) => string, fontPx: number) {
    const start = kind === 'sec' ? 1 : Math.max(1, plan.activeIdx);
    const missed = fms.mfd.missedAppr;
    const ta = fms.perf.transAlt;
    // legs
    for (let i = start; i < plan.legs.length; i++) {
      const l = plan.legs[i];
      if (!l.geo) continue;
      if (l.seg === 'MAP' && !missed && !plan.missedActive) continue;
      const active = kind !== 'sec' && i === plan.activeIdx && !(fms.ac.onGround && kind === 'act' && false);
      let color = C.white;
      if (l.seg === 'MAP' && !plan.missedActive) color = C.cyan;
      if (active) color = C.magenta;
      if (kind === 'sec') color = C.cyan;
      ctx.strokeStyle = color;
      ctx.lineWidth = active ? 2.6 : 2;
      ctx.setLineDash(kind === 'mod' || kind === 'sec' ? [8, 6] : []);
      let segs = l.geo.segs;
      if (active && kind === 'act' && !fms.ac.onGround && segs.length && l.pt !== 'DF') {
        // active leg drawn from the aircraft position abeam point onward
        segs = l.geo.segs;
      }
      if (active && kind === 'act' && l.pt === 'DF' && !l.ppos && !fms.ac.onGround && l.fix) {
        segs = [{ type: 'line', a: { lat: sim.ac.s.lat, lon: sim.ac.s.lon }, b: l.fix }];
      }
      this.strokeSegs(ctx, segs);
      if (l.geo.holdTrack) {
        ctx.strokeStyle = active ? C.magenta : kind === 'sec' ? C.cyan : l.seg === 'MAP' ? C.cyan : C.white;
        this.strokeSegs(ctx, l.geo.holdTrack);
      }
      ctx.setLineDash([]);
    }
    // waypoints
    ctx.font = font(fontPx * 0.85);
    ctx.textAlign = 'left';
    for (let i = start; i < plan.legs.length; i++) {
      const l = plan.legs[i];
      if (!l.geo || !l.fix || !(endsAtFix(l) || l.pt === 'IF')) continue;
      if (l.seg === 'MAP' && !missed && !plan.missedActive) continue;
      if (isHold(l) && plan.legs[i - 1]?.fix?.ident === l.fix.ident) continue;
      const [x, y] = this.proj(l.fix);
      if (x < -50 || y < -50 || x > this.W + 50 || y > this.H + 50) continue;
      const active = kind !== 'sec' && i === plan.activeIdx;
      const col = active ? C.magenta : kind === 'sec' ? C.cyan : l.seg === 'MAP' && !plan.missedActive ? C.cyan : C.white;
      if (l.fix.kind === 'RWY') {
        ctx.fillStyle = col;
        ctx.fillText(l.fix.ident, x + fontPx * 0.6, y + fontPx * 0.3);
        continue;
      }
      this.star(ctx, x, y, fontPx * 0.55, col);
      ctx.fillStyle = col;
      ctx.fillText(legDisplayIdent(l), x + fontPx * 0.6, y - fontPx * 0.25);
      if (l.alt && kind !== 'sec' && this.range <= 100) {
        ctx.fillStyle = C.cyan;
        ctx.font = font(fontPx * 0.7);
        ctx.fillText(fmtCstrAlt(l.alt, ta), x + fontPx * 0.6, y + fontPx * 0.7);
        ctx.font = font(fontPx * 0.85);
      }
    }
    // origin / destination airports
    for (const a of [plan.origin, plan.dest]) {
      if (!a || kind === 'sec') continue;
      const [x, y] = this.proj(a);
      if (this.range <= 10) {
        ctx.strokeStyle = C.white;
        ctx.lineWidth = 3;
        for (const r of a.runways) {
          const far = destination({ lat: r.endLat, lon: r.endLon }, r.brg, r.length / 6076);
          const [x1, y1] = this.proj({ lat: r.endLat, lon: r.endLon });
          const [x2, y2] = this.proj(far);
          ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
        }
      }
      ctx.strokeStyle = C.white;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.arc(x, y, fontPx * 0.45, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = C.white;
      ctx.fillText(a.ident, x + fontPx * 0.6, y + fontPx * 1.1);
    }
  }

  private star(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, col: string) {
    ctx.fillStyle = col;
    ctx.beginPath();
    for (let k = 0; k < 8; k++) {
      const r = k % 2 === 0 ? s : s * 0.28;
      const a = (k * 45) * D2R;
      const px = x + Math.sin(a) * r, py = y - Math.cos(a) * r;
      if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill();
  }

  private drawFixInfo(ctx: CanvasRenderingContext2D) {
    const f = fixInfo;
    if (!f.ref) return;
    const [x, y] = this.proj(f.ref);
    ctx.strokeStyle = C.cyan;
    ctx.lineWidth = 1.2;
    ctx.setLineDash([4, 5]);
    if (f.dist) {
      ctx.beginPath();
      ctx.arc(x, y, f.dist * this.scale, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (f.radial != null) {
      const dec = f.ref.kind === 'VOR' && f.ref.dec != null ? f.ref.dec : magVar(f.ref.lat, f.ref.lon);
      const end = destination(f.ref, norm360(f.radial + dec), Math.max(this.range * 2, 60));
      const [x2, y2] = this.proj(end);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  private drawCompass(ctx: CanvasRenderingContext2D, radius: number, font: (px?: number, b?: boolean) => string, fontPx: number) {
    const ac = sim.ac.s;
    const hdgMag = trueToMag(ac.hdg, ac.lat, ac.lon);
    const cx = this.cx, cy = this.cy;
    ctx.strokeStyle = C.white;
    ctx.fillStyle = C.white;
    ctx.lineWidth = 1.6;
    const full = this.mode === 'ROSE';
    const span = full ? 180 : 52;
    // arc
    ctx.beginPath();
    const a0 = (-90 - span) * D2R, a1 = (-90 + span) * D2R;
    ctx.arc(cx, cy, radius, full ? 0 : a0, full ? Math.PI * 2 : a1);
    ctx.stroke();
    // ticks
    ctx.font = font(fontPx * 0.95);
    ctx.textAlign = 'center';
    const start = Math.ceil((hdgMag - span) / 5) * 5;
    for (let d = start; d <= hdgMag + span; d += 5) {
      const rel = (d - hdgMag) * D2R;
      const ang = rel - Math.PI / 2;
      const big = d % 10 === 0;
      const r1 = radius, r2 = radius - (big ? fontPx * 0.7 : fontPx * 0.4);
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(ang) * r1, cy + Math.sin(ang) * r1);
      ctx.lineTo(cx + Math.cos(ang) * r2, cy + Math.sin(ang) * r2);
      ctx.stroke();
      if (d % 30 === 0) {
        const lbl = String((((Math.round(d) % 360) + 360) % 360) / 10).replace(/^0$/, 'N').replace(/^9$/, 'E').replace(/^18$/, 'S').replace(/^27$/, 'W');
        const rl = radius - fontPx * 1.5;
        ctx.save();
        ctx.translate(cx + Math.cos(ang) * rl, cy + Math.sin(ang) * rl);
        ctx.rotate(rel);
        ctx.fillText(lbl, 0, fontPx * 0.35);
        ctx.restore();
      }
    }
    // half-range ring
    if (fms.mfd.rangeRings) {
      ctx.setLineDash([3, 7]);
      ctx.strokeStyle = C.dim;
      ctx.beginPath();
      ctx.arc(cx, cy, radius / 2, full ? 0 : a0, full ? Math.PI * 2 : a1);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = C.gray;
      ctx.font = font(fontPx * 0.8);
      ctx.textAlign = 'right';
      const ra = (-90 - span * 0.85) * D2R;
      ctx.fillText(String(this.range / 2), cx + Math.cos(ra) * radius / 2 - 4, cy + Math.sin(ra) * radius / 2);
    }
    // heading bug (cyan)
    const bug = (sim.ac.fcp.hdgSel - hdgMag) * D2R - Math.PI / 2;
    ctx.save();
    ctx.translate(cx + Math.cos(bug) * radius, cy + Math.sin(bug) * radius);
    ctx.rotate(bug + Math.PI / 2);
    ctx.strokeStyle = C.cyan;
    ctx.lineWidth = 2;
    const b = fontPx * 0.45;
    ctx.beginPath();
    ctx.moveTo(-b, 0); ctx.lineTo(-b, -b * 0.9); ctx.lineTo(-b * 0.4, -b * 0.9); ctx.lineTo(0, -b * 0.2); ctx.lineTo(b * 0.4, -b * 0.9); ctx.lineTo(b, -b * 0.9); ctx.lineTo(b, 0);
    ctx.stroke();
    ctx.restore();
    // track pointer (green diamond)
    const trk = (trueToMag(ac.trk, ac.lat, ac.lon) - hdgMag) * D2R - Math.PI / 2;
    if (ac.gs > 30) {
      ctx.save();
      ctx.translate(cx + Math.cos(trk) * (radius - 4), cy + Math.sin(trk) * (radius - 4));
      ctx.rotate(trk + Math.PI / 2);
      ctx.fillStyle = C.green;
      ctx.beginPath();
      ctx.moveTo(0, -5); ctx.lineTo(4, 0); ctx.lineTo(0, 5); ctx.lineTo(-4, 0); ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
    // lubber + heading readout
    const top = cy - radius;
    ctx.fillStyle = '#000';
    ctx.strokeStyle = C.white;
    ctx.lineWidth = 1.6;
    const bw = fontPx * 3.1, bh = fontPx * 1.5;
    ctx.beginPath();
    ctx.rect(cx - bw / 2, top - bh - fontPx * 0.4, bw, bh);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = C.green;
    ctx.font = font(fontPx * 1.15, true);
    ctx.textAlign = 'center';
    ctx.fillText(String(Math.round(hdgMag) % 360 || 360).padStart(3, '0'), cx, top - fontPx * 0.75);
    ctx.fillStyle = C.white;
    ctx.beginPath();
    ctx.moveTo(cx, top + 2); ctx.lineTo(cx - 6, top - fontPx * 0.4 + 1); ctx.lineTo(cx + 6, top - fontPx * 0.4 + 1); ctx.closePath();
    ctx.fill();
  }

  private drawPlanRose(ctx: CanvasRenderingContext2D, radius: number, font: (px?: number) => string, fontPx: number) {
    const cx = this.cx, cy = this.cy;
    ctx.strokeStyle = C.white;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([3, 7]);
    ctx.strokeStyle = C.dim;
    ctx.beginPath();
    ctx.arc(cx, cy, radius / 2, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = C.white;
    ctx.font = font(fontPx);
    ctx.textAlign = 'center';
    const lbl: [string, number][] = [['N', 0], ['E', 90], ['S', 180], ['W', 270]];
    for (const [t, a] of lbl) {
      const r = a * D2R - Math.PI / 2;
      ctx.fillText(t, cx + Math.cos(r) * (radius + fontPx * 0.9), cy + Math.sin(r) * (radius + fontPx * 0.9) + fontPx * 0.35);
    }
    ctx.fillStyle = C.gray;
    ctx.font = font(fontPx * 0.8);
    ctx.fillText(String(this.range / 2), cx + radius / 2 * 0.72, cy - radius / 2 * 0.72);
  }

  private drawData(ctx: CanvasRenderingContext2D, font: (px?: number, b?: boolean) => string, fontPx: number) {
    const ac = sim.ac.s;
    const W = this.W, H = this.H;
    const pad = fontPx * 0.5;
    const lh = fontPx * 1.25;
    ctx.textAlign = 'left';
    ctx.font = font(fontPx * 0.9);
    // top left: GS / TAS
    ctx.fillStyle = C.white;
    ctx.fillText('GS', pad, pad + lh * 0.8);
    ctx.fillStyle = C.green;
    ctx.fillText(String(Math.round(ac.gs)).padStart(3), pad + fontPx * 1.8, pad + lh * 0.8);
    ctx.fillStyle = C.white;
    ctx.fillText('TAS', pad, pad + lh * 1.8);
    ctx.fillStyle = C.green;
    ctx.fillText(String(Math.round(ac.tas)).padStart(3), pad + fontPx * 2.4, pad + lh * 1.8);
    // wind
    const w = fms.windNow;
    if (w.spd >= 2 && !ac.onGround) {
      const rel = (w.dir + 180 - (this.mode === 'PLAN' ? 0 : ac.hdg)) * D2R;
      const ax = pad + fontPx * 1.2, ay = pad + lh * 3.6;
      ctx.save();
      ctx.translate(ax, ay);
      ctx.rotate(rel);
      ctx.strokeStyle = C.green;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, fontPx * 0.9); ctx.lineTo(0, -fontPx * 0.9);
      ctx.moveTo(-fontPx * 0.4, -fontPx * 0.4); ctx.lineTo(0, -fontPx * 0.9); ctx.lineTo(fontPx * 0.4, -fontPx * 0.4);
      ctx.stroke();
      ctx.restore();
      ctx.fillStyle = C.green;
      const wm = Math.round(trueToMag(w.dir, ac.lat, ac.lon)) % 360 || 360;
      ctx.fillText(`${String(wm).padStart(3, '0')}°/${Math.round(w.spd)}`, pad + fontPx * 2.4, pad + lh * 3.8);
    }
    // top right: active waypoint
    const plan = fms.active;
    const leg = plan.legs[plan.activeIdx];
    const ln = fms.guidance.lnav;
    ctx.textAlign = 'right';
    if (leg && fms.posInit) {
      ctx.fillStyle = C.magenta;
      ctx.font = font(fontPx * 1.05);
      const id = leg.pt === 'DISCO' ? '' : legDisplayIdent(leg);
      ctx.fillText(id, W - pad, pad + lh * 0.8);
      ctx.font = font(fontPx * 0.9);
      if (ln.valid && leg.pt !== 'DISCO') {
        ctx.fillStyle = C.white;
        ctx.fillText(`${fmtDist(ln.dtg)} NM`, W - pad, pad + lh * 1.8);
        if (ac.gs > 50) ctx.fillText(fmtEte((ln.dtg / ac.gs) * 3600), W - pad, pad + lh * 2.8);
      }
    }
    ctx.fillStyle = C.magenta;
    ctx.font = font(fontPx * 0.85);
    ctx.fillText('FMS1', W - pad, pad + lh * 3.9);
    // bottom left: mode / range
    ctx.textAlign = 'left';
    ctx.fillStyle = C.cyan;
    ctx.font = font(fontPx * 0.85);
    const bottomY = H - pad;
    ctx.fillText(`${this.mode}  ${this.range} NM`, pad, bottomY);
    if (fms.isMod) {
      ctx.fillStyle = C.white;
      ctx.textAlign = 'right';
      ctx.fillText('MOD FPLN', W - pad, bottomY);
    }
    if (fms.mfd.dataPage !== 'NONE') this.drawDataPage(ctx, font, fontPx);
    if (!fms.posInit) {
      ctx.textAlign = 'center';
      ctx.fillStyle = C.amber;
      ctx.font = font(fontPx * 1.1);
      ctx.fillText('FMS POSITION NOT INITIALIZED', W / 2, H * 0.45);
    }
  }

  private drawDataPage(ctx: CanvasRenderingContext2D, font: (px?: number, b?: boolean) => string, fontPx: number) {
    const W = this.W, H = this.H;
    const lines: { t: string; c: string }[][] = [];
    const ac = sim.ac.s;
    const page = fms.mfd.dataPage;
    if (page === 'FPL PROG' || page === 'FPL DATA') {
      lines.push([{ t: page === 'FPL PROG' ? 'FPL PROGRESS' : 'FPL DATA', c: C.white }]);
      lines.push([{ t: 'WPT     DTG   ETA   FUEL  ALT', c: C.white }]);
      const plan = fms.active;
      let k = 0;
      for (let i = Math.max(1, plan.activeIdx); i < plan.legs.length && k < 4; i++) {
        const l = plan.legs[i];
        if (l.pt === 'DISCO' || !l.pred || !l.fix || l.seg === 'MAP') continue;
        const dtg = i === plan.activeIdx && fms.guidance.lnav.valid ? fms.guidance.lnav.dtg : l.pred.dist;
        const t = `${legDisplayIdent(l).padEnd(7).slice(0, 7)} ${fmtDist(dtg).padStart(5)} ${fmtZulu(fms.eta(l.pred.ete))}Z ${fmtFuelK(l.pred.fuel).padStart(4)} ${fmtAlt(l.pred.alt, fms.perf.transAlt).padStart(5)}`;
        lines.push([{ t, c: i === plan.activeIdx ? C.magenta : C.green }]);
        k++;
      }
      if (plan.dest && fms.pred?.valid) {
        lines.push([{ t: `${plan.dest.ident.padEnd(7)} ${fmtDist(fms.pred.destDist).padStart(5)} ${fmtZulu(fms.eta(fms.pred.destEte))}Z ${fmtFuelK(fms.pred.destFuel).padStart(4)}`, c: C.green }]);
      }
    } else {
      const ln = fms.guidance.lnav;
      lines.push([{ t: 'NAV STATUS', c: C.white }]);
      lines.push([{ t: 'XTK ', c: C.white }, { t: ln.valid ? `${Math.abs(ln.xtk).toFixed(2)}${ln.xtk >= 0 ? 'R' : 'L'}` : '----', c: C.green }, { t: '   DTK ', c: C.white }, { t: ln.valid ? fmtCrs(trueToMag(ln.dtk, ac.lat, ac.lon)) : '---', c: C.green }]);
      lines.push([{ t: 'MACH ', c: C.white }, { t: ac.mach.toFixed(3).slice(1), c: C.green }, { t: '   SAT ', c: C.white }, { t: fmtTemp(fms.satC), c: C.green }, { t: ' TAT ', c: C.white }, { t: fmtTemp(tatC(fms.satC, ac.mach)), c: C.green }]);
      lines.push([{ t: 'SENSOR ', c: C.white }, { t: 'GPS1 GPS2 DME/DME', c: C.green }]);
      lines.push([{ t: 'RNP ', c: C.white }, { t: ln.approach ? '0.30' : '2.00', c: C.green }, { t: '  ANP ', c: C.white }, { t: '0.03', c: C.green }]);
    }
    const lh = fontPx * 1.2;
    const h = lines.length * lh + fontPx * 0.8;
    const y0 = H - h - fontPx * 1.6;
    ctx.fillStyle = 'rgba(0,0,0,0.85)';
    ctx.fillRect(4, y0, W - 8, h);
    ctx.strokeStyle = C.dim;
    ctx.strokeRect(4, y0, W - 8, h);
    ctx.font = font(fontPx * 0.85);
    ctx.textAlign = 'left';
    lines.forEach((parts, i) => {
      let x = fontPx * 0.6;
      for (const p of parts) {
        ctx.fillStyle = p.c;
        ctx.fillText(p.t, x, y0 + lh * (i + 1));
        x += ctx.measureText(p.t).width;
      }
    });
  }
}
