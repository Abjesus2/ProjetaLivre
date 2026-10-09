// Tabela de cores indexadas do AutoCAD (ACI), gerada pelo mesmo padrão HSV usado pelo formato.
const BASE = ['#000000', '#ff0000', '#ffff00', '#00ff00', '#00ffff', '#0000ff', '#ff00ff', '#ffffff', '#808080', '#c0c0c0'];
const LEVELS: [number, number][] = [[1, 1], [1, 0.5], [0.8, 1], [0.8, 0.5], [0.6, 1], [0.6, 0.5], [0.5, 1], [0.5, 0.5], [0.3, 1], [0.3, 0.5]];

function hsv(h: number, s: number, v: number) {
  const f = (n: number) => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return '#' + [f(5), f(3), f(1)].map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join('');
}

export const ACI: string[] = (() => {
  const t = [...BASE];
  for (let i = 10; i < 250; i++) { const [v, s] = LEVELS[i % 10]; t.push(hsv(Math.floor((i - 10) / 10) * 15, s, v)); }
  for (let i = 0; i < 6; i++) { const g = Math.round(51 + i * 40.8).toString(16).padStart(2, '0'); t.push('#' + g + g + g); }
  return t;
})();

export const aciToHex = (i: number | undefined) => (i != null && i > 0 && i < 256 ? ACI[i] : undefined);
export const rgbIntToHex = (n: number) => '#' + (n & 0xffffff).toString(16).padStart(6, '0');

const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
export function hexToAci(hex: string): number {
  const [r, g, b] = rgb(hex);
  let best = 7, bd = Infinity;
  for (let i = 1; i < 256; i++) {
    const [R, G, B] = rgb(ACI[i]);
    const d = (R - r) ** 2 + (G - g) ** 2 + (B - b) ** 2;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

/** cores muito claras viram preto em fundos claros (como o "branco/preto" do ACI 7) */
export function inkOnLight(hex: string) {
  const [r, g, b] = rgb(hex);
  return 0.299 * r + 0.587 * g + 0.114 * b > 200 ? '#111111' : hex;
}
