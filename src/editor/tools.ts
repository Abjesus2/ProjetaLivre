import type { Entity, NewEntity, Pt } from '../core/types';
import { ang, dist, formatLen, mirrorAbout, rotateAbout, scaleAbout, transformEntity, translate, polyArea, type Mat } from '../core/geom';
import type { Editor } from './editor';
import { gripAt, gripPoints } from './grips';
import { arc3, explodeEntity, offsetEntity, regularPolygon, trimEntity } from './ops';
import { cachedBox } from '../render/renderer';

/** prévia de transformação: acima disto, os originais com a matriz (sem recriar cada objeto) */
const BIG_PREVIEW = 300;

export interface PtrInfo { shift: boolean; typed: boolean }
const deg = (r: number) => ((r * 180) / Math.PI).toFixed(1).replace('.', ',');
const num = (s: string) => { const v = parseFloat(s.replace(',', '.')); return isFinite(v) ? v : null; };

/** Ferramenta base. Cada ferramenta conversa com o usuário pelo prompt da linha de comando. */
export abstract class Tool {
  abstract id: string;
  prompt = '';
  constructor(protected ed: Editor) {}
  start() {}
  cancel() {}
  click(_p: Pt, _i: PtrInfo) {}
  pointerDown(p: Pt, _screen: Pt, i: PtrInfo) { this.click(p, i); }
  pointerUp(_p: Pt, _screen: Pt) {}
  move(_p: Pt, _screen: Pt) {}
  enter() { this.done(); }
  input(_t: string): boolean { return false; }
  base(): Pt | null { return null; }
  preview(): NewEntity[] { return []; }
  /** prévia de transformação com muitos objetos: os originais desenhados com a matriz */
  xformPreview(): { ents: Entity[]; m: Mat } | null { return null; }
  guides(): Pt[][] { return []; }
  label(): string | null { return null; }
  hoverId(): string | null { return null; }
  wantsSnap() { return true; }
  acceptsPoints() { return true; }
  snapExclude?(): Set<string>;
  protected cur: Pt | null = null;
  protected done() { this.ed.setTool(null); }
  protected say(t: string) { this.ed.prompt(t); }
  protected get layer() { return this.ed.layer; }
}

// ================================================================ seleção (ferramenta padrão)
export class SelectTool extends Tool {
  id = 'select';
  prompt = 'Comando: clique em objetos, arraste uma janela ou digite um comando (L, C, PL, M…)';
  private down: Pt | null = null;
  private downScreen: Pt | null = null;
  private windowPending = false;
  private grip: { id: string; index: number; preview: Entity | null } | null = null;
  private hover: string | null = null;
  /** quando usada dentro de outra ferramenta, só escolhe objetos */
  pickOnly = false;

  activeGripIndex() { return this.grip ? this.gripFlatIndex : -1; }
  private gripFlatIndex = -1;

  hoverId() { return this.grip ? null : this.hover; }
  wantsSnap() { return !!this.grip; }
  private excl = { id: '', set: new Set<string>() };
  snapExclude() {
    const id = this.grip?.id ?? '';
    if (this.excl.id !== id) this.excl = { id, set: new Set(id ? [id] : []) };
    return this.excl.set;
  }
  base() { if (!this.grip) return null; const e = this.ed.doc.byId(this.grip.id); return e ? gripPoints(e)[this.grip.index] : null; }

  preview(): NewEntity[] { return this.grip?.preview ? [this.grip.preview] : []; }

  pointerDown(p: Pt, screen: Pt, i: PtrInfo) {
    const ed = this.ed;
    if (this.grip) { this.commitGrip(p); return; }
    // grip?
    if (!this.pickOnly && ed.selection.size && ed.selection.size <= 60) {
      let flat = 0;
      for (const e of ed.selected()) {
        const gs = gripPoints(e);
        for (let k = 0; k < gs.length; k++, flat++) {
          const q = ed.view.toScreen(gs[k]);
          if (Math.hypot(q.x - screen.x, q.y - screen.y) < 9 && ed.doc.isEditable(e)) {
            this.grip = { id: e.id, index: k, preview: null };
            this.gripFlatIndex = flat;
            this.say('Estique: arraste/clique no novo ponto (Esc cancela)');
            return;
          }
        }
      }
    }
    if (this.windowPending && this.down) { this.finishWindow(screen); return; }
    const raw = ed.rawWorld;
    const hit = ed.hit(raw, (e) => ed.doc.isEditable(e));
    if (hit) {
      const sel = new Set(ed.selection);
      if (i.shift) sel.delete(hit.id); else sel.add(hit.id);
      ed.setSelection(sel);
      return;
    }
    this.down = raw; this.downScreen = screen; this.windowPending = false;
  }

  move(p: Pt, screen: Pt) {
    const ed = this.ed;
    if (this.grip) {
      const e = ed.doc.byId(this.grip.id);
      if (e) this.grip.preview = gripAt(e, this.grip.index).apply(p);
      return;
    }
    if (this.downScreen) {
      ed.overlay.window = { a: this.downScreen, b: screen };
      return;
    }
    const h = ed.hit(ed.rawWorld, (e) => ed.doc.isEditable(e));
    this.hover = h?.id ?? null;
  }

  pointerUp(p: Pt, screen: Pt) {
    if (this.grip) {
      // arrastar e soltar longe do grip confirma; clique simples espera o próximo clique
      const e = this.ed.doc.byId(this.grip.id);
      if (e) { const g = this.ed.view.toScreen(gripPoints(e)[this.grip.index]); if (Math.hypot(g.x - screen.x, g.y - screen.y) > 6) this.commitGrip(p); }
      return;
    }
    if (!this.downScreen) return;
    if (Math.hypot(screen.x - this.downScreen.x, screen.y - this.downScreen.y) < 5) {
      // clique no vazio: início de janela por clique-clique, ou limpar seleção
      if (!this.windowPending) { this.windowPending = true; this.say('Canto oposto da janela (Esc cancela)'); return; }
    }
    this.finishWindow(screen);
  }

  private finishWindow(screen: Pt) {
    const ed = this.ed;
    if (!this.downScreen) return;
    const a = ed.view.toWorld(this.downScreen.x, this.downScreen.y), b = ed.view.toWorld(screen.x, screen.y);
    const crossing = screen.x < this.downScreen.x;
    const found = ed.inWindow(a, b, crossing);
    const sel = new Set(ed.selection);
    for (const e of found) sel.add(e.id);
    ed.setSelection(sel);
    this.reset();
    if (found.length) ed.onLog(`${found.length} objeto(s) selecionado(s) por ${crossing ? 'cruzamento' : 'janela'}`, 'info');
  }

  private commitGrip(p: Pt) {
    const g = this.grip!;
    const e = this.ed.doc.byId(g.id);
    this.grip = null; this.gripFlatIndex = -1;
    if (e) {
      const ne = gripAt(e, g.index).apply(p);
      this.ed.mutate(() => this.ed.doc.replace(ne));
    }
    this.reset();
  }

  private reset() {
    this.down = null; this.downScreen = null; this.windowPending = false;
    this.ed.overlay.window = null;
    if (!this.pickOnly) this.say(this.prompt0);
  }
  private prompt0 = this.prompt;

  /** abandona arrasto/janela em andamento, mantendo a seleção */
  release() { this.grip = null; this.gripFlatIndex = -1; this.down = null; this.downScreen = null; this.windowPending = false; this.ed.overlay.window = null; }
  cancel() {
    if (this.grip || this.downScreen) { this.grip = null; this.gripFlatIndex = -1; this.reset(); return; }
    if (!this.pickOnly) this.ed.setSelection([]);
  }
  enter() {}
  isBusy() { return !!(this.grip || this.downScreen); }
}

// ================================================================ desenho
class LineTool extends Tool {
  id = 'line';
  pts: Pt[] = [];
  start() { this.say('LINHA — primeiro ponto:'); }
  base() { return this.pts[this.pts.length - 1] ?? null; }
  click(p: Pt) {
    const last = this.base();
    if (last && dist(last, p) > 1e-12) {
      const e = this.ed;
      e.mutate(() => e.add({ type: 'line', layer: this.layer, a: last, b: p }));
    }
    this.pts.push(p);
    this.say(`LINHA — próximo ponto${this.pts.length >= 3 ? ' [F = fechar]' : ''} [D = desfazer] (Enter termina):`);
  }
  move(p: Pt) { this.cur = p; }
  input(t: string) {
    const k = t.toUpperCase();
    if ((k === 'F' || k === 'C') && this.pts.length >= 3) { this.click(this.pts[0]); this.done(); return true; }
    if ((k === 'D' || k === 'U') && this.pts.length) { this.pts.pop(); this.ed.undo(); return true; }
    return false;
  }
  preview(): NewEntity[] { const b = this.base(); return b && this.cur ? [{ type: 'line', layer: this.layer, a: b, b: this.cur }] : []; }
  label() { const b = this.base(); return b && this.cur ? `${formatLen(dist(b, this.cur))} < ${deg(ang(b, this.cur))}°` : null; }
}

class PolyTool extends Tool {
  id = 'poly';
  pts: Pt[] = [];
  start() { this.say('POLILINHA — ponto inicial:'); }
  base() { return this.pts[this.pts.length - 1] ?? null; }
  click(p: Pt) { this.pts.push(p); this.say('POLILINHA — próximo ponto [F = fechar] [D = desfazer] (Enter termina):'); }
  move(p: Pt) { this.cur = p; }
  input(t: string) {
    const k = t.toUpperCase();
    if (k === 'F' || k === 'C') { this.finish(true); return true; }
    if (k === 'D' || k === 'U') { this.pts.pop(); return true; }
    return false;
  }
  enter() { this.finish(false); }
  finish(closed: boolean) {
    if (this.pts.length >= 2) { const pts = this.pts; this.ed.mutate(() => this.ed.add({ type: 'poly', layer: this.layer, pts, closed })); }
    this.done();
  }
  preview(): NewEntity[] { return this.pts.length && this.cur ? [{ type: 'poly', layer: this.layer, pts: [...this.pts, this.cur], closed: false }] : []; }
  label() { const b = this.base(); return b && this.cur ? `${formatLen(dist(b, this.cur))} < ${deg(ang(b, this.cur))}°` : null; }
}

class RectTool extends Tool {
  id = 'rect';
  a: Pt | null = null;
  start() { this.say('RETÂNGULO — primeiro canto:'); }
  base() { return this.a; }
  rect(a: Pt, b: Pt): Pt[] { return [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }]; }
  click(p: Pt) {
    if (!this.a) { this.a = p; this.say('RETÂNGULO — canto oposto (ou @largura,altura):'); return; }
    const pts = this.rect(this.a, p);
    this.ed.mutate(() => this.ed.add({ type: 'poly', layer: this.layer, pts, closed: true }));
    this.done();
  }
  move(p: Pt) { this.cur = p; }
  preview(): NewEntity[] { return this.a && this.cur ? [{ type: 'poly', layer: this.layer, pts: this.rect(this.a, this.cur), closed: true }] : []; }
  label() { return this.a && this.cur ? `${formatLen(Math.abs(this.cur.x - this.a.x))} × ${formatLen(Math.abs(this.cur.y - this.a.y))}` : null; }
}

class CircleTool extends Tool {
  id = 'circle';
  c: Pt | null = null;
  diam = false;
  start() { this.say('CÍRCULO — centro:'); }
  base() { return this.c; }
  click(p: Pt) {
    if (!this.c) { this.c = p; this.say('CÍRCULO — raio (clique ou digite) [D = diâmetro]:'); return; }
    this.make(dist(this.c, p) / (this.diam ? 2 : 1));
  }
  make(r: number) {
    if (!this.c || r <= 0) return;
    const c = this.c;
    this.ed.mutate(() => this.ed.add({ type: 'circle', layer: this.layer, c, r }));
    this.done();
  }
  input(t: string) {
    if (!this.c) return false;
    if (t.toUpperCase() === 'D') { this.diam = true; this.say('CÍRCULO — diâmetro:'); return true; }
    const v = num(t); if (v == null) return false;
    this.make(this.diam ? v / 2 : v); return true;
  }
  move(p: Pt) { this.cur = p; }
  preview(): NewEntity[] { return this.c && this.cur ? [{ type: 'circle', layer: this.layer, c: this.c, r: dist(this.c, this.cur) / (this.diam ? 2 : 1) }] : []; }
  label() { return this.c && this.cur ? `${this.diam ? 'Ø' : 'R'} ${formatLen(dist(this.c, this.cur))}` : null; }
}

class ArcTool extends Tool {
  id = 'arc';
  pts: Pt[] = [];
  start() { this.say('ARCO — ponto inicial:'); }
  base() { return this.pts[this.pts.length - 1] ?? null; }
  click(p: Pt) {
    this.pts.push(p);
    if (this.pts.length === 1) this.say('ARCO — segundo ponto (no arco):');
    else if (this.pts.length === 2) this.say('ARCO — ponto final:');
    else {
      const a = arc3(this.pts[0], this.pts[1], this.pts[2]);
      if (a) this.ed.mutate(() => this.ed.add({ type: 'arc', layer: this.layer, ...a }));
      this.done();
    }
  }
  move(p: Pt) { this.cur = p; }
  preview(): NewEntity[] {
    if (!this.cur) return [];
    if (this.pts.length === 1) return [{ type: 'line', layer: this.layer, a: this.pts[0], b: this.cur }];
    if (this.pts.length === 2) { const a = arc3(this.pts[0], this.pts[1], this.cur); return a ? [{ type: 'arc', layer: this.layer, ...a }] : []; }
    return [];
  }
}

class EllipseTool extends Tool {
  id = 'ellipse';
  c: Pt | null = null;
  m: Pt | null = null;
  start() { this.say('ELIPSE — centro:'); }
  base() { return this.m ? this.c : this.c; }
  click(p: Pt) {
    if (!this.c) { this.c = p; this.say('ELIPSE — extremidade do eixo:'); return; }
    if (!this.m) { this.m = p; this.say('ELIPSE — distância do outro semi-eixo:'); return; }
    this.make(dist(this.c, p));
  }
  make(d: number) {
    const e = this.build(d); if (!e) return;
    this.ed.mutate(() => this.ed.add(e)); this.done();
  }
  build(d: number): NewEntity | null {
    if (!this.c || !this.m) return null;
    let major = { x: this.m.x - this.c.x, y: this.m.y - this.c.y };
    const R = Math.hypot(major.x, major.y); if (R < 1e-12 || d <= 0) return null;
    let ratio = d / R;
    if (ratio > 1) { const a = Math.atan2(major.y, major.x) + Math.PI / 2; major = { x: Math.cos(a) * d, y: Math.sin(a) * d }; ratio = R / d; }
    return { type: 'ellipse', layer: this.layer, c: this.c, major, ratio, start: 0, end: Math.PI * 2 };
  }
  input(t: string) { if (!this.m) return false; const v = num(t); if (v == null) return false; this.make(v); return true; }
  move(p: Pt) { this.cur = p; }
  preview(): NewEntity[] {
    if (!this.c || !this.cur) return [];
    if (!this.m) return [{ type: 'line', layer: this.layer, a: this.c, b: this.cur }];
    const e = this.build(dist(this.c, this.cur)); return e ? [e] : [];
  }
}

class PolygonTool extends Tool {
  id = 'polygon';
  sides = 6;
  c: Pt | null = null;
  start() { this.say(`POLÍGONO — centro (digite o nº de lados, atual ${this.sides}):`); }
  base() { return this.c; }
  click(p: Pt) {
    if (!this.c) { this.c = p; this.say('POLÍGONO — vértice (raio inscrito):'); return; }
    const pts = regularPolygon(this.c, p, this.sides);
    this.ed.mutate(() => this.ed.add({ type: 'poly', layer: this.layer, pts, closed: true }));
    this.done();
  }
  input(t: string) {
    const v = num(t); if (v == null) return false;
    if (!this.c) { this.sides = Math.max(3, Math.min(128, Math.round(v))); this.start(); return true; }
    this.click({ x: this.c.x + v, y: this.c.y }); return true;
  }
  move(p: Pt) { this.cur = p; }
  preview(): NewEntity[] { return this.c && this.cur ? [{ type: 'poly', layer: this.layer, pts: regularPolygon(this.c, this.cur, this.sides), closed: true }] : []; }
}

class TextTool extends Tool {
  id = 'text';
  busy = false;
  start() { this.say(`TEXTO — ponto de inserção (altura ${formatLen(this.ed.textHeight)}; digite um número para mudar):`); }
  input(t: string) { const v = num(t); if (v == null || v <= 0) return false; this.ed.textHeight = v; this.start(); return true; }
  async click(p: Pt) {
    if (this.busy) return;
    this.busy = true;
    const text = await this.ed.askText(this.ed.view.toScreen(p), '');
    this.busy = false;
    if (text && text.trim()) {
      const h = this.ed.textHeight;
      this.ed.mutate(() => this.ed.add({ type: 'text', layer: this.layer, p, h, text, rot: 0 }));
    }
    this.done();
  }
  move(p: Pt) { this.cur = p; }
  preview(): NewEntity[] { return this.cur && !this.busy ? [{ type: 'text', layer: this.layer, p: this.cur, h: this.ed.textHeight, text: 'Texto', rot: 0 }] : []; }
}

class PointTool extends Tool {
  id = 'point';
  start() { this.say('PONTO — clique para posicionar (Enter termina):'); }
  click(p: Pt) { this.ed.mutate(() => this.ed.add({ type: 'point', layer: this.layer, p })); }
}

class DimTool extends Tool {
  id = 'dim';
  pts: Pt[] = [];
  start() { this.say('COTA — primeiro ponto de medição:'); }
  base() { return this.pts[this.pts.length - 1] ?? null; }
  click(p: Pt) {
    this.pts.push(p);
    if (this.pts.length === 1) { this.say('COTA — segundo ponto:'); return; }
    if (this.pts.length === 2) { this.say('COTA — posição da linha de cota:'); return; }
    const [a, b] = this.pts;
    const lay = this.ed.doc.layer('Cotas') ? 'Cotas' : this.layer;
    const h = this.ed.niceTextHeight() * 0.8;
    this.ed.mutate(() => this.ed.add({ type: 'dim', layer: lay, a, b, off: p, h }));
    this.done();
  }
  move(p: Pt) { this.cur = p; }
  preview(): NewEntity[] {
    if (!this.cur) return [];
    if (this.pts.length === 1) return [{ type: 'line', layer: this.layer, a: this.pts[0], b: this.cur }];
    if (this.pts.length === 2) return [{ type: 'dim', layer: this.layer, a: this.pts[0], b: this.pts[1], off: this.cur, h: this.ed.niceTextHeight() * 0.8 }];
    return [];
  }
}

// ================================================================ modificação
/** Base para ferramentas que primeiro pedem objetos */
abstract class ModifyTool extends Tool {
  objs: Entity[] = [];
  picking = false;
  abstract verb: string;
  abstract afterPick(): void;
  start() {
    const sel = this.ed.selected().filter((e) => this.ed.doc.isEditable(e));
    if (sel.length) { this.objs = sel; this.afterPick(); }
    else { this.picking = true; this.ed.selectTool.pickOnly = true; this.say(`${this.verb} — selecione objetos e pressione Enter:`); }
  }
  pointerDown(p: Pt, s: Pt, i: PtrInfo) { if (this.picking) this.ed.selectTool.pointerDown(p, s, i); else this.click(p, i); }
  pointerUp(p: Pt, s: Pt) { if (this.picking) this.ed.selectTool.pointerUp(p, s); }
  move(p: Pt, s: Pt) { if (this.picking) this.ed.selectTool.move(p, s); else this.cur = p; }
  hoverId() { return this.picking ? this.ed.selectTool.hoverId() : null; }
  wantsSnap() { return !this.picking; }
  acceptsPoints() { return !this.picking; }
  private excl: { objs: Entity[]; set: Set<string> } | null = null;
  snapExclude() {
    if (this.excl?.objs !== this.objs) this.excl = { objs: this.objs, set: new Set(this.objs.map((e) => e.id)) };
    return this.excl.set;
  }
  /** matriz da prévia atual (null = sem prévia) */
  protected liveMatrix(): Mat | null { return null; }
  /** poucos objetos: prévia exata (com letras); muitos: os originais desenhados com a matriz */
  /**
   * Com espelhamento, textos e cotas não seguem a matriz (o resultado mantém o texto legível,
   * girado e do outro lado do ponto de inserção): ficam na prévia exata, o resto na matriz.
   */
  private split: { objs: Entity[]; plain: Entity[]; texty: Entity[] } | null = null;
  private parts() {
    if (this.split?.objs !== this.objs) this.split = { objs: this.objs, plain: this.objs.filter((e) => e.type !== 'text' && e.type !== 'dim'), texty: this.objs.filter((e) => e.type === 'text' || e.type === 'dim') };
    return this.split;
  }
  preview(): NewEntity[] {
    const m = this.liveMatrix();
    if (!m) return [];
    if (this.objs.length <= BIG_PREVIEW) return this.xform(m);
    return m[0] * m[3] - m[1] * m[2] < 0 ? this.xform(m, this.parts().texty) : [];
  }
  xformPreview() {
    const m = this.liveMatrix();
    if (!m || this.objs.length <= BIG_PREVIEW) return null;
    return { ents: m[0] * m[3] - m[1] * m[2] < 0 ? this.parts().plain : this.objs, m };
  }
  enter() {
    if (this.picking) {
      this.ed.selectTool.pickOnly = false;
      this.picking = false;
      this.objs = this.ed.selected().filter((e) => this.ed.doc.isEditable(e));
      if (!this.objs.length) { this.done(); return; }
      this.afterPick();
      return;
    }
    this.done();
  }
  cancel() { this.ed.selectTool.pickOnly = false; this.ed.selectTool.cancel(); }
  protected xform(m: Mat, ents = this.objs): NewEntity[] { return ents.map((e) => { const { id: _i, ...r } = transformEntity(e, m); return r as NewEntity; }); }
  protected applyXform(m: Mat, copy: boolean) {
    const ed = this.ed;
    ed.mutate(() => {
      if (copy) for (const e of this.objs) { const { id: _i, ...r } = transformEntity(e, m); ed.add(r as NewEntity); }
      else for (const e of this.objs) ed.doc.replace(transformEntity(e, m));
    });
    if (!copy) ed.setSelection(this.objs.map((e) => e.id));
  }
}

class MoveTool extends ModifyTool {
  id = 'move'; verb = 'MOVER';
  b: Pt | null = null;
  copy = false;
  afterPick() { this.say(`${this.verb} — ponto base:`); }
  base() { return this.b; }
  click(p: Pt) {
    if (!this.b) { this.b = p; this.say(`${this.verb} — segundo ponto${this.copy ? ' (Enter termina)' : ''}:`); return; }
    this.applyXform(translate(p.x - this.b.x, p.y - this.b.y), this.copy);
    if (!this.copy) this.done();
  }
  protected liveMatrix() { return this.b && this.cur ? translate(this.cur.x - this.b.x, this.cur.y - this.b.y) : null; }
  guides() { return this.b && this.cur ? [[this.b, this.cur]] : []; }
  label() { return this.b && this.cur ? `Δ ${formatLen(dist(this.b, this.cur))}` : null; }
}
class CopyTool extends MoveTool { id = 'copy'; verb = 'COPIAR'; copy = true; }

class RotateTool extends ModifyTool {
  id = 'rotate'; verb = 'ROTACIONAR';
  c: Pt | null = null;
  afterPick() { this.say('ROTACIONAR — ponto base:'); }
  base() { return this.c; }
  click(p: Pt) {
    if (!this.c) { this.c = p; this.say('ROTACIONAR — ângulo (clique ou digite em graus):'); return; }
    this.apply(ang(this.c, p));
  }
  apply(a: number) { if (!this.c) return; this.applyXform(rotateAbout(this.c, a), false); this.done(); }
  input(t: string) { if (!this.c) return false; const v = num(t); if (v == null) return false; this.apply((v * Math.PI) / 180); return true; }
  protected liveMatrix() { return this.c && this.cur ? rotateAbout(this.c, ang(this.c, this.cur)) : null; }
  guides() { return this.c && this.cur ? [[this.c, this.cur]] : []; }
  label() { return this.c && this.cur ? `${deg(ang(this.c, this.cur))}°` : null; }
}

class ScaleTool extends ModifyTool {
  id = 'scale'; verb = 'ESCALA';
  c: Pt | null = null;
  ref: number | null = null;
  afterPick() { this.say('ESCALA — ponto base:'); }
  base() { return this.c; }
  click(p: Pt) {
    if (!this.c) { this.c = p; this.say('ESCALA — fator (digite) ou clique um ponto de referência:'); return; }
    if (this.ref == null) { this.ref = Math.max(dist(this.c, p), 1e-9); this.say('ESCALA — clique o novo tamanho da referência:'); return; }
    this.apply(dist(this.c, p) / this.ref);
  }
  apply(k: number) { if (!this.c || k <= 0) return; this.applyXform(scaleAbout(this.c, k), false); this.done(); }
  input(t: string) { if (!this.c) return false; const v = num(t); if (v == null) return false; this.apply(v); return true; }
  factor() { return this.c && this.cur && this.ref ? dist(this.c, this.cur) / this.ref : null; }
  protected liveMatrix() { const k = this.factor(); return k && this.c ? scaleAbout(this.c, k) : null; }
  label() { const k = this.factor(); return k ? `× ${formatLen(k)}` : null; }
}

class MirrorTool extends ModifyTool {
  id = 'mirror'; verb = 'ESPELHAR';
  a: Pt | null = null;
  keep = true;
  afterPick() { this.say('ESPELHAR — primeiro ponto do eixo [A = apagar originais]:'); }
  base() { return this.a; }
  input(t: string) { if (t.toUpperCase() === 'A') { this.keep = false; this.ed.onLog('Originais serão apagados', 'info'); return true; } return false; }
  click(p: Pt) {
    if (!this.a) { this.a = p; this.say('ESPELHAR — segundo ponto do eixo:'); return; }
    if (dist(this.a, p) < 1e-12) return;
    this.applyXform(mirrorAbout(this.a, p), this.keep);
    this.done();
  }
  protected liveMatrix() { return this.a && this.cur && dist(this.a, this.cur) > 1e-12 ? mirrorAbout(this.a, this.cur) : null; }
  guides() { return this.a && this.cur ? [[this.a, this.cur]] : []; }
}

class EraseTool extends ModifyTool {
  id = 'erase'; verb = 'APAGAR';
  afterPick() { this.ed.erase(this.objs); this.done(); }
}

class ExplodeTool extends ModifyTool {
  id = 'explode'; verb = 'EXPLODIR';
  afterPick() {
    const ed = this.ed; let n = 0;
    ed.mutate(() => {
      // apaga todos de uma vez (o resultado é o mesmo de apagar um a um: as partes vão para o fim)
      const all: NewEntity[][] = [], gone = new Set<string>();
      for (const e of this.objs) { const parts = explodeEntity(e); if (!parts) continue; gone.add(e.id); all.push(parts); n++; }
      if (gone.size) ed.doc.remove(gone);
      for (const parts of all) parts.forEach((p) => ed.add(p));
    });
    ed.setSelection([]);
    ed.onLog(n ? `${n} objeto(s) explodido(s)` : 'Nada para explodir (use em polilinhas e cotas)', n ? 'ok' : 'warn');
    this.done();
  }
}

class ArrayTool extends ModifyTool {
  id = 'array'; verb = 'MATRIZ';
  afterPick() { this.say('MATRIZ — digite linhas,colunas,espaçoX,espaçoY (ex.: 3,4,20,20):'); }
  input(t: string) {
    const v = t.split(/[,;\s]+/).map((s) => num(s));
    if (v.length < 4 || v.some((x) => x == null)) return false;
    const [r, c, dx, dy] = v as number[];
    const ed = this.ed;
    ed.mutate(() => {
      for (let i = 0; i < Math.max(1, Math.round(r)); i++) for (let j = 0; j < Math.max(1, Math.round(c)); j++) {
        if (!i && !j) continue;
        for (const e of this.objs) { const { id: _i, ...rest } = transformEntity(e, translate(j * dx, i * dy)); ed.add(rest as NewEntity); }
      }
    });
    this.done(); return true;
  }
}

class OffsetTool extends Tool {
  id = 'offset';
  target: Entity | null = null;
  hover: string | null = null;
  start() { this.say(`DESLOCAR — distância (atual ${formatLen(this.ed.offsetDist)}; digite para mudar) e clique no objeto:`); }
  wantsSnap() { return false; }
  input(t: string) { const v = num(t); if (v == null || v <= 0) return false; this.ed.offsetDist = v; this.start(); return true; }
  click(p: Pt) {
    const ed = this.ed;
    if (!this.target) {
      const e = ed.hit(p, (x) => ed.doc.isEditable(x));
      if (!e) return;
      if (!offsetEntity(e, ed.offsetDist, p)) { ed.onLog('Deslocamento disponível para linhas, círculos, arcos e polilinhas retas', 'warn'); return; }
      this.target = e; this.say('DESLOCAR — clique no lado desejado:'); return;
    }
    const n = offsetEntity(this.target, ed.offsetDist, p);
    if (n) ed.mutate(() => ed.add(n));
    this.target = null; this.say('DESLOCAR — próximo objeto (Enter termina):');
  }
  move(p: Pt) { this.cur = p; if (!this.target) this.hover = this.ed.hit(p)?.id ?? null; }
  hoverId() { return this.target ? this.target.id : this.hover; }
  preview() { if (!this.target || !this.cur) return []; const n = offsetEntity(this.target, this.ed.offsetDist, this.cur); return n ? [n] : []; }
}

class TrimTool extends Tool {
  id = 'trim';
  hover: string | null = null;
  start() { this.say('APARAR — clique na parte a remover (todas as linhas visíveis cortam). Enter termina:'); }
  wantsSnap() { return false; }
  move(p: Pt) { this.hover = this.ed.hit(p, (e) => this.ed.doc.isEditable(e))?.id ?? null; }
  hoverId() { return this.hover; }
  click(p: Pt) {
    const ed = this.ed;
    const e = ed.hit(p, (x) => ed.doc.isEditable(x)); if (!e) return;
    // só o que pode cruzar o objeto (caixas que se tocam), não o desenho inteiro
    const b = cachedBox(e), m = Math.max(b.maxX - b.minX, b.maxY - b.minY, 1e-9) * 1e-6 + 1e-9;
    const cutters = ed.near({ minX: b.minX - m, minY: b.minY - m, maxX: b.maxX + m, maxY: b.maxY + m }).filter((x) => ed.doc.isVisible(x));
    const parts = trimEntity(e, p, cutters);
    if (!parts) { ed.onLog('Nenhuma interseção para aparar aqui', 'warn'); return; }
    ed.renderer.dissolve([e]);
    ed.mutate(() => { ed.doc.remove(new Set([e.id])); for (const q of parts) ed.add(q); });
  }
}

class MeasureTool extends Tool {
  id = 'measure';
  a: Pt | null = null;
  start() { this.say('MEDIR — primeiro ponto:'); }
  base() { return this.a; }
  click(p: Pt) {
    if (!this.a) { this.a = p; this.say('MEDIR — segundo ponto:'); return; }
    const d = dist(this.a, p), dx = p.x - this.a.x, dy = p.y - this.a.y;
    this.ed.onLog(`Distância ${formatLen(d)} · ângulo ${deg(ang(this.a, p))}° · ΔX ${formatLen(dx)} · ΔY ${formatLen(dy)}`, 'ok');
    this.a = null; this.say('MEDIR — primeiro ponto (Enter termina):');
  }
  move(p: Pt) { this.cur = p; }
  guides() { return this.a && this.cur ? [[this.a, this.cur]] : []; }
  label() { return this.a && this.cur ? `${formatLen(dist(this.a, this.cur))} < ${deg(ang(this.a, this.cur))}°` : null; }
}

class AreaTool extends Tool {
  id = 'area';
  pts: Pt[] = [];
  start() { this.say('ÁREA — clique nos vértices; Enter calcula:'); }
  base() { return this.pts[this.pts.length - 1] ?? null; }
  click(p: Pt) { this.pts.push(p); }
  move(p: Pt) { this.cur = p; }
  enter() {
    if (this.pts.length >= 3) {
      let per = 0; for (let i = 0; i < this.pts.length; i++) per += dist(this.pts[i], this.pts[(i + 1) % this.pts.length]);
      this.ed.onLog(`Área ${formatLen(polyArea(this.pts))} · perímetro ${formatLen(per)}`, 'ok');
    }
    this.done();
  }
  preview(): NewEntity[] { return this.pts.length && this.cur ? [{ type: 'poly', layer: this.layer, pts: [...this.pts, this.cur], closed: true }] : []; }
}

// ================================================================ registro de comandos
export interface ToolDef {
  label: string;
  aliases: string[];
  group: 'Desenhar' | 'Modificar' | 'Anotar' | 'Vista' | 'Consultar';
  key?: string;
  make?: (ed: Editor) => Tool;
  action?: (ed: Editor) => void;
}

export const TOOLS: Record<string, ToolDef> = {
  line: { label: 'Linha', aliases: ['L', 'LINE', 'LINHA'], group: 'Desenhar', key: 'L', make: (e) => new LineTool(e) },
  poly: { label: 'Polilinha', aliases: ['PL', 'PLINE', 'POLILINHA'], group: 'Desenhar', key: 'P', make: (e) => new PolyTool(e) },
  rect: { label: 'Retângulo', aliases: ['REC', 'RECTANG', 'RETANGULO', 'RETÂNGULO'], group: 'Desenhar', key: 'R', make: (e) => new RectTool(e) },
  circle: { label: 'Círculo', aliases: ['C', 'CIRCLE', 'CIRCULO', 'CÍRCULO'], group: 'Desenhar', key: 'C', make: (e) => new CircleTool(e) },
  arc: { label: 'Arco', aliases: ['A', 'ARC', 'ARCO'], group: 'Desenhar', key: 'A', make: (e) => new ArcTool(e) },
  ellipse: { label: 'Elipse', aliases: ['EL', 'ELLIPSE', 'ELIPSE'], group: 'Desenhar', make: (e) => new EllipseTool(e) },
  polygon: { label: 'Polígono', aliases: ['POL', 'POLYGON', 'POLIGONO', 'POLÍGONO'], group: 'Desenhar', make: (e) => new PolygonTool(e) },
  point: { label: 'Ponto', aliases: ['PO', 'POINT', 'PONTO'], group: 'Desenhar', make: (e) => new PointTool(e) },
  text: { label: 'Texto', aliases: ['T', 'TEXT', 'DT', 'MT', 'TEXTO'], group: 'Anotar', key: 'T', make: (e) => new TextTool(e) },
  dim: { label: 'Cota', aliases: ['DIM', 'DAL', 'COTA'], group: 'Anotar', key: 'D', make: (e) => new DimTool(e) },
  move: { label: 'Mover', aliases: ['M', 'MOVE', 'MOVER'], group: 'Modificar', key: 'M', make: (e) => new MoveTool(e) },
  copy: { label: 'Copiar', aliases: ['CO', 'CP', 'COPY', 'COPIAR'], group: 'Modificar', make: (e) => new CopyTool(e) },
  rotate: { label: 'Rotacionar', aliases: ['RO', 'ROTATE', 'ROTACIONAR', 'GIRAR'], group: 'Modificar', make: (e) => new RotateTool(e) },
  scale: { label: 'Escala', aliases: ['SC', 'SCALE', 'ESCALA'], group: 'Modificar', make: (e) => new ScaleTool(e) },
  mirror: { label: 'Espelhar', aliases: ['MI', 'MIRROR', 'ESPELHAR'], group: 'Modificar', make: (e) => new MirrorTool(e) },
  offset: { label: 'Deslocar', aliases: ['O', 'OFFSET', 'DESLOCAR', 'EQUIDISTANTE'], group: 'Modificar', make: (e) => new OffsetTool(e) },
  trim: { label: 'Aparar', aliases: ['TR', 'TRIM', 'APARAR', 'CORTAR'], group: 'Modificar', make: (e) => new TrimTool(e) },
  array: { label: 'Matriz', aliases: ['AR', 'ARRAY', 'MATRIZ'], group: 'Modificar', make: (e) => new ArrayTool(e) },
  explode: { label: 'Explodir', aliases: ['X', 'EXPLODE', 'EXPLODIR'], group: 'Modificar', make: (e) => new ExplodeTool(e) },
  erase: { label: 'Apagar', aliases: ['E', 'ERASE', 'APAGAR', 'DEL'], group: 'Modificar', make: (e) => new EraseTool(e) },
  measure: { label: 'Medir', aliases: ['DI', 'DIST', 'MEDIR'], group: 'Anotar', make: (e) => new MeasureTool(e) },
  area: { label: 'Área', aliases: ['AA', 'AREA', 'ÁREA'], group: 'Anotar', make: (e) => new AreaTool(e) },
  extents: { label: 'Enquadrar tudo', aliases: ['Z', 'ZE', 'ZOOM', 'ENQUADRAR'], group: 'Vista', key: 'Z', action: (e) => e.zoomExtents() },
  undo: { label: 'Desfazer', aliases: ['U', 'UNDO', 'DESFAZER'], group: 'Vista', action: (e) => e.undo() },
  redo: { label: 'Refazer', aliases: ['REDO', 'REFAZER'], group: 'Vista', action: (e) => e.redo() },
  all: { label: 'Selecionar tudo', aliases: ['TUDO', 'ALL'], group: 'Vista', action: (e) => e.setSelection(e.doc.d.entities.filter((x) => e.doc.isEditable(x)).map((x) => x.id)) },
};

export function resolveCommand(text: string): string | null {
  const k = text.trim().toUpperCase();
  for (const [id, def] of Object.entries(TOOLS)) if (def.aliases.includes(k) || id.toUpperCase() === k) return id;
  return null;
}
