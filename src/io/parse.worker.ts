// Web Worker: lê DWG/DXF fora da thread da interface, enviando o progresso.
import { readCad } from './cad';
import { entityBox } from '../core/geom';

self.onmessage = async (ev: MessageEvent<{ kind: 'dxf' | 'dwg'; data: ArrayBuffer; name: string }>) => {
  const { kind, data, name } = ev.data;
  try {
    const { drawing, skipped } = await readCad(kind, data, name, (stage, pct) => self.postMessage({ type: 'progress', stage, pct }));
    // limites de cada objeto calculados aqui, fora da thread da interface
    self.postMessage({ type: 'progress', stage: 'Calculando limites dos objetos…', pct: 96 });
    const boxes = new Float64Array(drawing.entities.length * 4);
    drawing.entities.forEach((e, i) => { const b = entityBox(e); boxes.set([b.minX, b.minY, b.maxX, b.maxY], i * 4); });
    // texto JSON é bem mais rápido de transferir que milhares de objetos clonados
    const json = new TextEncoder().encode(JSON.stringify(drawing));
    (self as unknown as Worker).postMessage({ type: 'done', json, boxes, skipped }, [json.buffer, boxes.buffer]);
  } catch (err) {
    self.postMessage({ type: 'error', message: (err as Error)?.message ?? String(err) });
  }
};
