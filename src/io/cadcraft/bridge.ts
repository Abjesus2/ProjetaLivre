// Chamadas ao leitor CADCraft (ponte em cadcraft-wasm/src/lib.rs). Usado dentro dos workers.

interface Exports {
  memory: WebAssembly.Memory;
  pl_alloc(len: number): number;
  pl_free(ptr: number, len: number): void;
  pl_result_ptr(): number;
  pl_result_len(): number;
  pl_open(ptr: number, len: number, namePtr: number, nameLen: number): number;
  pl_close(): void;
  pl_info(): number;
  pl_display(space: number, tolerance: number, x0: number, y0: number, x1: number, y1: number): number;
  pl_raw(): number;
}

export interface CadLayerInfo { name: string; color: string; on: boolean; frozen: boolean }
export interface CadSheetInfo { name: string; entities: number }
export interface CadInfo {
  layers: CadLayerInfo[];
  entities: number;
  blocks: number;
  layouts: number;
  version: string;
  notes: string[];
  sheets: CadSheetInfo[];
  /** folha aberta no arquivo (0 = modelo) */
  activeSheet: number;
}

export class CadCraft {
  private constructor(private x: Exports) {}

  static async create(mod: WebAssembly.Module): Promise<CadCraft> {
    const inst = await WebAssembly.instantiate(mod, {});
    return new CadCraft(inst.exports as unknown as Exports);
  }

  private put(bytes: Uint8Array): [number, number] {
    const p = this.x.pl_alloc(bytes.length);
    new Uint8Array(this.x.memory.buffer, p, bytes.length).set(bytes);
    return [p, bytes.length];
  }

  private result(): Uint8Array {
    return new Uint8Array(this.x.memory.buffer, this.x.pl_result_ptr(), this.x.pl_result_len());
  }

  private text(): string {
    return new TextDecoder().decode(this.result());
  }

  private check(code: number) {
    if (code !== 0) throw new Error(this.text() || 'Falha no leitor CADCraft');
  }

  /** Lê o arquivo (DWG ou DXF). Lança erro com a mensagem do leitor. */
  open(data: ArrayBuffer | Uint8Array, name: string) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const [p, n] = this.put(bytes);
    const [np, nn] = this.put(new TextEncoder().encode(name));
    try {
      if (this.x.pl_open(p, n, np, nn) !== 0) throw new Error(`O leitor CADCraft não conseguiu ler o arquivo (${this.text() || 'formato não reconhecido'})`);
    } finally {
      // a cópia do arquivo não é mais necessária: o desenho já foi montado
      this.x.pl_free(p, n);
      this.x.pl_free(np, nn);
    }
  }

  info(): CadInfo {
    this.check(this.x.pl_info());
    return JSON.parse(this.text());
  }

  /** Lista de desenho para o visualizador (formato em src/viewer/format.ts), numa cópia própria. */
  display(space: number, tolerance = 0, win?: [number, number, number, number] | null): ArrayBuffer {
    const [x0, y0, x1, y1] = win ?? [NaN, NaN, NaN, NaN];
    this.check(this.x.pl_display(space, tolerance, x0, y0, x1, y1));
    return this.result().slice().buffer;
  }

  /** Estrutura intermediária para o editor (texto JSON, lido por fromRaw em src/io/raw.ts). */
  raw(): string {
    this.check(this.x.pl_raw());
    return this.text();
  }

  close() { this.x.pl_close(); }
}
