import type { Drawing, Entity, Layer, NewEntity } from './types';
import { uid } from './types';

type Listener = () => void;

export const PALETTE = ['#e9f0ff', '#d4ff3a', '#ff5a36', '#8be9ff', '#ffb347', '#c792ff', '#5dffb0', '#ff7ac6'];

export function newDrawing(name = 'Sem título'): Drawing {
  return {
    name,
    layers: [
      { name: '0', color: '#e9f0ff', visible: true, locked: false },
      { name: 'Cotas', color: '#ffb347', visible: true, locked: false },
    ],
    entities: [],
    current: '0',
  };
}

/** Documento com histórico (desfazer/refazer por instantâneos). */
export class Doc {
  d: Drawing;
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private listeners: Listener[] = [];
  dirty = false;

  constructor(d: Drawing = newDrawing()) { this.d = d; }

  on(fn: Listener) { this.listeners.push(fn); }
  emit() { this.layerMap = null; this.idMap = null; for (const l of this.listeners) l(); }

  /** grava o estado atual antes de uma alteração */
  checkpoint() {
    this.undoStack.push(JSON.stringify(this.d));
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
    this.dirty = true;
  }
  undo() {
    const s = this.undoStack.pop(); if (!s) return false;
    this.redoStack.push(JSON.stringify(this.d)); this.d = JSON.parse(s); this.emit(); return true;
  }
  redo() {
    const s = this.redoStack.pop(); if (!s) return false;
    this.undoStack.push(JSON.stringify(this.d)); this.d = JSON.parse(s); this.emit(); return true;
  }

  load(d: Drawing) {
    this.d = d; this.undoStack = []; this.redoStack = []; this.dirty = false;
    if (!d.layers.find((l) => l.name === d.current)) d.current = d.layers[0]?.name ?? '0';
    if (!d.layers.length) d.layers.push({ name: '0', color: '#e9f0ff', visible: true, locked: false });
    this.emit();
  }

  /** cache nome → camada (desenhos grandes consultam isto milhares de vezes por quadro) */
  private layerMap: Map<string, Layer> | null = null;
  layer(name: string): Layer | undefined {
    if (!this.layerMap) this.layerMap = new Map(this.d.layers.map((l) => [l.name, l]));
    return this.layerMap.get(name) ?? this.d.layers.find((l) => l.name === name);
  }
  ensureLayer(name: string, color = PALETTE[this.d.layers.length % PALETTE.length]) {
    let l = this.layer(name);
    if (!l) { l = { name, color, visible: true, locked: false }; this.d.layers.push(l); }
    return l;
  }
  colorOf(e: Entity) { return e.color ?? this.layer(e.layer)?.color ?? '#e9f0ff'; }
  isEditable(e: Entity) { const l = this.layer(e.layer); return !l || (l.visible && !l.locked); }
  isVisible(e: Entity) { return this.layer(e.layer)?.visible !== false; }

  add(e: NewEntity): Entity {
    const ent = { ...e, id: uid() } as Entity;
    this.d.entities.push(ent);
    this.idMap?.set(ent.id, ent);
    return ent;
  }
  private idMap: Map<string, Entity> | null = null;
  byId(id: string) {
    if (!this.idMap) this.idMap = new Map(this.d.entities.map((e) => [e.id, e]));
    return this.idMap.get(id);
  }
  remove(ids: Set<string>) { this.d.entities = this.d.entities.filter((e) => !ids.has(e.id)); this.idMap = null; }
  replace(e: Entity) { const i = this.d.entities.findIndex((x) => x.id === e.id); if (i >= 0) this.d.entities[i] = e; this.idMap = null; }
}
