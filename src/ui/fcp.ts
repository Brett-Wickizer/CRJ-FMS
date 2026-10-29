// Flight control panel (autopilot / flight director mode selection).
import { sim } from '../sim/sim';
import { fms } from '../fms/fms';
import * as control from '../sim/control';
import { trueToMag } from '../util/magvar';

type Toast = (t: string) => void;

export class FcpView {
  root: HTMLElement;
  private els = new Map<string, HTMLElement>();
  private altStep = 1000;

  constructor(parent: HTMLElement, private toast: Toast) {
    this.root = document.createElement('div');
    this.root.className = 'fcp';
    this.root.innerHTML = `
      <div class="fcp-row">
        ${this.btn('AP', 'AP')}${this.btn('YD', 'YD')}${this.btn('FD', 'FD')}
        ${this.btn('HDG', 'HDG')}${this.btn('NAV', 'NAV')}${this.btn('APPR', 'APPR')}${this.btn('BANK', '½ BANK')}
        ${this.btn('VNAV', 'VNAV')}${this.btn('FLC', 'SPEED')}${this.btn('VS', 'VS')}${this.btn('ALT', 'ALT')}${this.btn('TOGA', 'TOGA')}
      </div>
      <div class="fcp-row">
        ${this.knob('HDG', 'HDG SEL', 'SYNC')}
        ${this.knob('ALT', 'ALT SEL', '1000')}
        ${this.knob('SPD', 'SPEED', 'M/IAS')}
        ${this.knob('VSK', 'VERT SPD', '')}
      </div>`;
    parent.appendChild(this.root);
    this.root.querySelectorAll<HTMLElement>('[data-f]').forEach((e) => this.els.set(e.dataset.f!, e));
    this.bind();
  }

  private btn(id: string, label: string) {
    return `<button class="fcp-btn" data-f="${id}" data-act="${id}">${label}</button>`;
  }
  private knob(id: string, label: string, sub: string) {
    return `<div class="knob"><button data-act="${id}-" aria-label="${label} decrease">−</button><div class="kl">${label}<span class="kv" data-f="${id}v">---</span></div><button data-act="${id}+" aria-label="${label} increase">+</button>${sub ? `<button class="sub" data-act="${id}S">${sub}</button>` : ''}</div>`;
  }

  private bind() {
    let timer: number | undefined;
    let count = 0;
    const stop = () => { clearInterval(timer); timer = undefined; };
    this.root.addEventListener('pointerdown', (e) => {
      const el = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
      if (!el) return;
      e.preventDefault();
      const act = el.dataset.act!;
      count = 0;
      this.action(act, 0);
      if (/[+-]$/.test(act)) {
        timer = window.setInterval(() => { count++; this.action(act, count); }, 110);
        const up = () => { stop(); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); };
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', up);
      }
    });
  }

  private action(act: string, rep: number) {
    const f = sim.ac.fcp, s = sim.ac.s;
    const accel = rep > 20 ? 10 : rep > 8 ? 5 : 1;
    const hdgNow = Math.round(trueToMag(s.hdg, s.lat, s.lon));
    switch (act) {
      case 'AP':
        if (s.onGround) { this.toast('AP NOT AVAILABLE ON GROUND'); return; }
        f.ap = !f.ap;
        if (!f.ap) this.toast('AUTOPILOT DISCONNECT');
        break;
      case 'YD': f.yd = !f.yd; break;
      case 'FD': f.fd = !f.fd; break;
      case 'HDG': f.lat = 'HDG'; if (f.latArmed === 'LNAV') f.latArmed = null; break;
      case 'NAV':
        if (f.lat === 'LNAV') { f.lat = 'HDG'; f.hdgSel = hdgNow; }
        else f.latArmed = f.latArmed === 'LNAV' ? null : 'LNAV';
        break;
      case 'APPR': f.appr = !f.appr; if (!f.appr && f.lat === 'LOC') { f.lat = 'HDG'; f.hdgSel = hdgNow; f.navSource = 'FMS'; } if (!f.appr && f.vert === 'GS') f.vert = 'PITCH'; break;
      case 'BANK': f.halfBank = !f.halfBank; break;
      case 'VNAV':
        f.vnav = !f.vnav;
        if (f.vnav && !s.onGround && !['GS', 'TO', 'GA', 'FLARE'].includes(f.vert)) f.vert = 'VFLC';
        if (!f.vnav && f.vert.startsWith('V') && f.vert !== 'VS') {
          if (f.vert === 'VALT' || f.vert === 'VALTS') { f.vert = 'ALT'; f.altHold = Math.round(s.alt / 10) * 10; }
          else { f.vert = 'FLC'; f.spdSel = Math.round(s.ias); }
        }
        break;
      case 'FLC': f.vnav = false; f.vert = 'FLC'; f.spdSel = Math.round(s.ias); f.spdMach = s.mach > 0.7 && s.alt > 28000; f.machSel = Math.round(s.mach * 100) / 100; break;
      case 'VS': f.vnav = false; f.vert = 'VS'; f.vsSel = Math.round(s.vs / 100) * 100; break;
      case 'ALT': f.vnav = false; f.vert = 'ALT'; f.altHold = Math.round(s.alt / 10) * 10; break;
      case 'TOGA': { const e = control.toga(); if (e) this.toast(e); break; }
      case 'HDG-': f.hdgSel = ((f.hdgSel - accel + 359) % 360) + 1; break;
      case 'HDG+': f.hdgSel = ((f.hdgSel + accel - 1) % 360) + 1; break;
      case 'HDGS': f.hdgSel = hdgNow || 360; break;
      case 'ALT-': f.altSel = Math.max(0, f.altSel - this.altStep * (rep > 10 ? 2 : 1)); break;
      case 'ALT+': f.altSel = Math.min(45000, f.altSel + this.altStep * (rep > 10 ? 2 : 1)); break;
      case 'ALTS': this.altStep = this.altStep === 1000 ? 100 : 1000; (this.root.querySelector('[data-act="ALTS"]') as HTMLElement).textContent = String(this.altStep); break;
      case 'SPD-': if (f.spdMach) f.machSel = Math.max(0.4, Math.round((f.machSel - 0.01) * 100) / 100); else f.spdSel = Math.max(100, f.spdSel - accel); break;
      case 'SPD+': if (f.spdMach) f.machSel = Math.min(0.85, Math.round((f.machSel + 0.01) * 100) / 100); else f.spdSel = Math.min(335, f.spdSel + accel); break;
      case 'SPDS': f.spdMach = !f.spdMach; if (f.spdMach) f.machSel = Math.round(Math.max(0.5, s.mach) * 100) / 100; else f.spdSel = Math.round(Math.max(150, s.ias)); break;
      case 'VSK-': f.vsSel = Math.max(-6000, f.vsSel - 100); if (f.vert !== 'VS') { f.vert = 'VS'; f.vnav = false; } break;
      case 'VSK+': f.vsSel = Math.min(6000, f.vsSel + 100); if (f.vert !== 'VS') { f.vert = 'VS'; f.vnav = false; } break;
    }
    this.refresh();
  }

  refresh() {
    const f = sim.ac.fcp;
    const set = (id: string, on: boolean, armed = false) => {
      const e = this.els.get(id);
      if (!e) return;
      e.classList.toggle('on', on);
      e.classList.toggle('armed', !on && armed);
    };
    set('AP', f.ap);
    set('YD', f.yd);
    set('FD', f.fd);
    set('HDG', f.lat === 'HDG');
    set('NAV', f.lat === 'LNAV', f.latArmed === 'LNAV');
    set('APPR', f.lat === 'LOC' || f.vert === 'GS', f.appr);
    set('BANK', f.halfBank);
    set('VNAV', f.vnav && f.vert.startsWith('V') && f.vert !== 'VS', f.vnav);
    set('FLC', f.vert === 'FLC');
    set('VS', f.vert === 'VS');
    set('ALT', f.vert === 'ALT' || f.vert === 'ALTS');
    set('TOGA', f.vert === 'TO' || f.vert === 'GA');
    const v = (id: string, t: string) => { const e = this.els.get(id); if (e && e.textContent !== t) e.textContent = t; };
    v('HDGv', String(f.hdgSel).padStart(3, '0') + '°');
    v('ALTv', String(f.altSel));
    v('SPDv', f.spdMach ? `M.${Math.round(f.machSel * 100)}` : String(f.spdSel));
    v('VSKv', `${f.vsSel > 0 ? '+' : ''}${f.vsSel}`);
    void fms;
  }
}
