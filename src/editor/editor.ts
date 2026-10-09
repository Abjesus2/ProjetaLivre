import type { Entity, NewEntity, Pt } from '../core/types';
import { Doc } from '../core/doc';
import { boxValid, dist, robustBox, distToEntity, segBoxHit, tessellate, type Box } from '../core/geom';
import { View } from '../render/view';
import { Renderer, cachedBox, type Overlay } from '../render/renderer';
import { findSnap, type SnapSettings } from './snap';
import { gripsOf } from './grips';
import { GridIndex } from '../core/spatial';
import { Tool, SelectTool, TOOLS, resolveCommand } from './tools';

export type LogKind = 'info' | 'ok' | 'warn' | 'cmd';

export class Editor {
  doc = new Doc();
  view = new View();
  overlay: Overlay = {
    cursor: null, world: null, snap: null, selection: new Set(), hover: null, preview: [], guides: [],
    window: null, grips: [], activeGrip: -1, showCrosshair: true, label: null,
  };
  renderer: Renderer;
  selectTool: SelectTool;
  tool: Tool;
  lastCommand = '';
  lastPoint: Pt | null = null;
  ortho = false;
  snap: SnapSettings = {
    osnap: true, grid: false, gridStep: 10,
    kinds: { end: true, mid: true, center: true, quad: true, inter: true, near: false },
  };
  textHeight = 5;
  offsetDist = 10;
  rawWorld: Pt = { x: 0, y: 0 };
  private panning: { x: number; y: number } | null = null;
  /** gestos de toque: dois dedos movem e aproximam a vista */
  private touches = new Map<number, Pt>();
  private pinch: { d: number; m: Pt } | null = null;

  // ganchos da interface
  onPrompt: (text: string) => void = () => {};
  onLog: (text: string, kind?: LogKind) => void = () => {};
  onSelection: () => void = () => {};
  onDocChange: () => void = () => {};
  onTool: (name: string) => void = () => {};
  onCursor: (p: Pt) => void = () => {};
  askText: (screen: Pt, initial: string) => Promise<string | null> = async () => null;
  onContextMenu: (screen: Pt) => void = () => {};

  constructor(public canvas: HTMLCanvasElement) {
    this.renderer = new Renderer(canvas, this.view, this.doc, this.overlay);
    this.selectTool = new SelectTool(this);
    this.tool = this.selectTool;
    this.doc.on(() => { this.index = null; this.renderer.dirty = true; this.pruneSelection(); this.onDocChange(); });
    this.bind();
    const loop = () => { this.flushMove(); this.refreshOverlay(); this.renderer.frame(); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }

  // ---------------------------------------------------------------- estado
  get selection() { return this.overlay.selection; }
  selected(): Entity[] { return this.doc.d.entities.filter((e) => this.selection.has(e.id)); }
  setSelection(ids: Iterable<string>) {
    this.selection.clear();
    for (const id of ids) this.selection.add(id);
    this.onSelection(); // a seleção é desenhada por cima; não precisa redesenhar o arquivo
  }
  pruneSelection() {
    let changed = false;
    for (const id of this.selection) if (!this.doc.byId(id)) { this.selection.delete(id); changed = true; }
    if (changed) this.onSelection();
  }

  /** Executa uma alteração com ponto de desfazer e animações. */
  mutate(fn: () => void) {
    this.doc.checkpoint();
    fn();
    this.renderer.dirty = true;
    this.doc.emit();
  }
  add(e: NewEntity): Entity {
    const ent = this.doc.add(e);
    this.renderer.born(ent.id);
    return ent;
  }
  get layer() { return this.doc.d.current; }
  erase(ents: Entity[]) {
    if (!ents.length) return;
    this.renderer.dissolve(ents);
    this.mutate(() => this.doc.remove(new Set(ents.map((e) => e.id))));
    this.onLog(`${ents.length} objeto(s) apagado(s)`, 'ok');
  }

  undo() { if (this.doc.undo()) this.onLog('Desfeito', 'info'); else this.onLog('Nada para desfazer', 'warn'); }
  redo() { if (this.doc.redo()) this.onLog('Refeito', 'info'); else this.onLog('Nada para refazer', 'warn'); }

  zoomExtents(animated = true, zoomFrom?: number) {
    const b = robustBox(this.doc.d.entities.filter((e) => this.doc.isVisible(e)), cachedBox);
    if (!boxValid(b)) { this.view.fit(b); this.renderer.dirty = true; return; }
    if (!animated) { this.view.fit(b); this.renderer.dirty = true; return; }
    const tmp = new View(); tmp.w = this.view.w; tmp.h = this.view.h; tmp.fit(b);
    // ao abrir um arquivo: parte de um pouco mais afastado e aproxima
    if (zoomFrom) { this.view.s = tmp.s * zoomFrom; this.view.cx = tmp.cx; this.view.cy = tmp.cy; }
    const from = { s: this.view.s, cx: this.view.cx, cy: this.view.cy };
    const t0 = performance.now();
    const step = () => {
      const k = Math.min(1, (performance.now() - t0) / 450), e = 1 - Math.pow(1 - k, 4);
      this.view.s = Math.exp(Math.log(from.s) + (Math.log(tmp.s) - Math.log(from.s)) * e);
      this.view.cx = from.cx + (tmp.cx - from.cx) * e;
      this.view.cy = from.cy + (tmp.cy - from.cy) * e;
      this.view.version++; this.renderer.dirty = true;
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // ---------------------------------------------------------------- ferramentas
  setTool(t: Tool | null) {
    // sair da seleção não pode limpar os objetos escolhidos (o próximo comando os usa)
    if (this.tool === this.selectTool) this.selectTool.release(); else this.tool.cancel();
    this.tool = t ?? this.selectTool;
    this.overlay.preview = []; this.overlay.guides = [];
    this.onTool(this.tool.id);
    this.tool.start();
    this.updatePrompt();
  }
  updatePrompt() { this.onPrompt(this.tool.prompt); }
  prompt(text: string) { this.tool.prompt = text; this.updatePrompt(); }

  runCommand(raw: string): void {
    const text = raw.trim();
    if (!text) {
      if (this.tool !== this.selectTool) { this.tool.enter(); return; }
      if (this.lastCommand) return this.runCommand(this.lastCommand);
      return;
    }
    this.onLog(text, 'cmd');
    if (this.tool !== this.selectTool && this.tool.input(text)) return;
    const p = this.parsePoint(text);
    if (p && this.tool !== this.selectTool && this.tool.acceptsPoints()) { this.pointInput(p); return; }
    const id = resolveCommand(text);
    if (id) { this.startCommand(id); return; }
    this.onLog(`Comando desconhecido: “${text}”. Digite AJUDA para ver a lista.`, 'warn');
  }

  startCommand(id: string) {
    const def = TOOLS[id];
    if (!def) return;
    this.lastCommand = id;
    if (def.action) { def.action(this); return; }
    this.setTool(def.make!(this));
  }

  /** "x,y" absoluto · "@dx,dy" relativo · "@d<a" polar relativo · "d<a" polar absoluto · "d" distância na direção do cursor */
  parsePoint(text: string): Pt | null {
    const t = text.replace(/\s+/g, '').replace(/;/g, ',');
    const rel = t.startsWith('@');
    const s = rel ? t.slice(1) : t;
    const base = rel ? (this.tool.base() ?? this.lastPoint ?? { x: 0, y: 0 }) : { x: 0, y: 0 };
    let m = s.match(/^(-?[\d.]+),(-?[\d.]+)$/);
    if (m) return { x: base.x + +m[1], y: base.y + +m[2] };
    m = s.match(/^(-?[\d.]+)<(-?[\d.]+)$/);
    if (m) { const a = (+m[2] * Math.PI) / 180; return { x: base.x + +m[1] * Math.cos(a), y: base.y + +m[1] * Math.sin(a) }; }
    m = s.match(/^(-?[\d.]+)$/);
    const b = this.tool.base();
    if (m && b && !rel) {
      const cur = this.overlay.world ?? this.rawWorld;
      const d = dist(b, cur);
      if (d < 1e-12) return { x: b.x + +m[1], y: b.y };
      return { x: b.x + ((cur.x - b.x) / d) * +m[1], y: b.y + ((cur.y - b.y) / d) * +m[1] };
    }
    return null;
  }

  pointInput(p: Pt) {
    this.renderer.ripple(p, '#8be9ff');
    this.tool.click(p, { shift: false, typed: true });
    this.lastPoint = p;
  }

  // ---------------------------------------------------------------- consulta espacial
  private index: GridIndex | null = null;
  /** objetos cujas caixas podem tocar a janela (índice espacial reconstruído só quando o desenho muda) */
  near(b: Box): Entity[] {
    if (!this.index) this.index = new GridIndex(this.doc.d.entities, cachedBox);
    return this.index.query(b);
  }

  hit(p: Pt, filter?: (e: Entity) => boolean): Entity | null {
    const tol = 7 / this.view.s;
    let best: Entity | null = null, bd = tol;
    const ents = this.near({ minX: p.x - tol, minY: p.y - tol, maxX: p.x + tol, maxY: p.y + tol });
    for (let i = ents.length - 1; i >= 0; i--) {
      const e = ents[i];
      if (!this.doc.isVisible(e) || (filter && !filter(e))) continue;
      const b = cachedBox(e);
      if (p.x < b.minX - tol || p.x > b.maxX + tol || p.y < b.minY - tol || p.y > b.maxY + tol) continue;
      const d = distToEntity(e, p, this.view.s);
      if (d < bd) { bd = d; best = e; }
    }
    return best;
  }

  inWindow(a: Pt, b: Pt, crossing: boolean): Entity[] {
    const box: Box = { minX: Math.min(a.x, b.x), minY: Math.min(a.y, b.y), maxX: Math.max(a.x, b.x), maxY: Math.max(a.y, b.y) };
    return this.near(box).filter((e) => {
      if (!this.doc.isEditable(e)) return false;
      const eb = cachedBox(e);
      const inside = eb.minX >= box.minX && eb.maxX <= box.maxX && eb.minY >= box.minY && eb.maxY <= box.maxY;
      if (inside) return true;
      if (!crossing) return false;
      if (eb.maxX < box.minX || eb.minX > box.maxX || eb.maxY < box.minY || eb.minY > box.maxY) return false;
      for (const path of tessellate(e, this.view.s)) for (let i = 0; i < path.length - 1; i++) if (segBoxHit(path[i], path[i + 1], box)) return true;
      return false;
    });
  }

  // ---------------------------------------------------------------- eventos
  private screenOf(ev: PointerEvent | WheelEvent | MouseEvent): Pt {
    const r = this.canvas.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  }

  /** posição do mundo com snap + orto aplicados */
  resolvePoint(screen: Pt): Pt {
    const raw = this.view.toWorld(screen.x, screen.y);
    this.rawWorld = raw;
    const exclude = this.tool.snapExclude?.();
    const t = 16 / this.view.s;
    const visible = this.tool.wantsSnap() ? this.near({ minX: raw.x - t, minY: raw.y - t, maxX: raw.x + t, maxY: raw.y + t }).filter((e) => this.doc.isVisible(e)) : [];
    let s = this.tool.wantsSnap() ? findSnap(visible, raw, this.view.s, this.snap, exclude) : null;
    let p = s ? s.p : raw;
    const b = this.tool.base();
    if (this.ortho && b && (!s || s.kind === 'grid' || s.kind === 'near')) {
      p = Math.abs(raw.x - b.x) > Math.abs(raw.y - b.y) ? { x: raw.x, y: b.y } : { x: b.x, y: raw.y };
      if (s && s.kind === 'grid') p = Math.abs(raw.x - b.x) > Math.abs(raw.y - b.y) ? { x: s.p.x, y: b.y } : { x: b.x, y: s.p.y };
      s = null;
    }
    this.overlay.snap = s;
    return p;
  }

  private bind() {
    const cv = this.canvas;
    cv.addEventListener('contextmenu', (e) => e.preventDefault());
    cv.addEventListener('pointerdown', (ev) => {
      cv.setPointerCapture(ev.pointerId);
      const sp = this.screenOf(ev);
      if (ev.pointerType === 'touch') {
        this.touches.set(ev.pointerId, sp);
        if (this.touches.size === 2) {
          const [a, b] = [...this.touches.values()];
          this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), m: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
          this.selectTool.release(); this.overlay.window = null;
          return;
        }
      }
      if (ev.button === 1 || (ev.button === 0 && ev.altKey)) {
        this.panning = sp; cv.classList.add('panning'); return;
      }
      if (ev.button === 2) {
        if (this.tool !== this.selectTool) this.tool.enter();
        else this.onContextMenu(sp);
        return;
      }
      this.pendingMove = null;
      const p = this.resolvePoint(sp);
      this.renderer.ripple(p);
      this.tool.pointerDown(p, sp, { shift: ev.shiftKey, typed: false });
      if (this.tool !== this.selectTool) this.lastPoint = p;
    });
    cv.addEventListener('pointermove', (ev) => {
      const sp = this.screenOf(ev);
      if (this.pinch && this.touches.has(ev.pointerId)) {
        this.touches.set(ev.pointerId, sp);
        const [a, b] = [...this.touches.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y), m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        this.view.pan(m.x - this.pinch.m.x, m.y - this.pinch.m.y);
        if (this.pinch.d > 0) this.view.zoomAt(m.x, m.y, d / this.pinch.d);
        this.pinch = { d, m }; this.renderer.dirty = true;
        return;
      }
      this.overlay.cursor = sp;
      if (this.panning) { this.view.pan(sp.x - this.panning.x, sp.y - this.panning.y); this.panning = sp; this.renderer.dirty = true; return; }
      // processado uma vez por quadro (flushMove), não a cada evento do mouse
      this.pendingMove = sp;
    });
    const endTouch = (ev: PointerEvent) => {
      this.touches.delete(ev.pointerId);
      if (this.pinch) { if (this.touches.size < 2) this.pinch = null; return true; }
      return false;
    };
    cv.addEventListener('pointercancel', endTouch);
    cv.addEventListener('pointerup', (ev) => {
      if (ev.pointerType === 'touch' && endTouch(ev)) return;
      if (this.panning) { this.panning = null; cv.classList.remove('panning'); return; }
      if (ev.button !== 0) return;
      const sp = this.screenOf(ev);
      this.tool.pointerUp(this.resolvePoint(sp), sp);
    });
    cv.addEventListener('pointerleave', () => { this.overlay.cursor = null; this.overlay.snap = null; });
    cv.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      const sp = this.screenOf(ev);
      const k = Math.exp(-ev.deltaY * (ev.ctrlKey ? 0.01 : 0.0018));
      this.view.zoomAt(sp.x, sp.y, k);
      this.renderer.dirty = true;
    }, { passive: false });
    cv.addEventListener('dblclick', (ev) => {
      if (ev.button === 1) this.zoomExtents();
    });
    window.addEventListener('resize', () => this.renderer.resize());
  }

  private pendingMove: Pt | null = null;
  private flushMove() {
    const sp = this.pendingMove;
    if (!sp) return;
    this.pendingMove = null;
    const p = this.resolvePoint(sp);
    this.overlay.world = p;
    this.onCursor(p);
    this.tool.move(p, sp);
  }

  private refreshOverlay() {
    const ov = this.overlay;
    ov.preview = this.tool.preview();
    ov.guides = this.tool.guides();
    ov.label = this.tool.label();
    ov.hover = this.tool.hoverId();
    // grips das entidades selecionadas (até um limite)
    ov.grips = [];
    if (this.tool === this.selectTool && this.selection.size && this.selection.size <= 60) {
      for (const e of this.selected()) for (const g of gripsOf(e)) ov.grips.push(g.p);
    }
    ov.activeGrip = this.selectTool.activeGripIndex();
  }

  /** Tamanho de texto agradável para o zoom atual */
  niceTextHeight() {
    const raw = 22 / this.view.s;
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    return [1, 2, 2.5, 5, 10].map((k) => k * p).reduce((a, b) => (Math.abs(b - raw) < Math.abs(a - raw) ? b : a));
  }
}
