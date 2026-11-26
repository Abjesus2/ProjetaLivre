// Modo só visualização: abre DWG/DXF pelo CADCraft e mostra pela placa de vídeo, sem nada do
// editor (sem objetos editáveis, índices de seleção, desfazer, snaps…). Leve para máquinas fracas:
// - a leitura e a montagem da imagem rodam num worker; a página só recebe números prontos;
// - os traços sobem uma vez para a placa de vídeo; arrastar/aproximar só muda dois números;
// - nada é redesenhado sem necessidade (sem laço contínuo de quadros);
// - ao aproximar muito, só a região visível é refeita com mais detalhe.
import { createParseWorker } from '../io/workerFactory';
import { cadcraftModule } from '../io/cadcraft/module';
import type { CadInfo } from '../io/cadcraft/bridge';
import { parseDisplay, type DisplayData, type Bounds } from './format';
import { GLRenderer, Canvas2DRenderer, type ViewRenderer, type ViewXf, type Theme } from './gl';

export type Progress = (stage: string, pct: number) => void;

export interface ViewerHost {
  root: HTMLElement;
  /** modo leve ligado: resolução 1×, sem suavização */
  lite: () => boolean;
  toast: (title: string, kind?: 'ok' | 'warn' | 'info', sub?: string) => void;
  onEdit: (file: File) => void;
  onClose: () => void;
  onTheme: () => void;
}

const $ = <T extends HTMLElement = HTMLElement>(root: ParentNode, sel: string) => root.querySelector(sel) as T;
const nf = (n: number) => n.toLocaleString('pt-BR');
const fmt = (n: number) => (Math.abs(n) >= 1e6 ? n.toExponential(3) : n.toFixed(2)).replace('.', ',');

const VERSIONS: Record<string, string> = {
  AC1009: 'R12', AC1012: 'R13', AC1014: 'R14', AC1015: '2000', AC1018: '2004', AC1021: '2007', AC1024: '2010', AC1027: '2013', AC1032: '2018',
};

export class Viewer {
  private stage: HTMLElement;
  private canvas: HTMLCanvasElement;
  private r: ViewRenderer | null = null;
  private worker: Worker | null = null;
  private file: File | null = null;
  private info: CadInfo | null = null;
  private base: DisplayData | null = null;
  private detail: { d: DisplayData; win: Bounds; tol: number } | null = null;
  private space = 0;
  private visible = new Uint8Array(0);
  private v: ViewXf = { cx: 0, cy: 0, s: 1, w: 1, h: 1 };
  private fitS = 1;
  private dpr = 1;
  private raf = 0;
  private settle = 0;
  private reqId = 0;
  private inFlight = 0;
  private waiting = new Map<number, (d: DisplayData | null) => void>();
  private mouse: { x: number; y: number } | null = null;
  private ro: ResizeObserver;
  private opened = false;

  constructor(private host: ViewerHost) {
    const root = host.root;
    this.stage = $(root, '.vw-stage');
    this.canvas = $(root, '.vw-cv');
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.stage);
    this.bindPointer();
    this.bindUi();
  }

  get isOpen() { return this.opened; }

  // ------------------------------------------------------------------ abrir / fechar
  /** Lê o arquivo e mostra. Lança erro (mensagem legível) se não conseguir. */
  async open(file: File, progress: Progress, signal: AbortSignal) {
    progress('Carregando o leitor CADCraft…', 4);
    const module = await cadcraftModule().catch((err: Error) => {
      throw new Error(`Visualização rápida indisponível neste navegador (${err.message}). Use “Abrir arquivo”, que tem leitores alternativos.`);
    });
    progress('Lendo o arquivo do disco…', 6);
    const data = await file.arrayBuffer();
    if (signal.aborted) throw new DOMException('Leitura cancelada', 'AbortError');
    const w = createParseWorker();
    const res = await new Promise<{ info: CadInfo; space: number; buf: ArrayBuffer }>((resolve, reject) => {
      const onAbort = () => { w.terminate(); reject(new DOMException('Leitura cancelada', 'AbortError')); };
      signal.addEventListener('abort', onAbort, { once: true });
      w.onmessage = (ev) => {
        const m = ev.data;
        if (m.type === 'progress') progress(m.stage, m.pct);
        else if (m.type === 'view') { signal.removeEventListener('abort', onAbort); resolve(m); }
        else if (m.type === 'error') {
          signal.removeEventListener('abort', onAbort); w.terminate();
          reject(new Error(`${m.message}. Tente “Abrir arquivo”, que tem leitores alternativos.`));
        }
      };
      w.onerror = (ev) => { signal.removeEventListener('abort', onAbort); w.terminate(); reject(new Error(ev.message || 'Falha no leitor')); };
      w.postMessage({ op: 'view', data, name: file.name, module }, [data]);
    });
    progress('Enviando para a placa de vídeo…', 92);
    this.close(false);
    this.worker = w;
    w.onmessage = (ev) => this.onWorker(ev.data);
    w.onerror = () => { /* pedidos de detalhe falhos só deixam a imagem base */ };
    this.file = file;
    this.info = res.info;
    this.space = res.space;
    this.newCanvas();
    this.setBase(parseDisplay(res.buf));
    this.visible = new Uint8Array(res.info.layers.length + 1).fill(1);
    res.info.layers.forEach((l, i) => { this.visible[i] = l.on && !l.frozen ? 1 : 0; });
    this.opened = true;
    this.host.root.hidden = false;
    this.fillHeader();
    this.fillSheets();
    this.fillLayers();
    this.resize();
    this.fit();
    this.stage.focus({ preventScroll: true });
    if (res.info.notes.length) console.info('Avisos da leitura:', res.info.notes);
  }

  /** Fecha: termina o worker (libera a memória do desenho) e a placa de vídeo. */
  close(hide = true) {
    this.worker?.terminate();
    this.worker = null;
    for (const f of this.waiting.values()) f(null);
    this.waiting.clear();
    this.inFlight = 0;
    this.r?.dispose();
    this.r = null;
    this.base = null;
    this.detail = null;
    this.info = null;
    cancelAnimationFrame(this.raf);
    clearTimeout(this.settle);
    if (hide) {
      this.opened = false;
      this.file = null;
      this.host.root.hidden = true;
      this.showLayers(false);
    }
    this.mouse = null;
    $(this.host.root, '.vw-coords').textContent = '';
  }

  /** novo canvas a cada arquivo: o contexto anterior (WebGL ou 2D) some junto */
  private newCanvas() {
    const c = this.canvas.cloneNode(false) as HTMLCanvasElement;
    this.canvas.replaceWith(c);
    this.canvas = c;
    const gl = GLRenderer.create(c, !this.host.lite());
    if (gl) gl.onRestore = () => this.schedule();
    this.r = gl ?? new Canvas2DRenderer(c);
  }

  private setBase(d: DisplayData) {
    this.base = d;
    this.r?.upload('base', d);
    this.detail = null;
    this.r?.drop('detail');
  }

  // ------------------------------------------------------------------ worker: pedidos de detalhe
  private onWorker(m: { type: string; id?: number; buf?: ArrayBuffer; message?: string }) {
    if (m.id === undefined) return;
    const f = this.waiting.get(m.id);
    this.waiting.delete(m.id);
    if (m.type === 'display' && m.buf) f?.(parseDisplay(m.buf));
    else f?.(null);
  }

  private request(space: number, tolerance: number, win: Bounds | null): Promise<DisplayData | null> {
    if (!this.worker) return Promise.resolve(null);
    const id = ++this.reqId;
    this.worker.postMessage({ op: 'display', id, space, tolerance, win: win ? [win.x0, win.y0, win.x1, win.y1] : null });
    return new Promise((res) => this.waiting.set(id, res));
  }

  /** Tamanho de um pixel no mundo. */
  private px() { return 1 / this.v.s; }

  private viewRect(): Bounds {
    const hw = this.v.w / 2 / this.v.s, hh = this.v.h / 2 / this.v.s;
    return { x0: this.v.cx - hw, y0: this.v.cy - hh, x1: this.v.cx + hw, y1: this.v.cy + hh };
  }

  /** a imagem base é grosseira demais para a vista atual? */
  private needDetail(): boolean {
    const b = this.base;
    if (!b || this.space !== 0) return false;
    if (b.tolerance > this.px() * 1.5) return true;
    const vr = this.viewRect();
    return b.truncated && vr.x1 - vr.x0 < (b.full.x1 - b.full.x0) / 3;
  }

  private detailCovers(): boolean {
    const dt = this.detail;
    if (!dt) return false;
    const vr = this.viewRect();
    return vr.x0 >= dt.win.x0 && vr.y0 >= dt.win.y0 && vr.x1 <= dt.win.x1 && vr.y1 <= dt.win.y1;
  }

  /** depois que a vista para de mexer: refaz a região visível com mais detalhe, se precisar */
  private async refine() {
    if (!this.needDetail()) return;
    if (this.detailCovers() && this.detail!.tol <= this.px() * 1.5) return;
    if (this.inFlight) return; // um por vez; ao chegar, a vista é reavaliada
    const vr = this.viewRect();
    const mx = (vr.x1 - vr.x0) * 0.3, my = (vr.y1 - vr.y0) * 0.3;
    const win = { x0: vr.x0 - mx, y0: vr.y0 - my, x1: vr.x1 + mx, y1: vr.y1 + my };
    const tol = this.px() * 0.75;
    this.inFlight++;
    this.setNote('Refinando a região visível…');
    const d = await this.request(0, tol, win);
    this.inFlight--;
    if (!this.base) return;
    if (d) {
      this.detail = { d, win, tol };
      this.r?.upload('detail', d);
    }
    this.setNote('');
    this.schedule();
    this.settleLater();
  }

  private settleLater() {
    clearTimeout(this.settle);
    this.settle = window.setTimeout(() => void this.refine(), 220);
  }

  // ------------------------------------------------------------------ vista
  private resize() {
    if (!this.opened && !this.base) return;
    const cw = Math.max(1, this.stage.clientWidth), ch = Math.max(1, this.stage.clientHeight);
    const dpr = this.host.lite() ? 1 : Math.min(window.devicePixelRatio || 1, 2);
    const k = dpr / this.dpr;
    this.dpr = dpr;
    this.canvas.width = Math.round(cw * dpr);
    this.canvas.height = Math.round(ch * dpr);
    this.v = { ...this.v, s: this.v.s * k, w: this.canvas.width, h: this.canvas.height };
    this.fitS *= k;
    this.schedule();
  }

  /** Enquadra o desenho (ou o papel da folha). */
  fit() {
    const b = this.base;
    if (!b) return;
    const box = b.sheet ?? b.robust;
    const bw = Math.max(box.x1 - box.x0, 1e-9), bh = Math.max(box.y1 - box.y0, 1e-9);
    const s = Math.min(this.v.w / bw, this.v.h / bh) * 0.92;
    this.fitS = Number.isFinite(s) && s > 0 ? s : 1;
    this.v = { ...this.v, cx: (box.x0 + box.x1) / 2, cy: (box.y0 + box.y1) / 2, s: this.fitS };
    this.changed();
  }

  /** aproxima/afasta por `k` mantendo o ponto de tela (px, py, em pixels CSS) parado */
  zoomAt(k: number, px?: number, py?: number) {
    const s = Math.min(Math.max(this.v.s * k, this.fitS / 50), this.fitS * 1e7);
    const sx = (px ?? this.stage.clientWidth / 2) * this.dpr, sy = (py ?? this.stage.clientHeight / 2) * this.dpr;
    const wx = this.v.cx + (sx - this.v.w / 2) / this.v.s, wy = this.v.cy - (sy - this.v.h / 2) / this.v.s;
    this.v = { ...this.v, s, cx: wx - (sx - this.v.w / 2) / s, cy: wy + (sy - this.v.h / 2) / s };
    this.changed();
  }

  /** arrasta a vista por (dx, dy) pixels CSS */
  pan(dx: number, dy: number) {
    this.v = { ...this.v, cx: this.v.cx - (dx * this.dpr) / this.v.s, cy: this.v.cy + (dy * this.dpr) / this.v.s };
    this.changed();
  }

  private changed() {
    this.schedule();
    this.settleLater();
  }

  private schedule() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.draw(); });
  }

  private theme(): Theme {
    const paper = document.documentElement.dataset.theme === 'paper';
    return paper ? { bg: [1, 0.992, 0.965], ink: [0.106, 0.102, 0.133] } : { bg: [0.051, 0.047, 0.063], ink: [0.914, 0.941, 1] };
  }

  private draw() {
    if (!this.r || !this.base) return;
    const vis = (l: number) => this.visible[l] !== 0;
    const slot = this.detail && this.needDetail() && this.detailCovers() ? 'detail' : 'base';
    this.r.draw(this.v, this.theme(), vis, slot);
    if (this.mouse) {
      const wx = this.v.cx + (this.mouse.x * this.dpr - this.v.w / 2) / this.v.s, wy = this.v.cy - (this.mouse.y * this.dpr - this.v.h / 2) / this.v.s;
      $(this.host.root, '.vw-coords').textContent = `${fmt(wx)} · ${fmt(wy)}`;
    }
  }

  redraw() { this.schedule(); }

  // ------------------------------------------------------------------ mouse, toque e teclado
  private bindPointer() {
    const st = this.stage;
    const pts = new Map<number, { x: number; y: number }>();
    let lastTap = { t: 0, x: 0, y: 0 }, moved = false;
    const local = (ev: PointerEvent | WheelEvent | MouseEvent) => { const r = st.getBoundingClientRect(); return { x: ev.clientX - r.left, y: ev.clientY - r.top }; };
    st.addEventListener('pointerdown', (ev) => {
      if (!this.base) return;
      try { st.setPointerCapture(ev.pointerId); } catch { /* ponteiro já solto */ }
      pts.set(ev.pointerId, local(ev));
      moved = false;
      st.classList.add('grabbing');
    });
    st.addEventListener('pointermove', (ev) => {
      const p = local(ev);
      this.mouse = ev.pointerType === 'mouse' ? p : null;
      const prev = pts.get(ev.pointerId);
      if (!prev) { if (this.mouse) this.schedule(); return; }
      if (pts.size === 1) {
        if (Math.hypot(p.x - prev.x, p.y - prev.y) > 0) moved = true;
        pts.set(ev.pointerId, p);
        this.pan(p.x - prev.x, p.y - prev.y);
      } else if (pts.size === 2) {
        // pinça: distância muda o zoom, o ponto médio arrasta
        const [a, b] = [...pts.entries()];
        const other = a[0] === ev.pointerId ? b[1] : a[1];
        const m0 = { x: (prev.x + other.x) / 2, y: (prev.y + other.y) / 2 }, m1 = { x: (p.x + other.x) / 2, y: (p.y + other.y) / 2 };
        const d0 = Math.hypot(prev.x - other.x, prev.y - other.y), d1 = Math.hypot(p.x - other.x, p.y - other.y);
        pts.set(ev.pointerId, p);
        moved = true;
        if (d0 > 2) this.zoomAt(d1 / d0, m0.x, m0.y);
        this.pan(m1.x - m0.x, m1.y - m0.y);
      }
    });
    const up = (ev: PointerEvent) => {
      if (!pts.has(ev.pointerId)) return;
      pts.delete(ev.pointerId);
      if (!pts.size) st.classList.remove('grabbing');
      // toque duplo aproxima
      if (ev.pointerType !== 'mouse' && !moved && !pts.size) {
        const p = local(ev), now = performance.now();
        if (now - lastTap.t < 320 && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < 30) { this.zoomAt(2, p.x, p.y); lastTap.t = 0; }
        else lastTap = { t: now, x: p.x, y: p.y };
      }
    };
    st.addEventListener('pointerup', up);
    st.addEventListener('pointercancel', up);
    st.addEventListener('pointerleave', () => { this.mouse = null; });
    st.addEventListener('dblclick', (ev) => { const p = local(ev); this.zoomAt(ev.shiftKey ? 0.5 : 2, p.x, p.y); });
    st.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      if (!this.base) return;
      const unit = ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? st.clientHeight : 1;
      const dy = Math.max(-300, Math.min(300, ev.deltaY * unit));
      const p = local(ev);
      this.zoomAt(Math.exp(-dy * 0.0016), p.x, p.y);
    }, { passive: false });
    st.addEventListener('keydown', (ev) => this.onKey(ev));
  }

  private onKey(ev: KeyboardEvent) {
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const step = 60;
    const k = ev.key;
    const act: Record<string, () => void> = {
      '+': () => this.zoomAt(1.4), '=': () => this.zoomAt(1.4), '-': () => this.zoomAt(1 / 1.4), _: () => this.zoomAt(1 / 1.4),
      '0': () => this.fit(), f: () => this.fit(), z: () => this.fit(), Home: () => this.fit(),
      ArrowLeft: () => this.pan(step, 0), ArrowRight: () => this.pan(-step, 0), ArrowUp: () => this.pan(0, step), ArrowDown: () => this.pan(0, -step),
      c: () => this.toggleLayers(), l: () => this.toggleLayers(),
      Escape: () => this.showLayers(false),
    };
    const f = act[k] ?? act[k.toLowerCase()];
    if (f) { ev.preventDefault(); f(); }
  }

  // ------------------------------------------------------------------ painéis
  private bindUi() {
    const root = this.host.root;
    root.querySelectorAll<HTMLButtonElement>('[data-vw]').forEach((b) => b.addEventListener('click', () => {
      switch (b.dataset.vw) {
        case 'fit': this.fit(); break;
        case 'in': this.zoomAt(1.5); break;
        case 'out': this.zoomAt(1 / 1.5); break;
        case 'layers': this.toggleLayers(); break;
        case 'theme': this.host.onTheme(); this.schedule(); break;
        case 'edit': if (this.file) this.host.onEdit(this.file); break;
        case 'back': this.host.onClose(); break;
        case 'all': this.setAll(1); break;
        case 'none': this.setAll(0); break;
        case 'file': this.info?.layers.forEach((l, i) => { this.visible[i] = l.on && !l.frozen ? 1 : 0; }); this.syncLayerChecks(); this.schedule(); break;
        case 'close-layers': this.showLayers(false); break;
      }
    }));
    $<HTMLSelectElement>(root, '.vw-sheet').addEventListener('change', (ev) => void this.setSpace(+(ev.target as HTMLSelectElement).value));
    $(root, '.vw-layer-list').addEventListener('change', (ev) => {
      const cb = ev.target as HTMLInputElement;
      const i = Number(cb.dataset.i);
      if (Number.isInteger(i)) { this.visible[i] = cb.checked ? 1 : 0; this.schedule(); }
    });
  }

  private toggleLayers() {
    this.showLayers($(this.host.root, '.vw-layers').hidden === true);
  }

  private showLayers(on: boolean) {
    $(this.host.root, '.vw-layers').hidden = !on;
    $(this.host.root, '[data-vw="layers"]').classList.toggle('on', on);
  }

  private setAll(v: 0 | 1) {
    if (!this.info) return;
    for (let i = 0; i < this.info.layers.length; i++) this.visible[i] = v;
    this.syncLayerChecks();
    this.schedule();
  }

  private syncLayerChecks() {
    this.host.root.querySelectorAll<HTMLInputElement>('.vw-layer-list input').forEach((cb) => { cb.checked = this.visible[Number(cb.dataset.i)] !== 0; });
  }

  private async setSpace(space: number) {
    if (space === this.space || !this.worker) return;
    this.setNote('Montando a folha…');
    const d = await this.request(space, 0, null);
    this.setNote('');
    if (!d || !this.base) { this.host.toast('Não foi possível mostrar essa folha', 'warn'); return; }
    this.space = space;
    this.setBase(d);
    this.fillLayers();
    this.fit();
  }

  private setNote(t: string) {
    const base = this.base;
    const notes: string[] = [];
    if (t) notes.push(t);
    else {
      if (base?.truncated) notes.push('Desenho muito grande: aproxime para ver todos os detalhes');
      if (base?.hasImages) notes.push('Imagens anexadas não são exibidas');
    }
    $(this.host.root, '.vw-note').textContent = notes.join(' · ');
  }

  private fillHeader() {
    const info = this.info!, root = this.host.root;
    $(root, '.vw-name').textContent = this.file?.name ?? '';
    const ver = VERSIONS[info.version] ? `AutoCAD ${VERSIONS[info.version]}` : info.version;
    const mode = this.r?.kind === 'webgl' ? 'placa de vídeo' : 'modo simples (sem WebGL)';
    $(root, '.vw-meta').textContent = [`${nf(info.entities)} objetos`, `${info.layers.length} camadas`, ver, mode].filter(Boolean).join(' · ');
    this.setNote('');
  }

  private fillSheets() {
    const sel = $<HTMLSelectElement>(this.host.root, '.vw-sheet');
    const info = this.info!;
    const opts = [`<option value="0">Modelo</option>`];
    info.sheets.forEach((s, i) => { if (s.entities > 0) opts.push(`<option value="${i + 1}">${escapeHtml(s.name)}</option>`); });
    sel.innerHTML = opts.join('');
    sel.value = String(this.space);
    sel.hidden = opts.length < 2;
  }

  private fillLayers() {
    const info = this.info!, b = this.base!;
    const count = (l: number) => b.lineStart[l + 1] - b.lineStart[l] + b.triStart[l + 1] - b.triStart[l] + b.ptStart[l + 1] - b.ptStart[l];
    const items = info.layers.map((l, i) => ({ l, i, n: count(i) })).filter((x) => x.n > 0).sort((a, z) => a.l.name.localeCompare(z.l.name, 'pt-BR', { numeric: true }));
    $(this.host.root, '.vw-layer-list').innerHTML = items.length
      ? items.map(({ l, i }) => `<li><label><input type="checkbox" data-i="${i}"${this.visible[i] ? ' checked' : ''}/><i style="--c:${l.color}"></i><span>${escapeHtml(l.name)}</span>${l.on && !l.frozen ? '' : '<small>desligada no arquivo</small>'}</label></li>`).join('')
      : '<li class="vw-empty">Nenhuma camada com objetos</li>';
  }
}

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
