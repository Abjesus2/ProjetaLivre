import type { Drawing, Entity, NewEntity, Pt } from './types';
import { uid } from './types';

/** Planta baixa de exemplo (unidades em centímetros). */
export function demoDrawing(): Drawing {
  const ents: Entity[] = [];
  const add = (e: NewEntity) => ents.push({ ...e, id: uid() } as Entity);
  const rect = (layer: string, x: number, y: number, w: number, h: number) =>
    add({ type: 'poly', layer, closed: true, pts: [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }] });
  const line = (layer: string, a: Pt, b: Pt) => add({ type: 'line', layer, a, b });

  // paredes externas (15 cm) e internas
  rect('Paredes', 0, 0, 1200, 800);
  rect('Paredes', 15, 15, 1170, 770);
  const wall = (a: Pt, b: Pt, t = 12) => {
    line('Paredes', a, b);
    const vertical = a.x === b.x;
    line('Paredes', vertical ? { x: a.x + t, y: a.y } : { x: a.x, y: a.y + t }, vertical ? { x: b.x + t, y: b.y } : { x: b.x, y: b.y + t });
  };
  wall({ x: 500, y: 15 }, { x: 500, y: 380 });
  wall({ x: 500, y: 470 }, { x: 500, y: 785 });
  wall({ x: 15, y: 380 }, { x: 330, y: 380 });
  wall({ x: 420, y: 380 }, { x: 500, y: 380 });
  wall({ x: 512, y: 520 }, { x: 860, y: 520 });
  wall({ x: 950, y: 520 }, { x: 1185, y: 520 });
  wall({ x: 950, y: 532 }, { x: 950, y: 600 });
  wall({ x: 950, y: 690 }, { x: 950, y: 785 });

  // portas (folha + arco de abertura)
  const door = (h: Pt, w: number, a0: number, a1: number) => {
    const end = { x: h.x + w * Math.cos(a1), y: h.y + w * Math.sin(a1) };
    add({ type: 'line', layer: 'Portas', a: h, b: end });
    add({ type: 'arc', layer: 'Portas', c: h, r: w, start: Math.min(a0, a1), end: Math.max(a0, a1) });
  };
  door({ x: 330, y: 392 }, 90, 0, Math.PI / 2);
  door({ x: 860, y: 532 }, 90, 0, Math.PI / 2);
  door({ x: 500, y: 380 }, 90, Math.PI / 2, Math.PI);
  door({ x: 962, y: 600 }, 90, 0, Math.PI / 2);
  door({ x: 1100, y: 0 }, 85, Math.PI / 2, Math.PI);

  // janelas
  for (const [x, y, w, vertical] of [[150, 785, 200, 0], [640, 785, 240, 0], [1010, 785, 120, 0], [150, 0, 160, 0], [1185, 140, 240, 1]] as const) {
    if (vertical) { rect('Janelas', x - 2, y, 19, w); line('Janelas', { x: x + 7.5, y }, { x: x + 7.5, y: y + w }); }
    else { rect('Janelas', x, y - 2, w, 19); line('Janelas', { x, y: y + 7.5 }, { x: x + w, y: y + 7.5 }); }
  }

  // mobiliário
  rect('Mobiliario', 60, 470, 200, 160);          // cama
  rect('Mobiliario', 60, 600, 200, 30);
  rect('Mobiliario', 70, 640, 80, 40);            // travesseiros
  rect('Mobiliario', 170, 640, 80, 40);
  add({ type: 'circle', layer: 'Mobiliario', c: { x: 820, y: 260 }, r: 80 }); // mesa
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    add({ type: 'circle', layer: 'Mobiliario', c: { x: 820 + 112 * Math.cos(a), y: 260 + 112 * Math.sin(a) }, r: 20 });
  }
  rect('Mobiliario', 560, 690, 300, 80);          // sofá
  rect('Mobiliario', 640, 580, 140, 60);          // mesa de centro
  add({ type: 'poly', layer: 'Mobiliario', closed: true, pts: [{ x: 1020, y: 610 }, { x: 1160, y: 610 }, { x: 1160, y: 760 }, { x: 1020, y: 760 }], bulges: [0, 0, 0.35, 0] });
  add({ type: 'ellipse', layer: 'Mobiliario', c: { x: 1090, y: 680 }, major: { x: 0, y: 50 }, ratio: 0.6, start: 0, end: Math.PI * 2 });
  rect('Mobiliario', 40, 40, 60, 300);            // bancada
  add({ type: 'circle', layer: 'Mobiliario', c: { x: 70, y: 120 }, r: 18 });
  add({ type: 'circle', layer: 'Mobiliario', c: { x: 70, y: 260 }, r: 18 });
  rect('Mobiliario', 140, 40, 120, 60);           // fogão
  for (const [x, y] of [[170, 70], [230, 70]]) add({ type: 'circle', layer: 'Mobiliario', c: { x, y }, r: 14 });

  // textos
  const label = (x: number, y: number, t: string, h = 22) => add({ type: 'text', layer: 'Textos', p: { x, y }, h, text: t, rot: 0 });
  label(300, 520, 'QUARTO', 22); label(300, 495, 'A=11,8 m²', 12);
  label(560, 470, 'JANTAR', 22); label(560, 445, 'A=24,6 m²', 12);
  label(560, 545, 'ESTAR', 22);
  label(160, 300, 'COZINHA', 22); label(160, 275, 'A=10,9 m²', 12);
  label(990, 545, 'BANHO', 18);
  label(0, -170, 'PLANTA BAIXA — exemplo ProjetaLivre', 30);
  label(0, -210, 'clique em um objeto, arraste os grips ou digite L, C, M, TR…', 15);

  // cotas
  add({ type: 'dim', layer: 'Cotas', a: { x: 0, y: 0 }, b: { x: 1200, y: 0 }, off: { x: 600, y: -80 }, h: 20 });
  add({ type: 'dim', layer: 'Cotas', a: { x: 1200, y: 0 }, b: { x: 1200, y: 800 }, off: { x: 1290, y: 400 }, h: 20 });
  add({ type: 'dim', layer: 'Cotas', a: { x: 0, y: 800 }, b: { x: 500, y: 800 }, off: { x: 250, y: 870 }, h: 20 });
  add({ type: 'dim', layer: 'Cotas', a: { x: 500, y: 800 }, b: { x: 1200, y: 800 }, off: { x: 850, y: 870 }, h: 20 });

  return {
    name: 'Planta exemplo',
    current: 'Paredes',
    layers: [
      { name: '0', color: '#e9f0ff', visible: true, locked: false },
      { name: 'Paredes', color: '#e9f0ff', visible: true, locked: false },
      { name: 'Portas', color: '#ff5a36', visible: true, locked: false },
      { name: 'Janelas', color: '#8be9ff', visible: true, locked: false },
      { name: 'Mobiliario', color: '#c792ff', visible: true, locked: false },
      { name: 'Textos', color: '#d4ff3a', visible: true, locked: false },
      { name: 'Cotas', color: '#ffb347', visible: true, locked: false },
    ],
    entities: ents,
  };
}
