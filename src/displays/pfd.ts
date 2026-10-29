// Pro Line 4 style PFD.
import { fms } from '../fms/fms';
import { sim } from '../sim/sim';
import { trueToMag } from '../util/magvar';
import { D2R, angDiff, clamp } from '../util/geo';
import { fmtDist } from '../cdu/fmt';
import { vref } from '../fms/perf';
import { CRJ700 } from '../fms/perf';
import { machToCas } from '../util/atmos';
import { legDisplayIdent } from '../fms/flightplan';

const C = {
  white: '#f2f2f2', green: '#35f04a', cyan: '#38d9f5', magenta: '#ff4cf0', amber: '#ffb13b', red: '#ff3434',
  sky: '#1f6fd6', ground: '#8a5a2b', tape: '#3a3f45', gray: '#9aa0a6', yellow: '#ffe74a', black: '#000', dim: '#555',
};

export class PfdView {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  private W = 500;
  private H = 560;
  private dpr = 1;

  constructor(parent: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'pfd-canvas';
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

  draw() {
    const ctx = this.ctx;
    const W = this.W, H = this.H;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    const S = Math.min(W, H / 1.12);
    const fs = Math.max(10, S * 0.034);
    const font = (k = 1, b = false) => `${b ? '600 ' : ''}${fs * k}px "B612 Mono", monospace`;
    const ox = (W - S) / 2;
    const s = sim.ac.s;
    const f = sim.ac.fcp;

    // Geometry
    const adiCx = ox + S * 0.5, adiCy = H * 0.33;
    const adiW = S * 0.46, adiH = H * 0.4;
    const pxPerDeg = adiH / 40;

    // ---------------- ADI
    ctx.save();
    ctx.beginPath();
    roundRect(ctx, adiCx - adiW / 2, adiCy - adiH / 2, adiW, adiH, S * 0.03);
    ctx.clip();
    ctx.translate(adiCx, adiCy);
    ctx.rotate(-s.bank * D2R);
    const pOff = s.pitch * pxPerDeg;
    ctx.fillStyle = C.sky;
    ctx.fillRect(-adiW * 2, -adiH * 3 + pOff, adiW * 4, adiH * 3);
    ctx.fillStyle = C.ground;
    ctx.fillRect(-adiW * 2, pOff, adiW * 4, adiH * 3);
    ctx.strokeStyle = C.white;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-adiW * 2, pOff); ctx.lineTo(adiW * 2, pOff);
    ctx.stroke();
    // Pitch ladder
    ctx.lineWidth = 1.5;
    ctx.fillStyle = C.white;
    ctx.font = font(0.75);
    ctx.textAlign = 'center';
    for (let p = -30; p <= 30; p += 2.5) {
      if (p === 0) continue;
      const y = pOff - p * pxPerDeg;
      if (Math.abs(y) > adiH * 0.48) continue;
      const major = p % 10 === 0, mid = p % 5 === 0;
      const w = major ? adiW * 0.22 : mid ? adiW * 0.12 : adiW * 0.06;
      ctx.beginPath();
      ctx.moveTo(-w, y); ctx.lineTo(w, y);
      ctx.stroke();
      if (major) {
        ctx.fillText(String(Math.abs(p)), -w - fs * 0.9, y + fs * 0.28);
        ctx.fillText(String(Math.abs(p)), w + fs * 0.9, y + fs * 0.28);
      }
    }
    ctx.restore();
    // Bank scale
    ctx.save();
    ctx.translate(adiCx, adiCy);
    const br = adiH * 0.44;
    ctx.strokeStyle = C.white;
    ctx.fillStyle = C.white;
    ctx.lineWidth = 1.6;
    for (const a of [-60, -45, -30, -20, -10, 10, 20, 30, 45, 60]) {
      const r = (a - 90) * D2R;
      const len = Math.abs(a) % 30 === 0 ? fs * 0.8 : fs * 0.45;
      ctx.beginPath();
      ctx.moveTo(Math.cos(r) * br, Math.sin(r) * br);
      ctx.lineTo(Math.cos(r) * (br + len), Math.sin(r) * (br + len));
      ctx.stroke();
    }
    tri(ctx, 0, -br, fs * 0.5, false, C.white);
    ctx.rotate(-s.bank * D2R);
    tri(ctx, 0, -br, fs * 0.5, true, Math.abs(s.bank) > 35 ? C.amber : C.white);
    ctx.restore();
    // Flight director (magenta V-bar) and aircraft symbol
    if (f.fd && !s.onGround || f.vert === 'TO') {
      ctx.save();
      ctx.translate(adiCx, adiCy);
      const fdBank = s.fdBank;
      const fdPitch = s.fdPitch;
      ctx.rotate(-(fdBank - s.bank) * D2R * 0.6);
      const dy = -(fdPitch - s.pitch) * pxPerDeg;
      ctx.strokeStyle = C.magenta;
      ctx.lineWidth = 3;
      const vw = adiW * 0.3;
      ctx.beginPath();
      ctx.moveTo(-vw, dy + vw * 0.32); ctx.lineTo(0, dy); ctx.lineTo(vw, dy + vw * 0.32);
      ctx.stroke();
      ctx.restore();
    }
    ctx.save();
    ctx.translate(adiCx, adiCy);
    ctx.fillStyle = C.black;
    ctx.strokeStyle = C.yellow;
    ctx.lineWidth = 2;
    const aw = adiW * 0.32;
    ctx.beginPath();
    ctx.moveTo(-aw, aw * 0.35); ctx.lineTo(0, 0); ctx.lineTo(aw, aw * 0.35); ctx.lineTo(aw * 0.8, aw * 0.4); ctx.lineTo(0, aw * 0.12); ctx.lineTo(-aw * 0.8, aw * 0.4); ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.restore();

    // Radio altitude
    if (s.radioAlt < 2500 && !s.onGround && s.groundElev > -500) {
      ctx.fillStyle = C.green;
      ctx.font = font(1.1, true);
      ctx.textAlign = 'center';
      ctx.fillText(String(Math.round(s.radioAlt / 10) * 10), adiCx, adiCy + adiH / 2 - fs * 0.6);
    }

    // Localizer / glideslope / VNAV deviation
    const ils = sim.ils;
    const ln = fms.guidance.lnav;
    if (ils && ils.locValid) {
      const dx = clamp(ils.locDev / 2.5, -1.2, 1.2) * adiW * 0.35;
      const y = adiCy + adiH / 2 + fs * 0.9;
      dots(ctx, adiCx, y, adiW * 0.35, true);
      diamond(ctx, adiCx - dx, y, fs * 0.5, C.green);
    }
    const vdiX = adiCx + adiW / 2 + fs * 0.9;
    if (ils && ils.gsValid) {
      dots(ctx, vdiX, adiCy, adiH * 0.3, false);
      const dy = clamp(ils.gsDev / 0.7, -1.2, 1.2) * adiH * 0.3;
      diamond(ctx, vdiX, adiCy + dy, fs * 0.5, C.green);
    } else if (fms.guidance.vnav.vdev != null && (fms.phase === 'DESCENT' || fms.phase === 'APPROACH' || (fms.guidance.vnav.todDist ?? 99) < 10)) {
      dots(ctx, vdiX, adiCy, adiH * 0.3, false);
      const dy = clamp(fms.guidance.vnav.vdev / 500, -1.2, 1.2) * adiH * 0.3;
      diamond(ctx, vdiX, adiCy + dy, fs * 0.5, C.magenta);
    }

    // ---------------- Speed tape
    const stX = ox + S * 0.06, stW = S * 0.15, stY = adiCy - adiH * 0.55, stH = adiH * 1.1;
    const ktPx = stH / 90;
    ctx.save();
    ctx.beginPath();
    ctx.rect(stX, stY, stW, stH);
    ctx.clip();
    ctx.fillStyle = C.tape;
    ctx.fillRect(stX, stY, stW, stH);
    const mid = stY + stH / 2;
    const ias = Math.max(30, s.ias);
    ctx.strokeStyle = C.white;
    ctx.fillStyle = C.white;
    ctx.font = font(0.85);
    ctx.textAlign = 'right';
    ctx.lineWidth = 1.5;
    for (let v = Math.floor((ias - 50) / 5) * 5; v <= ias + 50; v += 5) {
      if (v < 30) continue;
      const y = mid - (v - ias) * ktPx;
      ctx.beginPath();
      ctx.moveTo(stX + stW, y);
      ctx.lineTo(stX + stW - (v % 10 === 0 ? fs * 0.6 : fs * 0.35), y);
      ctx.stroke();
      if (v % 20 === 0) ctx.fillText(String(v), stX + stW - fs * 0.8, y + fs * 0.3);
    }
    // Overspeed barber pole and low speed band
    const vmo = Math.min(CRJ700.vmo, machToCas(CRJ700.mmo, s.alt), CRJ700.vfe[s.flaps] ?? 335, s.gearPos > 0.1 ? CRJ700.vle : 999);
    barber(ctx, stX + stW - fs * 0.35, mid - (vmo - ias) * ktPx, fs * 0.35, -stH, C.red);
    const vs1 = vref(sim.ac.gw, 45) / 1.23;
    const flapF: Record<number, number> = { 45: 1, 30: 1.03, 20: 1.08, 8: 1.14, 1: 1.2, 0: 1.32 };
    const vStall = vs1 * (flapF[s.flaps] ?? 1.32);
    if (!s.onGround) {
      barber(ctx, stX + stW - fs * 0.35, mid - (vStall - ias) * ktPx, fs * 0.35, stH, C.red);
      ctx.fillStyle = C.amber;
      const yA = mid - (vStall * 1.13 - ias) * ktPx, yB = mid - (vStall - ias) * ktPx;
      ctx.fillRect(stX + stW - fs * 0.2, yA, fs * 0.2, yB - yA);
    }
    // V-speed bugs
    const t = fms.perf.takeoff;
    const bugs: [number | null, string][] = [];
    if (s.onGround && s.phase !== 'ROLLOUT' || (fms.phase === 'TAKEOFF' || fms.phase === 'CLIMB') && s.alt - (fms.active.origin?.elev ?? 0) < 3000) {
      bugs.push([t.v1, '1'], [t.vr, 'R'], [t.v2, '2'], [t.vt, 'T']);
    } else if (fms.phase === 'APPROACH' || fms.phase === 'DESCENT') {
      const a = fms.approachSpeeds(fms.perf);
      bugs.push([a.vref, 'RF'], [a.vapp, 'AP']);
    }
    ctx.font = font(0.75, true);
    ctx.textAlign = 'left';
    for (const [v, l] of bugs) {
      if (v == null) continue;
      const y = mid - (v - ias) * ktPx;
      ctx.strokeStyle = C.cyan;
      ctx.fillStyle = C.cyan;
      ctx.beginPath();
      ctx.moveTo(stX + stW, y); ctx.lineTo(stX + stW + fs * 0.4, y);
      ctx.stroke();
    }
    ctx.restore();
    for (const [v, l] of bugs) {
      if (v == null) continue;
      const y = mid - (v - ias) * ktPx;
      if (y < stY || y > stY + stH) continue;
      ctx.fillStyle = C.cyan;
      ctx.font = font(0.75, true);
      ctx.textAlign = 'left';
      ctx.fillText(l, stX + stW + fs * 0.45, y + fs * 0.28);
    }
    // Selected speed bug
    const tgt = s.tgtIas;
    if (tgt && !s.onGround) {
      const y = clamp(mid - (tgt - ias) * ktPx, stY, stY + stH);
      ctx.fillStyle = C.cyan;
      ctx.beginPath();
      ctx.moveTo(stX + stW, y); ctx.lineTo(stX + stW + fs * 0.5, y - fs * 0.45); ctx.lineTo(stX + stW + fs * 0.5, y + fs * 0.45); ctx.closePath();
      ctx.fill();
    }
    // Speed trend (10 s)
    // Current speed box
    ctx.fillStyle = C.black;
    ctx.strokeStyle = C.white;
    ctx.lineWidth = 1.6;
    const bxH = fs * 1.7;
    ctx.beginPath();
    ctx.rect(stX + fs * 0.1, mid - bxH / 2, stW - fs * 0.1, bxH);
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = s.ias > vmo + 2 ? C.red : C.white;
    ctx.font = font(1.25, true);
    ctx.textAlign = 'right';
    ctx.fillText(s.ias < 30 ? '---' : String(Math.round(s.ias)), stX + stW - fs * 0.25, mid + fs * 0.45);
    // Speed target readout above tape
    ctx.font = font(0.95);
    ctx.fillStyle = C.cyan;
    ctx.textAlign = 'center';
    const tgtText = f.vnav && !s.onGround ? (s.useMach ? `M.${Math.round(s.tgtMach * 100)}` : String(s.tgtIas)) : f.spdMach ? `M.${Math.round(f.machSel * 100)}` : String(f.spdSel);
    ctx.fillText(tgtText, stX + stW / 2, stY - fs * 0.5);
    if (f.vnav) { ctx.fillStyle = C.magenta; ctx.font = font(0.7); ctx.fillText('FMS', stX + stW / 2, stY - fs * 1.6); }
    // Mach
    if (s.mach >= 0.4) {
      ctx.fillStyle = C.green;
      ctx.font = font(1);
      ctx.fillText(`M.${Math.round(s.mach * 1000).toString().padStart(3, '0')}`, stX + stW / 2, stY + stH + fs * 1.3);
    }

    // ---------------- Altitude tape
    const atX = ox + S * 0.77, atW = S * 0.15, atY = stY, atH = stH;
    const ftPx = atH / 900;
    ctx.save();
    ctx.beginPath();
    ctx.rect(atX, atY, atW, atH);
    ctx.clip();
    ctx.fillStyle = C.tape;
    ctx.fillRect(atX, atY, atW, atH);
    const amid = atY + atH / 2;
    ctx.strokeStyle = C.white;
    ctx.fillStyle = C.white;
    ctx.font = font(0.8);
    ctx.textAlign = 'left';
    for (let a = Math.floor((s.alt - 500) / 100) * 100; a <= s.alt + 500; a += 100) {
      const y = amid - (a - s.alt) * ftPx;
      ctx.beginPath();
      ctx.moveTo(atX, y);
      ctx.lineTo(atX + (a % 500 === 0 ? fs * 0.6 : fs * 0.35), y);
      ctx.stroke();
      if (a % 500 === 0) ctx.fillText(String(a), atX + fs * 0.75, y + fs * 0.3);
    }
    // ground
    if (s.groundElev > -500) {
      const gy = amid - (s.groundElev - s.alt) * ftPx;
      ctx.fillStyle = 'rgba(140,90,43,0.85)';
      ctx.fillRect(atX, gy, atW, atH);
    }
    // altitude bug
    const ay = clamp(amid - (f.altSel - s.alt) * ftPx, atY, atY + atH);
    ctx.fillStyle = C.cyan;
    ctx.fillRect(atX, ay - fs * 0.5, fs * 0.35, fs);
    ctx.restore();
    ctx.fillStyle = C.black;
    ctx.strokeStyle = C.white;
    ctx.beginPath();
    ctx.rect(atX, amid - bxH / 2, atW + fs * 0.3, bxH);
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = C.white;
    ctx.font = font(1.15, true);
    ctx.textAlign = 'right';
    ctx.fillText(String(Math.round(s.alt / 10) * 10), atX + atW + fs * 0.2, amid + fs * 0.42);
    ctx.fillStyle = C.cyan;
    ctx.font = font(1);
    ctx.textAlign = 'center';
    ctx.fillText(String(f.altSel), atX + atW / 2, atY - fs * 0.5);
    ctx.font = font(0.85);
    ctx.fillText(`${sim.env.qnh.toFixed(2)} IN`, atX + atW / 2, atY + atH + fs * 1.3);
    // VS scale
    const vsX = atX + atW + fs * 0.6;
    ctx.strokeStyle = C.gray;
    ctx.lineWidth = 1.2;
    const vsH = atH * 0.42;
    for (const v of [-4000, -2000, -1000, 0, 1000, 2000, 4000]) {
      const y = amid - vsScale(v) * vsH;
      ctx.beginPath();
      ctx.moveTo(vsX, y); ctx.lineTo(vsX + fs * (v === 0 ? 0.6 : 0.35), y);
      ctx.stroke();
    }
    const vy = amid - vsScale(s.vs) * vsH;
    ctx.strokeStyle = C.white;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(vsX + fs * 1.2, amid); ctx.lineTo(vsX, vy);
    ctx.stroke();
    if (Math.abs(s.vs) >= 400) {
      ctx.fillStyle = C.green;
      ctx.font = font(0.8);
      ctx.textAlign = 'left';
      ctx.fillText(String(Math.round(s.vs / 100) * 100), vsX - fs * 0.2, s.vs > 0 ? atY - fs * 0.6 + fs * 2.2 : atY + atH - fs * 0.4);
    }

    // ---------------- FMA
    const fmaY = fs * 1.25;
    ctx.font = font(1, true);
    const latName = (m: string) => ({ LNAV: 'LNV1', HDG: 'HDG', LOC: 'LOC1', TO: 'TO', GA: 'GA', ROLL: 'ROLL' } as Record<string, string>)[m] ?? m;
    const vertName = (m: string) => ({ VFLC: 'VFLCH', FLC: 'FLC', VPATH: 'VPATH', VALT: 'VALT', VALTS: 'VALTS', ALT: 'ALT', ALTS: 'ALTS', VS: 'VS', GS: 'GS', TO: 'TO', GA: 'GA', FLARE: 'FLARE', PITCH: 'PTCH' } as Record<string, string>)[m] ?? m;
    ctx.textAlign = 'left';
    ctx.fillStyle = C.green;
    ctx.fillText(latName(f.lat), ox + S * 0.1, fmaY);
    if (f.latArmed) { ctx.fillStyle = C.white; ctx.fillText(latName(f.latArmed), ox + S * 0.25, fmaY); }
    if (f.appr && f.lat !== 'LOC') { ctx.fillStyle = C.white; ctx.fillText('LOC1', ox + S * 0.25, fmaY + fs * 1.1); }
    ctx.textAlign = 'center';
    ctx.fillStyle = f.ap ? C.green : C.dim;
    ctx.fillText(f.ap ? 'AP' : '', ox + S * 0.5, fmaY);
    ctx.fillStyle = C.green;
    ctx.font = font(0.8);
    if (f.yd) ctx.fillText('YD', ox + S * 0.5, fmaY + fs * 1.05);
    ctx.font = font(1, true);
    ctx.textAlign = 'left';
    ctx.fillStyle = C.green;
    const vtxt = vertName(f.vert) + (f.vert === 'VS' ? ` ${f.vsSel > 0 ? '+' : ''}${f.vsSel}` : f.vert === 'FLC' ? ` ${f.spdSel}` : '');
    ctx.fillText(vtxt, ox + S * 0.63, fmaY);
    const armed: string[] = [];
    if (f.appr && f.vert !== 'GS' && f.vert !== 'FLARE') armed.push('GS');
    if (f.vnav && ['VFLC', 'VALT'].includes(f.vert)) armed.push(fms.phase === 'DESCENT' ? 'VPATH' : 'VALTS');
    else if (['FLC', 'VS'].includes(f.vert)) armed.push('ALTS');
    if (armed.length) { ctx.fillStyle = C.white; ctx.fillText(armed.join(' '), ox + S * 0.63, fmaY + fs * 1.1); }
    ctx.strokeStyle = C.gray;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(ox + S * 0.08, fmaY + fs * 1.55); ctx.lineTo(ox + S * 0.92, fmaY + fs * 1.55);
    ctx.stroke();

    // ---------------- HSI
    const hCx = ox + S * 0.5, hCy = H * 0.79, hR = Math.min(S * 0.27, H * 0.19);
    const hdg = trueToMag(s.hdg, s.lat, s.lon);
    ctx.save();
    ctx.translate(hCx, hCy);
    ctx.strokeStyle = C.white;
    ctx.fillStyle = C.white;
    ctx.lineWidth = 1.5;
    ctx.font = font(0.85);
    ctx.textAlign = 'center';
    for (let d = 0; d < 360; d += 5) {
      const a = (d - hdg - 90) * D2R;
      const l = d % 10 === 0 ? fs * 0.65 : fs * 0.35;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * hR, Math.sin(a) * hR);
      ctx.lineTo(Math.cos(a) * (hR - l), Math.sin(a) * (hR - l));
      ctx.stroke();
      if (d % 30 === 0) {
        ctx.save();
        ctx.rotate((d - hdg) * D2R);
        ctx.fillText(d === 0 ? 'N' : d === 90 ? 'E' : d === 180 ? 'S' : d === 270 ? 'W' : String(d / 10), 0, -hR + fs * 1.5);
        ctx.restore();
      }
    }
    // heading bug
    ctx.save();
    ctx.rotate((f.hdgSel - hdg) * D2R);
    ctx.fillStyle = C.cyan;
    ctx.fillRect(-fs * 0.45, -hR - fs * 0.15, fs * 0.9, fs * 0.45);
    ctx.restore();
    // course pointer and CDI
    let crs: number | null = null;
    let dev = 0;
    let col = C.magenta;
    if (f.navSource === 'LOC' && ils?.locValid) {
      crs = ils.courseMag;
      dev = clamp(ils.locDev / 2.5, -1.3, 1.3);
      col = C.green;
    } else if (ln.valid && fms.posInit) {
      crs = trueToMag(ln.dtk, s.lat, s.lon);
      const fsd = ln.approach ? 0.3 : fms.phase === 'CLIMB' || fms.phase === 'TAKEOFF' || fms.phase === 'APPROACH' ? 1 : 2;
      dev = clamp(-ln.xtk / fsd, -1.3, 1.3);
    }
    if (crs != null) {
      ctx.save();
      ctx.rotate((crs - hdg) * D2R);
      ctx.strokeStyle = col;
      ctx.fillStyle = col;
      ctx.lineWidth = 3;
      const ri = hR * 0.72;
      ctx.beginPath();
      ctx.moveTo(0, -ri); ctx.lineTo(0, -ri * 0.42);
      ctx.moveTo(0, ri * 0.42); ctx.lineTo(0, ri);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, -ri - fs * 0.6); ctx.lineTo(-fs * 0.45, -ri); ctx.lineTo(fs * 0.45, -ri); ctx.closePath();
      ctx.fill();
      // dots
      ctx.fillStyle = C.white;
      for (const k of [-2, -1, 1, 2]) {
        ctx.beginPath();
        ctx.arc(k * ri * 0.25, 0, fs * 0.16, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.strokeStyle = col;
      ctx.beginPath();
      ctx.moveTo(dev * ri * 0.5, -ri * 0.4); ctx.lineTo(dev * ri * 0.5, ri * 0.4);
      ctx.stroke();
      ctx.restore();
    }
    // aircraft
    ctx.strokeStyle = C.white;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, -fs * 0.8); ctx.lineTo(0, fs * 0.8);
    ctx.moveTo(-fs * 0.6, -fs * 0.1); ctx.lineTo(fs * 0.6, -fs * 0.1);
    ctx.moveTo(-fs * 0.3, fs * 0.65); ctx.lineTo(fs * 0.3, fs * 0.65);
    ctx.stroke();
    ctx.restore();
    // lubber + heading readout
    ctx.fillStyle = C.black;
    ctx.strokeStyle = C.white;
    ctx.beginPath();
    ctx.rect(hCx - fs * 1.6, hCy - hR - fs * 1.75, fs * 3.2, fs * 1.4);
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = C.green;
    ctx.font = font(1, true);
    ctx.textAlign = 'center';
    ctx.fillText(String(Math.round(hdg) % 360 || 360).padStart(3, '0'), hCx, hCy - hR - fs * 0.65);
    // Nav source and waypoint
    ctx.textAlign = 'left';
    ctx.font = font(0.9);
    ctx.fillStyle = col;
    ctx.fillText(f.navSource === 'LOC' && ils?.locValid ? `LOC1 ${ils.ident}` : 'FMS1', ox + S * 0.04, hCy - hR * 0.6);
    if (crs != null) {
      ctx.fillStyle = C.white;
      ctx.fillText(`CRS ${String(Math.round(crs) % 360 || 360).padStart(3, '0')}`, ox + S * 0.04, hCy - hR * 0.6 + fs * 1.2);
    }
    ctx.textAlign = 'right';
    const leg = fms.active.legs[fms.active.activeIdx];
    if (ln.valid && leg && leg.pt !== 'DISCO') {
      ctx.fillStyle = C.magenta;
      ctx.fillText(legDisplayIdent(leg), ox + S * 0.96, hCy - hR * 0.6);
      ctx.fillStyle = C.white;
      ctx.fillText(`${fmtDist(ln.dtg)} NM`, ox + S * 0.96, hCy - hR * 0.6 + fs * 1.2);
    } else if (ils?.locValid) {
      ctx.fillStyle = C.green;
      ctx.fillText(`${fmtDist(ils.thrDist)} NM`, ox + S * 0.96, hCy - hR * 0.6);
    }
    void angDiff;
  }
}

function vsScale(v: number): number {
  const a = Math.abs(v);
  const n = a <= 1000 ? (a / 1000) * 0.5 : a <= 2000 ? 0.5 + ((a - 1000) / 1000) * 0.25 : 0.75 + Math.min(1, (a - 2000) / 2000) * 0.25;
  return Math.sign(v) * n;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function tri(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, down: boolean, col: string) {
  ctx.fillStyle = col;
  ctx.beginPath();
  if (down) { ctx.moveTo(x, y + s * 0.2); ctx.lineTo(x - s * 0.6, y + s * 1.1); ctx.lineTo(x + s * 0.6, y + s * 1.1); }
  else { ctx.moveTo(x, y - s * 0.2); ctx.lineTo(x - s * 0.6, y - s * 1.1); ctx.lineTo(x + s * 0.6, y - s * 1.1); }
  ctx.closePath();
  ctx.fill();
}

function diamond(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, col: string) {
  ctx.strokeStyle = col;
  ctx.fillStyle = col;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, y - s); ctx.lineTo(x + s * 0.7, y); ctx.lineTo(x, y + s); ctx.lineTo(x - s * 0.7, y); ctx.closePath();
  ctx.fill();
}

function dots(ctx: CanvasRenderingContext2D, x: number, y: number, len: number, horiz: boolean) {
  ctx.strokeStyle = C.white;
  ctx.lineWidth = 1.5;
  for (const k of [-1, -0.5, 0.5, 1]) {
    ctx.beginPath();
    if (horiz) ctx.arc(x + k * len, y, 3, 0, Math.PI * 2);
    else ctx.arc(x, y + k * len, 3, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.beginPath();
  if (horiz) { ctx.moveTo(x, y - 6); ctx.lineTo(x, y + 6); } else { ctx.moveTo(x - 6, y); ctx.lineTo(x + 6, y); }
  ctx.stroke();
}

function barber(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, len: number, col: string) {
  const n = Math.ceil(Math.abs(len) / 8);
  for (let i = 0; i < n; i++) {
    ctx.fillStyle = i % 2 === 0 ? col : '#000';
    const yy = y + Math.sign(len) * i * 8;
    ctx.fillRect(x, Math.min(yy, yy + Math.sign(len) * 8), w, 8);
  }
}
