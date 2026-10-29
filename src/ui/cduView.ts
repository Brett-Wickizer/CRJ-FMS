// Collins CDU hardware: bezel, line select keys, function keys and keyboard.
import { cdu } from '../cdu/cdu';
import { COLS, ROWS, Screen } from '../cdu/screen';

interface KeyDef {
  k: string;
  label: string;
  cls?: string;
}

const FN_ROW1: KeyDef[] = [
  { k: 'MSG', label: 'MSG', cls: 'msg' },
  { k: 'DIR', label: 'DIR<br>INTC' },
  { k: 'FPLN', label: 'FPLN' },
  { k: 'DEPARR', label: 'DEP<br>ARR' },
  { k: 'HOLD', label: 'HOLD' },
  { k: 'BRT', label: '<span class="arrow">▲</span><br><small>BRT</small>' },
  { k: 'PREV', label: 'PREV<br>PAGE' },
  { k: 'NEXT', label: 'NEXT<br>PAGE' },
];
const FN_ROW2: KeyDef[] = [
  { k: 'INDEX', label: 'INDEX' },
  { k: 'FIX', label: 'FIX' },
  { k: 'LEGS', label: 'LEGS' },
  { k: 'SECFPLN', label: 'SEC<br>FPLN' },
  { k: 'VNAV', label: 'VNAV' },
  { k: 'DIM', label: '<span class="arrow">▼</span><br><small>DIM</small>' },
  { k: 'MCDU', label: 'MCDU<br>MENU' },
  { k: 'EXEC', label: 'EXEC', cls: 'exec' },
];
const LEFT_BLOCK: KeyDef[][] = [
  [{ k: 'RADIO', label: 'RADIO' }, { k: 'PROG', label: 'PROG' }, { k: 'PERF', label: 'PERF' }],
  [{ k: 'MFDDATA', label: 'MFD<br>DATA' }, { k: 'MFDMENU', label: 'MFD<br>MENU' }, { k: 'MFDADV', label: 'MFD<br>ADV' }],
  [{ k: '1', label: '1' }, { k: '2', label: '2' }, { k: '3', label: '3' }],
  [{ k: '4', label: '4' }, { k: '5', label: '5' }, { k: '6', label: '6' }],
  [{ k: '7', label: '7' }, { k: '8', label: '8' }, { k: '9', label: '9' }],
  [{ k: '.', label: '•' }, { k: '0', label: 'Ø' }, { k: '+/-', label: '+/−' }],
];
const ALPHA: string[][] = [
  ['A', 'B', 'C', 'D', 'E'],
  ['F', 'G', 'H', 'I', 'J'],
  ['K', 'L', 'M', 'N', 'O'],
  ['P', 'Q', 'R', 'S', 'T'],
  ['U', 'V', 'W', 'X', 'Y'],
  ['Z', 'SP', 'DEL', '/', 'CLR'],
];

export class CduView {
  root: HTMLElement;
  private cells: HTMLSpanElement[][] = [];
  private screenEl!: HTMLElement;
  private execLight!: HTMLElement;
  private msgKey!: HTMLElement;
  private prev: string[][] = [];

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'cdu';
    this.root.innerHTML = this.template();
    parent.appendChild(this.root);
    this.screenEl = this.root.querySelector('.cdu-screen') as HTMLElement;
    this.execLight = this.root.querySelector('.key.exec .light') as HTMLElement;
    this.msgKey = this.root.querySelector('.key.msg') as HTMLElement;
    this.buildScreen();
    this.bindKeys();
    cdu.onRender = (s) => this.draw(s);
    cdu.onBrightness = (b) => this.screenEl.style.setProperty('--cdu-brt', String(b));
    new ResizeObserver(() => this.fit()).observe(this.root);
  }

  private template(): string {
    const lsk = (side: 'L' | 'R') =>
      Array.from({ length: 6 }, (_, i) => `<button class="lsk lsk-${side}" data-k="${side}${i + 1}" aria-label="Line select ${i + 1}${side}"><span></span></button>`).join('');
    const fn = (row: KeyDef[]) => row.map((d) => `<button class="key fn ${d.cls ?? ''}" data-k="${d.k}">${d.cls === 'exec' ? '<i class="light"></i>' : ''}<span>${d.label}</span></button>`).join('');
    const left = LEFT_BLOCK.map((row, r) =>
      row.map((d) => `<button class="key ${r >= 2 ? 'num' : 'fn'}" data-k="${d.k}"><span>${d.label}</span></button>`).join(''),
    ).join('');
    const alpha = ALPHA.map((row) =>
      row.map((k) => `<button class="key alpha ${k.length > 1 ? 'wide-label' : ''}" data-k="${k}"><span>${k}</span></button>`).join(''),
    ).join('');
    return `
      <div class="cdu-bezel">
        <i class="screw s1"></i><i class="screw s2"></i><i class="screw s3"></i><i class="screw s4"></i>
        <div class="cdu-top">
          <div class="lsk-col">${lsk('L')}</div>
          <div class="cdu-screen-wrap"><div class="cdu-screen" role="img" aria-label="CDU display"></div></div>
          <div class="lsk-col">${lsk('R')}</div>
        </div>
        <div class="cdu-brand">COLLINS</div>
        <div class="fn-rows">${fn(FN_ROW1)}${fn(FN_ROW2)}</div>
        <div class="lower">
          <div class="left-block">${left}</div>
          <div class="alpha-block">${alpha}</div>
        </div>
      </div>`;
  }

  private buildScreen() {
    this.screenEl.innerHTML = '';
    this.cells = [];
    for (let r = 0; r < ROWS; r++) {
      const row = document.createElement('div');
      row.className = 'cdu-row';
      const cells: HTMLSpanElement[] = [];
      for (let c = 0; c < COLS; c++) {
        const sp = document.createElement('span');
        sp.textContent = ' ';
        row.appendChild(sp);
        cells.push(sp);
      }
      this.screenEl.appendChild(row);
      this.cells.push(cells);
    }
    this.prev = Array.from({ length: ROWS }, () => Array(COLS).fill(''));
  }

  private fit() {
    const w = this.screenEl.clientWidth;
    const h = this.screenEl.clientHeight;
    if (!w || !h) return;
    // Tall, narrow glyphs like the Collins CDU font: size from the row height,
    // then squeeze each cell to its column width (B612 Mono advance = 0.6 em).
    const rowH = h / ROWS;
    const cellW = w / COLS;
    // Cap height is ~0.7 em, so glyphs may exceed the row pitch slightly.
    const fs = Math.min(rowH * 1.18, cellW / 0.6);
    const sx = Math.min(1.2, cellW / (0.6 * fs));
    this.screenEl.style.setProperty('--cdu-fs', `${fs.toFixed(2)}px`);
    this.screenEl.style.setProperty('--cdu-sx', sx.toFixed(3));
  }

  draw(s: Screen) {
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const cell = s.cells[r][c];
        const key = `${cell.ch}|${cell.color}|${cell.small ? 1 : 0}`;
        if (this.prev[r][c] === key) continue;
        this.prev[r][c] = key;
        const sp = this.cells[r][c];
        sp.textContent = cell.ch;
        sp.className = `c-${cell.color}${cell.small ? ' sm' : ''}`;
      }
    }
    this.execLight.classList.toggle('on', cdu.execLit);
    this.msgKey.classList.toggle('lit', cdu.msgLit);
  }

  private bindKeys() {
    const press = (el: HTMLElement) => {
      const k = el.dataset.k!;
      el.classList.add('down');
      cdu.keyDown(k);
      if (navigator.vibrate) try { navigator.vibrate(8); } catch { /* not supported */ }
      return k;
    };
    let repeatTimer: number | undefined;
    this.root.addEventListener('pointerdown', (e) => {
      const el = (e.target as HTMLElement).closest('[data-k]') as HTMLElement | null;
      if (!el) return;
      e.preventDefault();
      const k = press(el);
      if (k === 'CLR') {
        repeatTimer = window.setTimeout(() => { cdu.key('CLRALL'); repeatTimer = -1; }, 700);
      }
      const up = () => {
        el.classList.remove('down');
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        if (k === 'CLR') {
          if (repeatTimer === -1) { repeatTimer = undefined; return; }
          clearTimeout(repeatTimer);
        }
        cdu.key(k);
      };
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    });
  }

  /** Physical keyboard support (desktop). */
  handleKeyboard(e: KeyboardEvent): boolean {
    const t = e.target as HTMLElement;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return false;
    let k: string | null = null;
    const key = e.key;
    const fm = /^F([1-6])$/.exec(key);
    if (fm) k = (e.shiftKey ? 'R' : 'L') + fm[1];
    else if (/^F([7-9]|1[0-2])$/.test(key)) k = 'R' + (parseInt(key.slice(1), 10) - 6);
    else if (/^[a-zA-Z0-9]$/.test(key) && !e.ctrlKey && !e.metaKey && !e.altKey) k = key.toUpperCase();
    else if (key === ' ') k = 'SP';
    else if (key === '/' || key === '.') k = key;
    else if (key === '-' || key === '+') k = '+/-';
    else if (key === 'Backspace') k = 'CLR';
    else if (key === 'Delete') k = 'DEL';
    else if (key === 'Escape') k = 'CLRALL';
    else if (key === 'Enter') k = 'EXEC';
    else if (key === 'PageUp') k = 'PREV';
    else if (key === 'PageDown') k = 'NEXT';
    if (!k) return false;
    e.preventDefault();
    const el = this.root.querySelector(`[data-k="${CSS.escape(k === 'CLRALL' ? 'CLR' : k)}"]`) as HTMLElement | null;
    if (el) { el.classList.add('down'); setTimeout(() => el.classList.remove('down'), 90); }
    cdu.key(k);
    return true;
  }
}
