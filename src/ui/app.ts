import type { Drawing, Entity, Pt } from '../core/types';
import { TYPE_LABEL } from '../core/types';
import { newDrawing, PALETTE } from '../core/doc';
import { demoDrawing } from '../core/demo';
import { dist, entityLength, polyArea, polySegments, sweep, ang, formatLen, TAU, dimGeometry } from '../core/geom';
import { Editor } from '../editor/editor';
import { TOOLS, type ToolDef } from '../editor/tools';
import { openFile, OPEN_ACCEPT } from '../io/import';
import { FORMATS, DEFAULT_EXPORT, download, type ExportOptions } from '../io/export';
import { ICONS } from './icons';

const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;
const $$ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => [...root.querySelectorAll(sel)] as T[];
const h = (html: string) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild as HTMLElement; };
const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const DRAFT_KEY = 'projetalivre:rascunho';

export class App {
  ed: Editor;
  private history: string[] = [];
  private histIdx = -1;
  private exportFmt = 'dxf';
  private exportOpts: ExportOptions = { ...DEFAULT_EXPORT };
  private saveTimer = 0;

  constructor() {
    this.ed = new Editor($<HTMLCanvasElement>('#cv'));
    this.ed.renderer.resize();
    this.buildDock();
    this.buildActions();
    this.buildInspector();
    this.buildConsole();
    this.buildPortal();
    this.buildExport();
    this.buildHelp();
    this.bindFiles();
    this.bindKeys();
    this.wireEditor();
    this.ed.updatePrompt();
  }

  // ================================================================ editor → UI
  private wireEditor() {
    const ed = this.ed;
    ed.onPrompt = (t) => { const p = $('#prompt'); p.textContent = t; p.classList.remove('typing'); void p.offsetWidth; p.classList.add('typing'); };
    ed.onLog = (t, kind = 'info') => this.log(t, kind);
    ed.onSelection = () => this.renderProps();
    ed.onDocChange = () => { this.renderLayers(); this.renderProps(); this.markDirty(); };
    ed.onTool = (id) => $$('.hex').forEach((b) => b.classList.toggle('on', b.dataset.tool === id));
    ed.onCursor = (p) => { $('#coords').textContent = `X ${fmt(p.x)} · Y ${fmt(p.y)}`; };
    ed.askText = (screen, initial) => this.askText(screen, initial);
    ed.onContextMenu = (sp) => this.openRadial(sp);
  }

  private log(text: string, kind: string) {
    const ol = $('#log');
    const li = document.createElement('li');
    li.className = kind; li.textContent = text;
    ol.appendChild(li);
    while (ol.children.length > 7) ol.firstElementChild!.remove();
  }

  toast(title: string, kind: 'ok' | 'warn' | 'info' = 'info', sub = '') {
    const t = h(`<div class="toast ${kind}">${escapeHtml(title)}${sub ? `<small>${escapeHtml(sub)}</small>` : ''}</div>`);
    $('#toasts').appendChild(t);
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 450); }, 3200);
  }

  private markDirty() {
    $('#dirty-dot').classList.toggle('on', this.ed.doc.dirty);
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      // desenhos enormes não cabem no armazenamento do navegador e travariam a serialização
      if (this.ed.doc.d.entities.length > 25000) { try { localStorage.removeItem(DRAFT_KEY); } catch { /* sem armazenamento */ } return; }
      try { localStorage.setItem(DRAFT_KEY, JSON.stringify(this.ed.doc.d)); } catch { /* rascunho grande demais ou armazenamento bloqueado */ }
    }, 800);
  }

  // ================================================================ dock
  private buildDock() {
    const dock = $('#dock');
    const groups: Record<string, [string, ToolDef | null][]> = {};
    groups['Desenhar'] = [['select', null]];
    for (const [id, def] of Object.entries(TOOLS)) {
      if (def.group === 'Vista') continue;
      (groups[def.group] ??= []).push([id, def]);
    }
    for (const [name, list] of Object.entries(groups)) {
      const g = h(`<div class="dock-group"><h3>${name}</h3></div>`);
      for (const [id, def] of list) {
        const label = def?.label ?? 'Selecionar';
        const key = def?.key ?? (id === 'select' ? 'Esc' : '');
        const b = h(`<button class="hex${id === 'select' ? ' on' : ''}" data-tool="${id}" aria-label="${label}">${ICONS[id] ?? ''}${key && key.length === 1 ? `<span class="key">${key}</span>` : ''}</button>`);
        b.addEventListener('click', () => { if (id === 'select') this.ed.setTool(null); else this.ed.startCommand(id); this.focusCanvas(); });
        this.tape(b, label, def ? def.aliases[0] : 'Esc');
        g.appendChild(b);
      }
      dock.appendChild(g);
    }
  }

  private tape(el: HTMLElement, label: string, kbd: string) {
    let t: HTMLElement | null = null;
    el.addEventListener('pointerenter', () => {
      const r = el.getBoundingClientRect();
      t = h(`<div class="tape">${escapeHtml(label)}<kbd>${escapeHtml(kbd)}</kbd></div>`);
      t.style.left = `${r.right + 8}px`; t.style.top = `${r.top + r.height / 2 - 15}px`;
      document.body.appendChild(t);
    });
    el.addEventListener('pointerleave', () => { t?.remove(); t = null; });
    el.addEventListener('click', () => { t?.remove(); t = null; });
  }

  private buildActions() {
    const icon: Record<string, string> = { open: 'open', save: 'save', undo: 'undo', redo: 'redo', fit: 'extents', theme: 'sun', help: 'help' };
    $$('.act').forEach((b) => {
      const a = b.dataset.act!;
      b.insertAdjacentHTML('afterbegin', ICONS[icon[a]]);
      b.addEventListener('click', () => this.action(a));
    });
    $('#btn-home').addEventListener('click', () => this.showPortal());
    const name = $<HTMLInputElement>('#doc-name');
    name.addEventListener('change', () => { this.ed.doc.d.name = name.value.trim() || 'Sem título'; this.markDirty(); });
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') name.blur(); e.stopPropagation(); });
  }

  private action(a: string) {
    switch (a) {
      case 'open': $<HTMLInputElement>('#file').click(); break;
      case 'save': this.openExport(); break;
      case 'undo': this.ed.undo(); break;
      case 'redo': this.ed.redo(); break;
      case 'fit': this.ed.zoomExtents(); break;
      case 'theme': this.toggleTheme(); break;
      case 'help': $<HTMLDialogElement>('#help').showModal(); break;
    }
  }

  private toggleTheme() {
    const root = document.documentElement;
    const paper = root.dataset.theme !== 'paper';
    root.dataset.theme = paper ? 'paper' : 'ink';
    this.ed.renderer.paper = paper; this.ed.renderer.dirty = true;
    const b = $('[data-act="theme"]'); b.querySelector('svg')?.remove(); b.insertAdjacentHTML('afterbegin', ICONS[paper ? 'moon' : 'sun']);
    try { localStorage.setItem('projetalivre:tema', root.dataset.theme); } catch { /* sem armazenamento */ }
    this.toast(paper ? 'Modo papel' : 'Modo tinta', 'info');
  }

  // ================================================================ inspector
  private buildInspector() {
    $$('.tab').forEach((t) => t.addEventListener('click', () => {
      const insp = $('#inspector');
      if (t.classList.contains('on') && !insp.classList.contains('collapsed')) { insp.classList.add('collapsed'); return; }
      insp.classList.remove('collapsed'); insp.classList.add('open');
      $$('.tab').forEach((x) => x.classList.toggle('on', x === t));
      $$('[data-panel]').forEach((p) => (p.hidden = p.dataset.panel !== t.dataset.tab));
    }));
    $('#layer-add').innerHTML = ICONS.plus;
    $('#layer-add').addEventListener('click', () => {
      const doc = this.ed.doc;
      let n = doc.d.layers.length, name = `Camada ${n}`;
      while (doc.layer(name)) name = `Camada ${++n}`;
      this.ed.mutate(() => { doc.ensureLayer(name, PALETTE[n % PALETTE.length]); doc.d.current = name; });
      this.toast(`Camada “${name}” criada`, 'ok');
    });
    this.renderLayers();
    this.renderProps();
  }

  private renderLayers() {
    const doc = this.ed.doc;
    const ul = $('#layer-list');
    const counts = new Map<string, number>();
    for (const e of doc.d.entities) counts.set(e.layer, (counts.get(e.layer) ?? 0) + 1);
    ul.innerHTML = '';
    doc.d.layers.forEach((l, i) => {
      const li = h(`<li class="layer${l.name === doc.d.current ? ' current' : ''}${l.visible ? '' : ' hidden-layer'}" style="animation-delay:${i * 25}ms">
        <label class="swatch" style="background:${l.color}" title="Cor da camada"><input type="color" value="${l.color}"></label>
        <input class="layer-name" value="${escapeHtml(l.name)}" ${l.name === '0' ? 'readonly' : ''} title="Clique para tornar atual; duplo clique para renomear">
        <button class="ic${l.visible ? ' active' : ''}" data-a="vis" title="Mostrar/ocultar">${l.visible ? ICONS.eye : ICONS.eyeOff}</button>
        <button class="ic${l.locked ? ' active' : ''}" data-a="lock" title="Travar">${l.locked ? ICONS.lock : ICONS.unlock}</button>
        <button class="ic" data-a="del" title="Apagar camada" ${l.name === '0' ? 'disabled style="opacity:.25"' : ''}>${ICONS.trash}</button>
        <span class="count">${counts.get(l.name) ?? 0} obj.</span>
      </li>`);
      const name = $<HTMLInputElement>('.layer-name', li);
      name.readOnly = true;
      li.addEventListener('click', (ev) => {
        if ((ev.target as HTMLElement).closest('button,.swatch')) return;
        if (doc.d.current !== l.name) { doc.d.current = l.name; this.renderLayers(); this.log(`Camada atual: ${l.name}`, 'info'); }
      });
      name.addEventListener('dblclick', () => { if (l.name !== '0') { name.readOnly = false; name.select(); } });
      name.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') name.blur(); if (e.key === 'Escape') { name.value = l.name; name.blur(); } });
      name.addEventListener('blur', () => {
        name.readOnly = true;
        const nv = name.value.trim();
        if (!nv || nv === l.name) { name.value = l.name; return; }
        if (doc.layer(nv)) { this.toast('Já existe uma camada com esse nome', 'warn'); name.value = l.name; return; }
        const old = l.name;
        this.ed.mutate(() => {
          const L = doc.layer(old)!; L.name = nv;
          doc.d.entities = doc.d.entities.map((e) => (e.layer === old ? { ...e, layer: nv } : e));
          if (doc.d.current === old) doc.d.current = nv;
        });
      });
      $<HTMLInputElement>('.swatch input', li).addEventListener('change', (e) => {
        const v = (e.target as HTMLInputElement).value;
        this.ed.mutate(() => { doc.layer(l.name)!.color = v; });
      });
      li.querySelectorAll<HTMLButtonElement>('button[data-a]').forEach((b) => b.addEventListener('click', () => {
        const a = b.dataset.a;
        if (a === 'vis') this.ed.mutate(() => { const L = doc.layer(l.name)!; L.visible = !L.visible; });
        if (a === 'lock') this.ed.mutate(() => { const L = doc.layer(l.name)!; L.locked = !L.locked; });
        if (a === 'del') {
          const n = counts.get(l.name) ?? 0;
          if (n && !confirm(`Apagar a camada “${l.name}” e seus ${n} objeto(s)?`)) return;
          this.ed.mutate(() => {
            doc.d.entities = doc.d.entities.filter((e) => e.layer !== l.name);
            doc.d.layers = doc.d.layers.filter((x) => x.name !== l.name);
            if (doc.d.current === l.name) doc.d.current = '0';
          });
        }
      }));
      ul.appendChild(li);
    });
  }

  private renderProps() {
    const ed = this.ed, doc = ed.doc;
    const sel = ed.selected();
    $('#sel-count').textContent = String(sel.length);
    const box = $('#props');
    box.innerHTML = '';
    if (!sel.length) {
      const total = doc.d.entities.length;
      box.innerHTML = `<p class="empty">Nada selecionado.<br>Clique em um objeto ou arraste uma janela:<br><b>esquerda → direita</b> seleciona o que está dentro;<br><b>direita → esquerda</b> pega o que cruza.</p>
        <div class="stat"><span>objetos no desenho</span><b>${total}</b></div><div class="stat"><span>camadas</span><b>${doc.d.layers.length}</b></div>`;
      return;
    }
    const layerOpts = (cur: string) => doc.d.layers.map((l) => `<option ${l.name === cur ? 'selected' : ''}>${escapeHtml(l.name)}</option>`).join('');
    const common = (e: Entity | null) => {
      const lay = e ? e.layer : sel.every((x) => x.layer === sel[0].layer) ? sel[0].layer : '';
      const byLayer = e ? !e.color : sel.every((x) => !x.color);
      const color = e?.color ?? sel.find((x) => x.color)?.color ?? doc.colorOf(sel[0]);
      const frag = h(`<div class="props">
        <label class="field"><span>Camada</span><select data-k="layer">${lay ? '' : '<option selected disabled>— várias —</option>'}${layerOpts(lay)}</select></label>
        <label class="field"><span>Cor</span><div class="row"><input type="color" data-k="color" value="${color}"><select data-k="bylayer"><option value="1" ${byLayer ? 'selected' : ''}>da camada</option><option value="0" ${byLayer ? '' : 'selected'}>própria</option></select></div></label>
      </div>`);
      $<HTMLSelectElement>('[data-k=layer]', frag).addEventListener('change', (ev) => {
        const v = (ev.target as HTMLSelectElement).value;
        ed.mutate(() => sel.forEach((x) => doc.replace({ ...x, layer: v })));
      });
      $<HTMLInputElement>('[data-k=color]', frag).addEventListener('change', (ev) => {
        const v = (ev.target as HTMLInputElement).value;
        ed.mutate(() => sel.forEach((x) => doc.replace({ ...x, color: v })));
      });
      $<HTMLSelectElement>('[data-k=bylayer]', frag).addEventListener('change', (ev) => {
        const by = (ev.target as HTMLSelectElement).value === '1';
        const v = $<HTMLInputElement>('[data-k=color]', frag).value;
        ed.mutate(() => sel.forEach((x) => { const n = { ...x }; if (by) delete n.color; else n.color = v; doc.replace(n); }));
      });
      return frag;
    };

    if (sel.length > 1) {
      const by = new Map<string, number>();
      sel.forEach((e) => by.set(TYPE_LABEL[e.type], (by.get(TYPE_LABEL[e.type]) ?? 0) + 1));
      box.appendChild(h(`<span class="type-chip">${sel.length} objetos</span>`));
      for (const [k, v] of by) box.appendChild(h(`<div class="stat"><span>${k}</span><b>${v}</b></div>`));
      box.appendChild(common(null));
      box.appendChild(this.selButtons());
      return;
    }

    const e = sel[0];
    box.appendChild(h(`<span class="type-chip">${TYPE_LABEL[e.type]}</span>`));
    box.appendChild(common(e));
    const fields: [string, string, number | string, (v: string) => Entity | null][] = [];
    const n = (v: string) => { const x = parseFloat(v.replace(',', '.')); return isFinite(x) ? x : null; };
    const P = (label: string, p: Pt, set: (p: Pt) => Entity) => {
      fields.push([`${label} X`, 'num', p.x, (v) => (n(v) == null ? null : set({ x: n(v)!, y: p.y }))]);
      fields.push([`${label} Y`, 'num', p.y, (v) => (n(v) == null ? null : set({ x: p.x, y: n(v)! }))]);
    };
    const stats: [string, string][] = [];
    const deg = (r: number) => (r * 180) / Math.PI;
    switch (e.type) {
      case 'line':
        P('Início', e.a, (a) => ({ ...e, a })); P('Fim', e.b, (b) => ({ ...e, b }));
        stats.push(['comprimento', formatLen(dist(e.a, e.b))], ['ângulo', `${formatLen(deg(ang(e.a, e.b)))}°`]);
        break;
      case 'circle':
        P('Centro', e.c, (c) => ({ ...e, c }));
        fields.push(['Raio', 'num', e.r, (v) => (n(v)! > 0 ? { ...e, r: n(v)! } : null)]);
        stats.push(['diâmetro', formatLen(e.r * 2)], ['perímetro', formatLen(TAU * e.r)], ['área', formatLen(Math.PI * e.r * e.r)]);
        break;
      case 'arc':
        P('Centro', e.c, (c) => ({ ...e, c }));
        fields.push(['Raio', 'num', e.r, (v) => (n(v)! > 0 ? { ...e, r: n(v)! } : null)]);
        fields.push(['Início °', 'num', +deg(e.start).toFixed(4), (v) => (n(v) == null ? null : { ...e, start: (n(v)! * Math.PI) / 180 })]);
        fields.push(['Fim °', 'num', +deg(e.end).toFixed(4), (v) => (n(v) == null ? null : { ...e, end: (n(v)! * Math.PI) / 180 })]);
        stats.push(['comprimento', formatLen(e.r * sweep(e.start, e.end))]);
        break;
      case 'ellipse':
        P('Centro', e.c, (c) => ({ ...e, c }));
        fields.push(['Razão', 'num', +e.ratio.toFixed(6), (v) => (n(v)! > 0 && n(v)! <= 1 ? { ...e, ratio: n(v)! } : null)]);
        stats.push(['semi-eixo maior', formatLen(Math.hypot(e.major.x, e.major.y))]);
        break;
      case 'poly': {
        fields.push(['Fechada', 'bool', e.closed ? 1 : 0, (v) => ({ ...e, closed: v === '1' })]);
        stats.push(['vértices', String(e.pts.length)], ['comprimento', formatLen(entityLength(e))]);
        if (e.closed) stats.push(['área', formatLen(polyArea(polySegments(e, 20)))]);
        break;
      }
      case 'text':
        fields.push(['Texto', 'text', e.text, (v) => (v.trim() ? { ...e, text: v } : null)]);
        P('Posição', e.p, (p) => ({ ...e, p }));
        fields.push(['Altura', 'num', e.h, (v) => (n(v)! > 0 ? { ...e, h: n(v)! } : null)]);
        fields.push(['Rotação °', 'num', +deg(e.rot).toFixed(4), (v) => (n(v) == null ? null : { ...e, rot: (n(v)! * Math.PI) / 180 })]);
        break;
      case 'point': P('Posição', e.p, (p) => ({ ...e, p })); break;
      case 'dim':
        stats.push(['valor medido', formatLen(dist(e.a, e.b))]);
        P('Ponto 1', e.a, (a) => ({ ...e, a })); P('Ponto 2', e.b, (b) => ({ ...e, b }));
        fields.push(['Altura txt', 'num', +(e.h ?? dimGeometry(e).text.h).toFixed(4), (v) => (n(v)! > 0 ? { ...e, h: n(v)! } : null)]);
        break;
    }
    for (const [label, kind, value, set] of fields) {
      const id = 'f' + Math.random().toString(36).slice(2);
      const input = kind === 'text' ? `<textarea id="${id}" rows="2">${escapeHtml(String(value))}</textarea>`
        : kind === 'bool' ? `<select id="${id}"><option value="1" ${value ? 'selected' : ''}>sim</option><option value="0" ${value ? '' : 'selected'}>não</option></select>`
        : `<input id="${id}" type="number" step="any" value="${+(+value).toFixed(4)}">`;
      const f = h(`<label class="field"><span>${label}</span>${input}</label>`);
      const el = f.querySelector<HTMLInputElement>('input,textarea,select')!;
      el.addEventListener('keydown', (ev) => { ev.stopPropagation(); if (ev.key === 'Enter' && kind !== 'text') el.blur(); });
      el.addEventListener('change', () => { const ne = set(el.value); if (ne) ed.mutate(() => doc.replace(ne)); else this.renderProps(); });
      box.appendChild(f);
    }
    for (const [k, v] of stats) box.appendChild(h(`<div class="stat"><span>${k}</span><b>${v}</b></div>`));
    box.appendChild(this.selButtons());
  }

  private selButtons() {
    const row = h(`<div class="field" style="grid-template-columns:1fr 1fr 1fr"><button class="btn-line" data-c="copy">Copiar</button><button class="btn-line" data-c="move">Mover</button><button class="btn-line danger" data-c="erase">Apagar</button></div>`);
    row.querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.addEventListener('click', () => { this.ed.startCommand(b.dataset.c!); this.focusCanvas(); }));
    return row;
  }

  // ================================================================ console
  private buildConsole() {
    const cmd = $<HTMLInputElement>('#cmd');
    cmd.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter' || (ev.key === ' ' && !(this.ed.tool.id === 'text'))) {
        ev.preventDefault();
        const v = cmd.value; cmd.value = '';
        if (v.trim()) { this.history.push(v); this.histIdx = this.history.length; }
        this.ed.runCommand(v);
        if (v.trim().toUpperCase() === 'AJUDA' || v.trim() === '?') { $<HTMLDialogElement>('#help').showModal(); }
      } else if (ev.key === 'Escape') { cmd.value = ''; this.escape(); cmd.blur(); }
      else if (ev.key === 'ArrowUp') { ev.preventDefault(); if (this.histIdx > 0) cmd.value = this.history[--this.histIdx]; }
      else if (ev.key === 'ArrowDown') { ev.preventDefault(); if (this.histIdx < this.history.length - 1) cmd.value = this.history[++this.histIdx]; else { this.histIdx = this.history.length; cmd.value = ''; } }
      else if ((ev.ctrlKey || ev.metaKey) && /^[zyso]$/i.test(ev.key)) { cmd.blur(); this.onKey(ev); }
    });
    $$('.knob').forEach((k) => k.addEventListener('click', () => this.toggle(k.dataset.toggle!)));
  }

  toggle(what: string) {
    const ed = this.ed;
    let on = false;
    if (what === 'osnap') on = ed.snap.osnap = !ed.snap.osnap;
    if (what === 'grid') {
      on = ed.snap.grid = !ed.snap.grid;
      if (on) { const g = ed.niceTextHeight() * 2; ed.snap.gridStep = g; this.log(`Snap à grade: passo ${formatLen(g)}`, 'info'); }
    }
    if (what === 'ortho') on = ed.ortho = !ed.ortho;
    if (what === 'showgrid') { on = ed.renderer.showGrid = !ed.renderer.showGrid; ed.renderer.dirty = true; }
    $(`.knob[data-toggle="${what}"]`).classList.toggle('on', on);
    const names: Record<string, string> = { osnap: 'Snap a objetos', grid: 'Snap à grade', ortho: 'Modo orto', showgrid: 'Grade visível' };
    this.log(`${names[what]}: ${on ? 'ligado' : 'desligado'}`, on ? 'ok' : 'info');
  }

  private escape() {
    $('#radial').hidden = true;
    if (this.ed.tool === this.ed.selectTool) this.ed.selectTool.cancel(); else { this.ed.setTool(null); this.log('*Cancelado*', 'warn'); }
  }

  private focusCanvas() { $<HTMLInputElement>('#cmd').blur(); }

  // ================================================================ teclado
  private bindKeys() {
    window.addEventListener('keydown', (ev) => this.onKey(ev));
  }

  private onKey(ev: KeyboardEvent) {
    if (!$('#portal').classList.contains('gone')) return;
    if (document.querySelector('dialog[open]')) return;
    const target = ev.target as HTMLElement;
    if (target.matches('input,textarea,select') && target.id !== 'cmd') return;
    const ctrl = ev.ctrlKey || ev.metaKey;
    const k = ev.key.toLowerCase();
    if (ctrl && k === 'z') { ev.preventDefault(); ev.shiftKey ? this.ed.redo() : this.ed.undo(); return; }
    if (ctrl && k === 'y') { ev.preventDefault(); this.ed.redo(); return; }
    if (ctrl && k === 's') { ev.preventDefault(); this.openExport(); return; }
    if (ctrl && k === 'o') { ev.preventDefault(); $<HTMLInputElement>('#file').click(); return; }
    if (ctrl && k === 'a') { ev.preventDefault(); this.ed.startCommand('all'); return; }
    if (ctrl && k === 'c') { this.clip = this.ed.selected().map((e) => structuredClone(e)); if (this.clip.length) this.log(`${this.clip.length} objeto(s) copiado(s)`, 'info'); return; }
    if (ctrl && k === 'v') { this.paste(); return; }
    if (ev.key === 'Escape') { this.escape(); return; }
    if (ev.key === 'Delete' || ev.key === 'Backspace') { if (this.ed.selection.size && this.ed.tool === this.ed.selectTool) { ev.preventDefault(); this.ed.erase(this.ed.selected()); } return; }
    if (ev.key === 'F1') { ev.preventDefault(); $<HTMLDialogElement>('#help').showModal(); return; }
    if (ev.key === 'F3') { ev.preventDefault(); this.toggle('osnap'); return; }
    if (ev.key === 'F7') { ev.preventDefault(); this.toggle('showgrid'); return; }
    if (ev.key === 'F8') { ev.preventDefault(); this.toggle('ortho'); return; }
    if (ev.key === 'F9') { ev.preventDefault(); this.toggle('grid'); return; }
    if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); this.ed.runCommand(''); return; }
    if (ctrl || ev.altKey || ev.key.length !== 1) return;
    // digitar em qualquer lugar vai para a linha de comando (como no AutoCAD)
    const cmd = $<HTMLInputElement>('#cmd');
    if (document.activeElement !== cmd) { cmd.focus(); }
  }

  private clip: Entity[] = [];
  private paste() {
    if (!this.clip.length) return;
    const ed = this.ed;
    const k = 20 / ed.view.s;
    const ids: string[] = [];
    ed.mutate(() => {
      for (const e of this.clip) {
        const { id: _id, ...rest } = e;
        const moved = JSON.parse(JSON.stringify(rest), (key, v) => (v && typeof v === 'object' && 'x' in v && 'y' in v && Object.keys(v).length === 2 && !['major'].includes(key) ? { x: v.x + k, y: v.y - k } : v));
        ids.push(ed.add(moved).id);
      }
    });
    ed.setSelection(ids);
    this.log(`${ids.length} objeto(s) colado(s)`, 'ok');
  }

  // ================================================================ menu radial
  private openRadial(sp: Pt) {
    const r = $('#radial');
    const rect = this.ed.canvas.getBoundingClientRect();
    const x = Math.min(Math.max(sp.x + rect.left, 110), innerWidth - 110), y = Math.min(Math.max(sp.y + rect.top, 110), innerHeight - 110);
    const sel = this.ed.selection.size > 0;
    const items = sel ? ['move', 'copy', 'rotate', 'scale', 'mirror', 'offset', 'explode', 'erase'] : ['line', 'poly', 'rect', 'circle', 'arc', 'text', 'dim', 'extents'];
    r.innerHTML = `<div class="core">${sel ? 'EDITAR' : 'CRIAR'}</div>`;
    items.forEach((id, i) => {
      const a = -Math.PI / 2 + (i / items.length) * Math.PI * 2, R = 88;
      const b = h(`<button class="petal" style="--x:${Math.cos(a) * R}px;--y:${Math.sin(a) * R}px;--i:${i}">${ICONS[id]}<small>${TOOLS[id].label}</small></button>`);
      b.addEventListener('click', () => { r.hidden = true; this.ed.startCommand(id); });
      r.appendChild(b);
    });
    r.style.left = `${x}px`; r.style.top = `${y}px`;
    r.hidden = false;
    const close = (ev: PointerEvent) => { if (!r.contains(ev.target as Node)) { r.hidden = true; window.removeEventListener('pointerdown', close, true); } };
    setTimeout(() => window.addEventListener('pointerdown', close, true));
  }

  // ================================================================ texto flutuante
  private askText(screen: Pt, initial: string): Promise<string | null> {
    return new Promise((resolve) => {
      const rect = this.ed.canvas.getBoundingClientRect();
      const box = h(`<div class="float-text"><textarea placeholder="Digite o texto…">${escapeHtml(initial)}</textarea><small>Enter confirma · Shift+Enter nova linha · Esc cancela</small></div>`);
      box.style.left = `${Math.min(screen.x + rect.left + 12, innerWidth - 300)}px`;
      box.style.top = `${Math.min(screen.y + rect.top - 20, innerHeight - 140)}px`;
      document.body.appendChild(box);
      const ta = box.querySelector('textarea')!;
      setTimeout(() => ta.focus());
      const finish = (v: string | null) => { box.remove(); resolve(v); };
      ta.addEventListener('keydown', (ev) => {
        ev.stopPropagation();
        if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); finish(ta.value); }
        if (ev.key === 'Escape') finish(null);
      });
      ta.addEventListener('blur', () => setTimeout(() => { if (box.isConnected) finish(ta.value); }, 120));
    });
  }

  // ================================================================ arquivos
  private bindFiles() {
    const input = $<HTMLInputElement>('#file');
    input.accept = OPEN_ACCEPT;
    input.addEventListener('change', () => { const f = input.files?.[0]; if (f) this.open(f); input.value = ''; });
    const dz = $('#dropzone');
    let depth = 0;
    window.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types.includes('Files')) { depth++; dz.hidden = false; } });
    window.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; dz.hidden = true; } });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
      e.preventDefault(); depth = 0; dz.hidden = true;
      const f = e.dataTransfer?.files?.[0]; if (f) this.open(f);
    });
    window.addEventListener('beforeunload', (e) => { if (this.ed.doc.dirty) { e.preventDefault(); } });
  }

  private opening: AbortController | null = null;

  async open(file: File) {
    if (this.opening) this.opening.abort();
    const ctrl = (this.opening = new AbortController());
    const busy = $('#busy');
    const mb = file.size / 1048576;
    $('#busy-file').textContent = `${file.name} · ${mb >= 1 ? mb.toFixed(1).replace('.', ',') + ' MB' : Math.ceil(file.size / 1024) + ' KB'}`;
    const setStage = (stage: string, pct: number) => {
      $('#busy-stage').textContent = stage;
      $('#busy-bar').style.width = `${Math.max(2, Math.min(100, pct))}%`;
      $('#busy-pct').textContent = `${Math.round(pct)}%`;
    };
    setStage('Preparando…', 1);
    busy.hidden = false;
    const t0 = performance.now();
    const clock = setInterval(() => { $('#busy-time').textContent = `${((performance.now() - t0) / 1000).toFixed(1).replace('.', ',')} s`; }, 100);
    const cancel = $('#busy-cancel');
    cancel.onclick = () => ctrl.abort();
    const frame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r)));
    try {
      await frame();
      const { drawing: d, skipped } = await openFile(file, setStage, ctrl.signal);
      if (ctrl.signal.aborted) return;
      setStage(`Montando o desenho… ${d.entities.length.toLocaleString('pt-BR')} objetos`, 97);
      await frame();
      this.load(d);
      const ms = Math.round(performance.now() - t0);
      this.toast(`${file.name} aberto`, 'ok', `${d.entities.length.toLocaleString('pt-BR')} objetos · ${d.layers.length} camadas · ${(ms / 1000).toFixed(1).replace('.', ',')} s`);
      this.log(`Aberto: ${file.name} (${d.entities.length} objetos)`, 'ok');
      // transparência: o que existe no arquivo mas ainda não é desenhado
      const miss = Object.entries(skipped).sort((p, q) => q[1] - p[1]);
      if (miss.length) {
        const txt = miss.map(([t, n]) => `${n}× ${t}`).join(', ');
        this.log(`Não exibidos: ${txt}`, 'warn');
        setTimeout(() => this.toast('Alguns objetos do arquivo não puderam ser exibidos', 'warn', txt), 600);
      }
      if (d.layers.some((l) => l.name === 'Folha (layout)')) this.log('Conteúdo dos layouts (folha) colocado à direita do desenho, na camada “Folha (layout)”.', 'info');
      const used = new Set(d.entities.map((e) => e.layer));
      const hidden = d.layers.filter((l) => !l.visible && used.has(l.name));
      if (hidden.length) this.log(`${hidden.length} camada(s) desligada(s)/congelada(s) no arquivo original — ative no painel Camadas para ver tudo.`, 'info');
    } catch (err) {
      if ((err as Error).name === 'AbortError') { this.toast('Abertura cancelada', 'info'); return; }
      console.error(err);
      this.toast('Não foi possível abrir o arquivo', 'warn', (err as Error).message);
    } finally {
      clearInterval(clock);
      if (this.opening === ctrl) { this.opening = null; busy.hidden = true; }
    }
  }

  load(d: Drawing) {
    this.ed.setTool(null);
    this.ed.setSelection([]);
    this.ed.doc.load(d);
    $<HTMLInputElement>('#doc-name').value = d.name;
    this.hidePortal();
    this.ed.renderer.resize();
    this.ed.zoomExtents(true, 0.6);
    this.markDirty();
  }

  // ================================================================ exportar
  private buildExport() {
    const box = $('#formats');
    FORMATS.forEach((f, i) => {
      const kind = { vector: 'vetor', raster: 'imagem', machine: 'máquina', data: 'dados' }[f.kind];
      const b = h(`<button type="button" class="fmt${f.ext === this.exportFmt ? ' on' : ''}" style="--i:${i}" data-ext="${f.ext}"><span class="kind">${kind}</span><span class="ext">.${f.ext}</span><span class="lbl">${f.label}</span><small>${f.desc}</small></button>`);
      b.addEventListener('click', () => { this.exportFmt = f.ext; $$('.fmt').forEach((x) => x.classList.toggle('on', x === b)); this.renderExportOptions(); });
      b.addEventListener('dblclick', () => this.doExport());
      box.appendChild(b);
    });
    $('#export .mini').innerHTML = ICONS.close;
    $('#do-export').addEventListener('click', () => this.doExport());
    this.renderExportOptions();
  }

  private openExport() {
    const dlg = $<HTMLDialogElement>('#export');
    // reinicia a animação dos cartões
    $$('.fmt').forEach((f) => { f.style.animation = 'none'; void f.offsetWidth; f.style.animation = ''; });
    this.renderExportOptions();
    dlg.showModal();
  }

  private renderExportOptions() {
    const o = this.exportOpts, f = FORMATS.find((x) => x.ext === this.exportFmt)!;
    const box = $('#fmt-options');
    box.innerHTML = '';
    const seg = (label: string, key: keyof ExportOptions, opts: [string, string][]) => {
      const el = h(`<div class="field"><span>${label}</span><div class="seg">${opts.map(([v, t]) => `<button type="button" data-v="${v}" class="${String(o[key]) === v ? 'on' : ''}">${t}</button>`).join('')}</div></div>`);
      el.querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.addEventListener('click', () => {
        const v = b.dataset.v!;
        (o as any)[key] = typeof o[key] === 'number' ? +v : typeof o[key] === 'boolean' ? v === 'true' : v;
        this.renderExportOptions();
      }));
      box.appendChild(el);
    };
    const numField = (label: string, key: keyof ExportOptions, min: number, step = 1) => {
      const el = h(`<label class="field"><span>${label}</span><input type="number" min="${min}" step="${step}" value="${o[key]}"></label>`);
      el.querySelector('input')!.addEventListener('change', (ev) => { const v = +(ev.target as HTMLInputElement).value; if (isFinite(v) && v >= min) (o as any)[key] = v; });
      el.querySelector('input')!.addEventListener('keydown', (ev) => ev.stopPropagation());
      box.appendChild(el);
    };
    const notes: Record<string, string> = {
      plv: 'Formato nativo: guarde para continuar editando exatamente de onde parou.',
      dxf: 'DXF é o formato de troca do AutoCAD. Para DWG, abra este DXF no AutoCAD/LibreCAD e salve como .dwg.',
      svg: 'Camadas viram grupos <g> com o mesmo nome.',
      pdf: 'Escala 1:N considera as unidades do desenho em milímetros.',
      png: 'Resolução = pixels do lado maior.', jpg: 'Resolução = pixels do lado maior.', webp: 'Resolução = pixels do lado maior.',
      plt: 'Uma pena (SP) por camada. 1 unidade = 1 mm.',
      gcode: 'Origem no canto inferior esquerdo do desenho. 1 unidade = 1 mm. Confira na sua máquina antes de cortar!',
      geojson: 'Coordenadas do desenho são gravadas sem reprojeção.',
    };
    $('#fmt-note').textContent = notes[f.ext] ?? '';
    if (['svg', 'png', 'jpg', 'webp', 'pdf'].includes(f.ext)) seg('Fundo', 'background', f.ext === 'jpg' || f.ext === 'pdf' ? [['light', 'Claro'], ['dark', 'Escuro']] : [['light', 'Claro'], ['dark', 'Escuro'], ['transparent', 'Transparente']]);
    if (f.kind === 'raster') seg('Pixels', 'pixels', [['1600', '1600'], ['3000', '3000'], ['6000', '6000'], ['10000', '10000']]);
    if (f.ext === 'pdf') {
      seg('Folha', 'paper', [['A4', 'A4'], ['A3', 'A3'], ['A2', 'A2'], ['A1', 'A1'], ['A0', 'A0']]);
      seg('Orientação', 'orientation', [['landscape', 'Paisagem'], ['portrait', 'Retrato']]);
      seg('Escala', 'pdfScale', [['0', 'Ajustar'], ['1', '1:1'], ['20', '1:20'], ['50', '1:50'], ['100', '1:100']]);
    }
    if (f.ext === 'gcode') { seg('Máquina', 'laser', [['true', 'Laser'], ['false', 'Fresa']]); numField('Avanço F', 'feed', 1, 50); }
    if (!['plv', 'dxf'].includes(f.ext)) seg('Camadas', 'onlyVisible', [['true', 'Só visíveis'], ['false', 'Todas']]);
  }

  private async doExport() {
    const f = FORMATS.find((x) => x.ext === this.exportFmt)!;
    const btn = $('#do-export');
    btn.classList.add('working');
    try {
      const d = this.ed.doc.d;
      if (!d.entities.length && f.ext !== 'plv') this.toast('O desenho está vazio', 'warn');
      const blob = await f.run(d, this.exportOpts);
      const name = (d.name || 'desenho').replace(/[\\/:*?"<>|]+/g, '_');
      download(blob, `${name}.${f.ext}`);
      if (f.ext === 'plv') { this.ed.doc.dirty = false; $('#dirty-dot').classList.remove('on'); }
      $<HTMLDialogElement>('#export').close();
      this.toast(`${name}.${f.ext} salvo`, 'ok', `${f.label} · ${(blob.size / 1024).toFixed(1).replace('.', ',')} KB`);
    } catch (err) {
      console.error(err);
      this.toast('Falha ao exportar', 'warn', (err as Error).message);
    } finally { btn.classList.remove('working'); }
  }

  // ================================================================ ajuda
  private buildHelp() {
    $('#help .mini').innerHTML = ICONS.close;
    const groups = new Map<string, ToolDef[]>();
    for (const d of Object.values(TOOLS)) { if (!groups.has(d.group)) groups.set(d.group, []); groups.get(d.group)!.push(d); }
    const sections = [...groups].map(([g, list]) => `<section><h3>${g}</h3><dl>${list.map((d) => `<dt>${d.aliases.slice(0, 3).join(' · ')}</dt><dd>${d.label}</dd>`).join('')}</dl></section>`);
    sections.push(`<section><h3>Coordenadas</h3><dl>
      <dt>x,y</dt><dd>ponto absoluto</dd><dt>@dx,dy</dt><dd>relativo ao último ponto</dd><dt>@d&lt;a</dt><dd>polar relativo (distância &lt; ângulo)</dd>
      <dt>número</dt><dd>distância na direção do cursor</dd></dl></section>`);
    sections.push(`<section><h3>Mouse &amp; teclado</h3><dl>
      <dt>roda</dt><dd>zoom no cursor</dd><dt>botão do meio / Alt+arrastar</dt><dd>mover a vista</dd><dt>botão direito</dt><dd>Enter / menu radial</dd>
      <dt>Enter · Espaço</dt><dd>confirmar / repetir comando</dd><dt>Esc</dt><dd>cancelar</dd><dt>Del</dt><dd>apagar seleção</dd>
      <dt>Ctrl+Z / Ctrl+Y</dt><dd>desfazer / refazer</dd><dt>Ctrl+C / Ctrl+V</dt><dd>copiar / colar</dd><dt>Ctrl+S</dt><dd>salvar como…</dd>
      <dt>F3 · F7 · F8 · F9</dt><dd>snap · grade · orto · snap de grade</dd></dl></section>`);
    sections.push(`<section><h3>Formatos</h3><dl>
      <dt>Abrir</dt><dd>DWG (R13–2018 via LibreDWG), DXF, SVG, PLV</dd>
      <dt>Salvar</dt><dd>${FORMATS.map((f) => f.ext.toUpperCase()).join(', ')}</dd></dl></section>`);
    $('#help-body').innerHTML = sections.join('');
  }

  // ================================================================ portal
  private buildPortal() {
    const track = $('.ribbon-track');
    const words = ['DWG', 'DXF', 'SVG', 'PDF', 'PNG', 'JPG', 'WEBP', 'HPGL', 'G-CODE', 'GEOJSON', 'CAMADAS', 'COTAS', 'SNAPS', 'GRÁTIS', 'LIVRE'];
    track.innerHTML = [...words, ...words].map((w) => `<span>${w} ✦</span>`).join('');
    // título do portal ajustado à largura
    $('.title .t1').setAttribute('textLength', '990');
    $('.title .t1').setAttribute('lengthAdjust', 'spacingAndGlyphs');
    $('.title .t2').setAttribute('textLength', '760');
    $('.title .t2').setAttribute('lengthAdjust', 'spacingAndGlyphs');
    $$('.ticket').forEach((t) => {
      t.addEventListener('pointermove', (ev) => {
        const r = t.getBoundingClientRect();
        const x = (ev.clientX - r.left) / r.width - 0.5, y = (ev.clientY - r.top) / r.height - 0.5;
        t.style.transform = `perspective(700px) rotateY(${x * 14}deg) rotateX(${-y * 14}deg) translateZ(10px)`;
      });
      t.addEventListener('pointerleave', () => { t.style.transform = ''; });
      t.addEventListener('click', (ev) => {
        const portal = $('#portal');
        portal.style.setProperty('--ox', `${ev.clientX}px`); portal.style.setProperty('--oy', `${ev.clientY}px`);
        const a = t.dataset.start;
        if (a === 'new') this.load(newDrawing());
        if (a === 'demo') this.load(demoDrawing());
        if (a === 'open') $<HTMLInputElement>('#file').click();
        if (a === 'draft') { try { this.load(JSON.parse(localStorage.getItem(DRAFT_KEY)!)); } catch { this.toast('Rascunho indisponível', 'warn'); } }
      });
    });
    // rascunho salvo neste navegador
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (raw) {
        const d = JSON.parse(raw) as Drawing;
        if (d?.entities?.length) {
          const t = $('.ticket[data-start="new"]');
          const draft = t.cloneNode(true) as HTMLElement;
          draft.dataset.start = 'draft';
          draft.querySelector('b')!.textContent = 'Continuar';
          draft.querySelector('small')!.textContent = `${d.name} · ${d.entities.length} objetos (rascunho deste navegador)`;
          draft.querySelector('.ticket-no')!.textContent = '00';
          $('.tickets').prepend(draft);
          $('.tickets').style.gridTemplateColumns = 'repeat(auto-fit, minmax(200px, 1fr))';
          this.buildPortalTicket(draft);
        }
      }
      if (localStorage.getItem('projetalivre:tema') === 'paper') this.toggleTheme();
    } catch { /* armazenamento indisponível */ }
  }

  private buildPortalTicket(t: HTMLElement) {
    t.addEventListener('click', () => { try { this.load(JSON.parse(localStorage.getItem(DRAFT_KEY)!)); } catch { this.toast('Rascunho indisponível', 'warn'); } });
  }

  showPortal() { $('#portal').classList.remove('gone'); }
  hidePortal() { $('#portal').classList.add('gone'); }
}

const fmt = (n: number) => (Math.round(n * 100) / 100).toFixed(2).replace('.', ',');
