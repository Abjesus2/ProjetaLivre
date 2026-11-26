// Desenho da lista do CADCraft pela placa de vídeo (WebGL 2, ou WebGL 1 com índices de 32 bits).
// Os dados sobem uma vez para a placa; cada quadro só troca dois números (centro e escala), então
// arrastar e aproximar custa quase nada para o processador, mesmo em máquinas fracas.
import { visibleRuns, type DisplayData } from './format';

/** Vista: centro no mundo, escala (pixels do aparelho por unidade) e tamanho em pixels do aparelho. */
export interface ViewXf { cx: number; cy: number; s: number; w: number; h: number }
export interface Theme { bg: [number, number, number]; ink: [number, number, number] }
export type Slot = 'base' | 'detail';

export interface ViewRenderer {
  readonly kind: 'webgl' | '2d';
  upload(slot: Slot, d: DisplayData): void;
  drop(slot: Slot): void;
  draw(v: ViewXf, theme: Theme, visible: (layer: number) => boolean, slot: Slot): void;
  dispose(): void;
}

const VS = `
attribute vec2 a_pos;
attribute vec4 a_col;
uniform vec2 u_off;
uniform vec2 u_scale;
uniform vec3 u_ink;
uniform vec3 u_bg;
uniform float u_ps;
varying vec3 v_col;
void main() {
  gl_Position = vec4((a_pos + u_off) * u_scale, 0.0, 1.0);
  gl_PointSize = u_ps;
  float m = floor(a_col.a * 255.0 + 0.5);
  vec3 c = a_col.rgb;
  if (m == 254.0) c = u_ink;
  else if (m == 253.0) c = u_bg;
  // cor quase igual ao fundo (preto no escuro, branco no claro): usa a tinta do tema
  else if (distance(c, u_bg) < 0.12) c = u_ink;
  v_col = c;
}`;
const FS = `
precision mediump float;
varying vec3 v_col;
void main() { gl_FragColor = vec4(v_col, 1.0); }`;

interface Mesh {
  d: DisplayData;
  linePos: WebGLBuffer; lineCol: WebGLBuffer; lineIdx: WebGLBuffer;
  triPos: WebGLBuffer; triCol: WebGLBuffer;
  ptPos: WebGLBuffer; ptCol: WebGLBuffer;
}

type GL = WebGLRenderingContext | WebGL2RenderingContext;

export class GLRenderer implements ViewRenderer {
  readonly kind = 'webgl' as const;
  private gl: GL;
  private prog!: WebGLProgram;
  private loc!: { pos: number; col: number; off: WebGLUniformLocation; scale: WebGLUniformLocation; ink: WebGLUniformLocation; bg: WebGLUniformLocation; ps: WebGLUniformLocation };
  private meshes: Partial<Record<Slot, Mesh>> = {};
  /** dados guardados para subir de novo se a placa de vídeo perder o contexto */
  private data: Partial<Record<Slot, DisplayData>> = {};
  private lost = false;
  onRestore: () => void = () => {};

  private constructor(private canvas: HTMLCanvasElement, gl: GL) {
    this.gl = gl;
    this.init();
    canvas.addEventListener('webglcontextlost', this.onLost);
    canvas.addEventListener('webglcontextrestored', this.onRestored);
  }

  /** null se o navegador não tiver WebGL utilizável (o visualizador usa o Canvas 2D). */
  static create(canvas: HTMLCanvasElement, antialias: boolean): GLRenderer | null {
    const opts: WebGLContextAttributes = { antialias, alpha: false, depth: false, stencil: false, preserveDrawingBuffer: false, powerPreference: 'low-power' };
    try {
      const gl2 = canvas.getContext('webgl2', opts);
      if (gl2) return new GLRenderer(canvas, gl2);
      const gl1 = canvas.getContext('webgl', opts) as WebGLRenderingContext | null;
      if (gl1 && gl1.getExtension('OES_element_index_uint')) return new GLRenderer(canvas, gl1);
    } catch { /* sem WebGL */ }
    return null;
  }

  private onLost = (ev: Event) => { ev.preventDefault(); this.lost = true; this.meshes = {}; };
  private onRestored = () => {
    this.lost = false;
    this.init();
    for (const k of Object.keys(this.data) as Slot[]) this.upload(k, this.data[k]!);
    this.onRestore();
  };

  private init() {
    const gl = this.gl;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader');
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS));
    gl.bindAttribLocation(p, 0, 'a_pos');
    gl.bindAttribLocation(p, 1, 'a_col');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'program');
    this.prog = p;
    const u = (n: string) => gl.getUniformLocation(p, n)!;
    this.loc = { pos: 0, col: 1, off: u('u_off'), scale: u('u_scale'), ink: u('u_ink'), bg: u('u_bg'), ps: u('u_ps') };
    gl.disable(gl.DEPTH_TEST);
  }

  upload(slot: Slot, d: DisplayData) {
    this.drop(slot);
    this.data[slot] = d;
    if (this.lost) return;
    const gl = this.gl;
    const buf = (target: number, data: ArrayBufferView) => {
      const b = gl.createBuffer()!;
      gl.bindBuffer(target, b);
      gl.bufferData(target, data, gl.STATIC_DRAW);
      return b;
    };
    this.meshes[slot] = {
      d,
      linePos: buf(gl.ARRAY_BUFFER, d.linePos), lineCol: buf(gl.ARRAY_BUFFER, d.lineCol), lineIdx: buf(gl.ELEMENT_ARRAY_BUFFER, d.lineIdx),
      triPos: buf(gl.ARRAY_BUFFER, d.triPos), triCol: buf(gl.ARRAY_BUFFER, d.triCol),
      ptPos: buf(gl.ARRAY_BUFFER, d.ptPos), ptCol: buf(gl.ARRAY_BUFFER, d.ptCol),
    };
  }

  drop(slot: Slot) {
    const m = this.meshes[slot];
    delete this.data[slot];
    if (!m) return;
    delete this.meshes[slot];
    if (this.lost) return;
    const gl = this.gl;
    for (const b of [m.linePos, m.lineCol, m.lineIdx, m.triPos, m.triCol, m.ptPos, m.ptCol]) gl.deleteBuffer(b);
  }

  draw(v: ViewXf, theme: Theme, visible: (layer: number) => boolean, slot: Slot) {
    if (this.lost) return;
    const gl = this.gl;
    gl.viewport(0, 0, v.w, v.h);
    gl.clearColor(theme.bg[0], theme.bg[1], theme.bg[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const m = this.meshes[slot];
    if (!m) return;
    const d = m.d;
    gl.useProgram(this.prog);
    // deslocamento calculado em precisão dupla e só então reduzido (coordenadas grandes)
    gl.uniform2f(this.loc.off, d.origin.x - v.cx, d.origin.y - v.cy);
    gl.uniform2f(this.loc.scale, (2 * v.s) / v.w, (2 * v.s) / v.h);
    gl.uniform3fv(this.loc.ink, theme.ink);
    gl.uniform3fv(this.loc.bg, theme.bg);
    gl.uniform1f(this.loc.ps, Math.max(2, Math.round(v.w / Math.max(1, this.canvas.clientWidth)) * 2));
    gl.enableVertexAttribArray(0);
    gl.enableVertexAttribArray(1);
    const bind = (pos: WebGLBuffer, col: WebGLBuffer) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, pos);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, col);
      gl.vertexAttribPointer(1, 4, gl.UNSIGNED_BYTE, true, 0, 0);
    };
    // preenchimentos por baixo, traços por cima, pontos no topo
    if (d.triPos.length) {
      bind(m.triPos, m.triCol);
      for (const [a, z] of visibleRuns(d.triStart, visible)) gl.drawArrays(gl.TRIANGLES, a, z - a);
    }
    if (d.lineIdx.length) {
      bind(m.linePos, m.lineCol);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, m.lineIdx);
      for (const [a, z] of visibleRuns(d.lineStart, visible)) gl.drawElements(gl.LINES, z - a, gl.UNSIGNED_INT, a * 4);
    }
    if (d.ptPos.length) {
      bind(m.ptPos, m.ptCol);
      for (const [a, z] of visibleRuns(d.ptStart, visible)) gl.drawArrays(gl.POINTS, a, z - a);
    }
  }

  dispose() {
    this.drop('base');
    this.drop('detail');
    this.canvas.removeEventListener('webglcontextlost', this.onLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onRestored);
    // devolve a placa de vídeo na hora (sem esperar a coleta de lixo)
    if (!this.lost) this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}

/** Reserva sem placa de vídeo: Canvas 2D, agrupando traços seguidos da mesma cor. */
export class Canvas2DRenderer implements ViewRenderer {
  readonly kind = '2d' as const;
  private data: Partial<Record<Slot, DisplayData>> = {};
  private css = new Map<number, string>();
  private ctx: CanvasRenderingContext2D;

  constructor(canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d', { alpha: false })!;
  }

  upload(slot: Slot, d: DisplayData) { this.data[slot] = d; }
  drop(slot: Slot) { delete this.data[slot]; }
  dispose() { this.data = {}; }

  private color(c: number, theme: Theme): string {
    const a = c >>> 24;
    let r = c & 255, g = (c >>> 8) & 255, b = (c >>> 16) & 255;
    const to255 = (t: [number, number, number]) => t.map((x) => Math.round(x * 255));
    if (a === 254) [r, g, b] = to255(theme.ink);
    else if (a === 253) [r, g, b] = to255(theme.bg);
    else {
      const [br, bg, bb] = to255(theme.bg);
      if (Math.hypot(r - br, g - bg, b - bb) < 0.12 * 255) [r, g, b] = to255(theme.ink);
    }
    const key = (r << 16) | (g << 8) | b;
    let s = this.css.get(key);
    if (!s) { s = `rgb(${r},${g},${b})`; this.css.set(key, s); }
    return s;
  }

  draw(v: ViewXf, theme: Theme, visible: (layer: number) => boolean, slot: Slot) {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = `rgb(${theme.bg.map((x) => Math.round(x * 255)).join(',')})`;
    ctx.fillRect(0, 0, v.w, v.h);
    const d = this.data[slot];
    if (!d) return;
    this.css.clear();
    // mundo (relativo à origem da lista) → tela
    const tx = v.w / 2 + (d.origin.x - v.cx) * v.s, ty = v.h / 2 - (d.origin.y - v.cy) * v.s;
    ctx.setTransform(v.s, 0, 0, -v.s, tx, ty);
    const px = 1 / v.s;
    ctx.lineWidth = px;
    ctx.lineCap = 'butt';
    // preenchimentos
    const T = d.triPos, TC = d.triCol;
    for (const [a, z] of visibleRuns(d.triStart, visible)) {
      let cur = -1;
      ctx.beginPath();
      for (let i = a; i + 2 < z; i += 3) {
        if (TC[i] !== cur) { if (cur !== -1) ctx.fill(); cur = TC[i]; ctx.fillStyle = this.color(cur, theme); ctx.beginPath(); }
        ctx.moveTo(T[i * 2], T[i * 2 + 1]);
        ctx.lineTo(T[i * 2 + 2], T[i * 2 + 3]);
        ctx.lineTo(T[i * 2 + 4], T[i * 2 + 5]);
        ctx.closePath();
      }
      if (cur !== -1) ctx.fill();
    }
    // traços
    const P = d.linePos, C = d.lineCol, I = d.lineIdx;
    for (const [a, z] of visibleRuns(d.lineStart, visible)) {
      let cur = -1, last = -1;
      ctx.beginPath();
      for (let k = a; k + 1 < z; k += 2) {
        const i = I[k], j = I[k + 1];
        if (C[i] !== cur) { if (cur !== -1) ctx.stroke(); cur = C[i]; ctx.strokeStyle = this.color(cur, theme); ctx.beginPath(); last = -1; }
        if (i !== last) ctx.moveTo(P[i * 2], P[i * 2 + 1]);
        ctx.lineTo(P[j * 2], P[j * 2 + 1]);
        last = j;
      }
      if (cur !== -1) ctx.stroke();
    }
    // pontos
    const Q = d.ptPos, QC = d.ptCol;
    for (const [a, z] of visibleRuns(d.ptStart, visible)) {
      for (let i = a; i < z; i++) {
        ctx.fillStyle = this.color(QC[i], theme);
        ctx.fillRect(Q[i * 2] - px, Q[i * 2 + 1] - px, 2 * px, 2 * px);
      }
    }
  }
}
