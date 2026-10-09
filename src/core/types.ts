export interface Pt { x: number; y: number }

interface Base {
  id: string;
  layer: string;
  /** cor própria em hex; ausente = "PorCamada" */
  color?: string;
}

export interface LineEnt extends Base { type: 'line'; a: Pt; b: Pt }
export interface CircleEnt extends Base { type: 'circle'; c: Pt; r: number }
/** ângulos em radianos, sentido anti-horário de start até end */
export interface ArcEnt extends Base { type: 'arc'; c: Pt; r: number; start: number; end: number }
/** major = vetor do semi-eixo maior; ratio = menor/maior; start/end = parâmetros (rad) */
export interface EllipseEnt extends Base { type: 'ellipse'; c: Pt; major: Pt; ratio: number; start: number; end: number }
/** bulges[i] = curvatura do segmento i → i+1 (padrão DXF) */
export interface PolyEnt extends Base { type: 'poly'; pts: Pt[]; closed: boolean; bulges?: number[] }
export interface TextEnt extends Base { type: 'text'; p: Pt; h: number; text: string; rot: number }
export interface PointEnt extends Base { type: 'point'; p: Pt }
/** cota alinhada: a,b medidos; off = ponto por onde passa a linha de cota */
export interface DimEnt extends Base { type: 'dim'; a: Pt; b: Pt; off: Pt; h?: number }

export type Entity = LineEnt | CircleEnt | ArcEnt | EllipseEnt | PolyEnt | TextEnt | PointEnt | DimEnt;
export type EntityType = Entity['type'];

export interface Layer {
  name: string;
  color: string;
  visible: boolean;
  locked: boolean;
}

export interface Drawing {
  name: string;
  layers: Layer[];
  entities: Entity[];
  current: string;
}

/** Distributivo: permite criar entidades sem id */
export type NewEntity = Entity extends infer E ? (E extends Entity ? Omit<E, 'id'> : never) : never;

let seq = 0;
export const uid = () => (Date.now().toString(36) + (seq++).toString(36) + Math.random().toString(36).slice(2, 6));

export const TYPE_LABEL: Record<EntityType, string> = {
  line: 'Linha', circle: 'Círculo', arc: 'Arco', ellipse: 'Elipse',
  poly: 'Polilinha', text: 'Texto', point: 'Ponto', dim: 'Cota',
};
