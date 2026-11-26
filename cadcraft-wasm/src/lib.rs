//! Ponte do ProjetaLivre para o CADCraft (storytold/cadcraft, MIT OR Apache-2.0).
//!
//! Compilada para WebAssembly e usada num Web Worker. Lê DXF (texto e binário) e DWG (pelo
//! acadrust, MPL-2.0) com o leitor do CADCraft e entrega ao navegador:
//! - a lista de desenho do renderizador do CADCraft (linhas, triângulos e pontos com a cor já
//!   resolvida; blocos, cotas, hachuras, textos e tipos de linha já expandidos), num formato
//!   binário pronto para a placa de vídeo — usada pelo modo só visualização;
//! - informações do desenho (camadas, avisos da leitura) em JSON.
//!
//! Interface sem wasm-bindgen: funções `extern "C"` e um buffer de resultado.

use std::cell::RefCell;
use std::collections::HashMap;

use cadcraft_doc::{Drawing, Space};
use cadcraft_render::{Kind, Options};

thread_local! {
    static DRAWING: RefCell<Option<Drawing>> = const { RefCell::new(None) };
    static RESULT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

fn set_result(v: Vec<u8>) {
    RESULT.with(|r| *r.borrow_mut() = v);
}

/// Reserva `len` bytes na memória do módulo (o JavaScript copia o arquivo para lá).
#[unsafe(no_mangle)]
pub extern "C" fn pl_alloc(len: usize) -> *mut u8 {
    let mut v = vec![0u8; len.max(1)];
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

/// Devolve uma área reservada por [`pl_alloc`].
///
/// # Safety
/// `ptr` e `len` precisam ser exatamente os de uma chamada a [`pl_alloc`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn pl_free(ptr: *mut u8, len: usize) {
    // SAFETY: o chamador garante que ptr/len vieram de pl_alloc (vec![0; len.max(1)]).
    unsafe { drop(Vec::from_raw_parts(ptr, len.max(1), len.max(1))) };
}

#[unsafe(no_mangle)]
pub extern "C" fn pl_result_ptr() -> *const u8 {
    RESULT.with(|r| r.borrow().as_ptr())
}

#[unsafe(no_mangle)]
pub extern "C" fn pl_result_len() -> usize {
    RESULT.with(|r| r.borrow().len())
}

/// Lê um arquivo (bytes em `ptr`, nome em `name_ptr`). 0 = ok; 1 = erro (mensagem no resultado).
///
/// # Safety
/// As áreas precisam ser válidas (reservadas por [`pl_alloc`]).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn pl_open(ptr: *const u8, len: usize, name_ptr: *const u8, name_len: usize) -> i32 {
    // SAFETY: o chamador passa áreas reservadas por pl_alloc, com o tamanho certo.
    let bytes = unsafe { std::slice::from_raw_parts(ptr, len) };
    // SAFETY: idem.
    let name = String::from_utf8_lossy(unsafe { std::slice::from_raw_parts(name_ptr, name_len) }).into_owned();
    // DWG: no worker do navegador a conversão roda no próprio processo (o worker é o isolamento)
    craft_dwg::allow_in_process();
    match cadcraft_io::read(bytes, &name) {
        Ok(d) => {
            DRAWING.with(|s| *s.borrow_mut() = Some(d));
            set_result(Vec::new());
            0
        }
        Err(e) => {
            set_result(e.to_string().into_bytes());
            1
        }
    }
}

/// Esquece o desenho aberto (libera a memória).
#[unsafe(no_mangle)]
pub extern "C" fn pl_close() {
    DRAWING.with(|s| *s.borrow_mut() = None);
    set_result(Vec::new());
}

fn esc(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 2);
    o.push('"');
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            '\n' => o.push_str("\\n"),
            '\r' => o.push_str("\\r"),
            '\t' => o.push_str("\\t"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

/// Informações do desenho aberto em JSON: camadas, número de objetos, versão, avisos da leitura.
#[unsafe(no_mangle)]
pub extern "C" fn pl_info() -> i32 {
    DRAWING.with(|s| {
        let s = s.borrow();
        let Some(d) = s.as_ref() else {
            set_result(b"nenhum desenho aberto".to_vec());
            return 1;
        };
        // camadas usadas por algum objeto (do modelo, das folhas ou de blocos): o visualizador
        // lista as desligadas no arquivo só se tiverem conteúdo
        let mut used = std::collections::HashSet::new();
        let stores = std::iter::once(&d.model).chain(d.blocks.values().map(|b| &b.entities)).chain(d.layouts.iter().map(|l| &l.entities));
        for st in stores {
            for e in st.iter() {
                used.insert(e.common.layer.to_ascii_lowercase());
            }
        }
        let mut j = String::from("{\"layers\":[");
        for (i, l) in d.layers.iter().enumerate() {
            if i > 0 {
                j.push(',');
            }
            let rgb = l.color.resolve(l.color, l.color);
            j.push_str(&format!(
                "{{\"name\":{},\"color\":\"#{:06x}\",\"on\":{},\"frozen\":{},\"used\":{}}}",
                esc(&l.name),
                rgb.to_u32(),
                l.on,
                l.frozen,
                used.contains(&l.name.to_ascii_lowercase())
            ));
        }
        let version = d.header.get("ACADVER").and_then(cadcraft_doc::HVal::as_str).unwrap_or("");
        j.push_str(&format!(
            "],\"entities\":{},\"blocks\":{},\"layouts\":{},\"version\":{},\"notes\":[",
            d.model.len(),
            d.blocks.len(),
            d.layouts.len(),
            esc(version)
        ));
        for (i, n) in d.read_notes.iter().enumerate() {
            if i > 0 {
                j.push(',');
            }
            j.push_str(&esc(n));
        }
        j.push_str("],\"sheets\":[");
        let mut ls: Vec<_> = d.layouts.iter().collect();
        ls.sort_by_key(|l| l.tab_order);
        for (i, l) in ls.iter().enumerate() {
            if i > 0 {
                j.push(',');
            }
            // o que a folha mostra (a janela que representa o próprio papel, id 1, não conta)
            let shown = l.entities.iter().filter(|e| !matches!(&e.kind, cadcraft_doc::EntityKind::Viewport(v) if v.id <= 1 || !v.on)).count();
            j.push_str(&format!("{{\"name\":{},\"entities\":{}}}", esc(&l.name), shown));
        }
        let active = d.active_layout.as_ref().and_then(|n| ls.iter().position(|l| &l.name == n)).map_or(0, |i| i + 1);
        j.push_str(&format!("],\"activeSheet\":{active}}}"));
        set_result(j.into_bytes());
        0
    })
}

/// Cor no formato do buffer: r | g<<8 | b<<16 | a<<24. Alfa 254 = cor 7 (o visualizador troca
/// pela cor da tinta do tema), 253 = máscara (cor do fundo).
fn rgba(r: u8, g: u8, b: u8, a: u8) -> u32 {
    u32::from(r) | (u32::from(g) << 8) | (u32::from(b) << 16) | (u32::from(a) << 24)
}

/// Espaço pedido pelo visualizador: 0 = modelo, k ≥ 1 = k-ésima folha na ordem das abas.
fn space_of(d: &Drawing, space: i32) -> Space {
    if space <= 0 {
        return Space::Model;
    }
    let mut ls: Vec<_> = d.layouts.iter().collect();
    ls.sort_by_key(|l| l.tab_order);
    ls.get(space as usize - 1).map_or(Space::Model, |l| Space::Paper(l.name.clone()))
}

/// Monta a lista de desenho de um espaço (modelo ou folha), agrupada por camada, no formato
/// binário descrito em `src/viewer/format.ts` do ProjetaLivre.
///
/// `space`: 0 = modelo, k ≥ 1 = k-ésima folha (ordem das abas).
/// `tolerance`: tolerância de curva em unidades do desenho (0 = automática, ~1/20000 da extensão).
/// `vx0..vy1`: janela a desenhar (NaN = tudo); só os objetos do modelo que a tocam entram, e as
/// hachuras são geradas só dentro dela.
#[unsafe(no_mangle)]
pub extern "C" fn pl_display(space: i32, tolerance: f64, vx0: f64, vy0: f64, vx1: f64, vy1: f64) -> i32 {
    DRAWING.with(|s| {
        let mut s = s.borrow_mut();
        let Some(d) = s.as_mut() else {
            set_result(b"nenhum desenho aberto".to_vec());
            return 1;
        };
        let out = display(d, space, tolerance, vx0, vy0, vx1, vy1);
        set_result(out);
        0
    })
}

fn quantile(v: &mut [f64], p: f64) -> f64 {
    if v.is_empty() {
        return 0.0;
    }
    v.sort_by(f64::total_cmp);
    let i = ((v.len() - 1) as f64 * p).floor() as usize;
    v[i.min(v.len() - 1)]
}

// Camadas que o visualizador mandou mostrar mesmo desligadas ou congeladas no arquivo
// (1 byte por camada, na ordem de `pl_info`).
thread_local! {
    static FORCED: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

/// Define as camadas mostradas apesar do arquivo (bytes 0/1 em `ptr`, um por camada).
///
/// # Safety
/// A área precisa ser válida (reservada por [`pl_alloc`]).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn pl_force_layers(ptr: *const u8, len: usize) {
    // SAFETY: o chamador passa uma área reservada por pl_alloc, com o tamanho certo.
    let v = if len == 0 { Vec::new() } else { unsafe { std::slice::from_raw_parts(ptr, len) }.to_vec() };
    FORCED.with(|f| *f.borrow_mut() = v);
}

/// Quantas cópias de objetos de bloco o renderizador visita para desenhar `e` (o orçamento
/// [`cadcraft_render::MAX_BLOCK_EXPANSION`] conta isso).
fn expansion(d: &Drawing, e: &cadcraft_doc::Entity, memo: &mut HashMap<String, u64>, depth: usize) -> u64 {
    use cadcraft_doc::EntityKind as K;
    let block = |name: &str, memo: &mut HashMap<String, u64>| block_expansion(d, name, memo, depth + 1);
    match &e.kind {
        K::Insert(i) => u64::from(i.rows.max(1)).saturating_mul(u64::from(i.cols.max(1))).saturating_mul(1 + block(&i.block, memo)),
        K::Dimension(dm) => dm.block.as_deref().map_or(0, |b| block(b, memo)),
        K::MLeader(m) => m.block.as_ref().map_or(0, |i| 1 + block(&i.block, memo)),
        _ => 0,
    }
}

fn block_expansion(d: &Drawing, name: &str, memo: &mut HashMap<String, u64>, depth: usize) -> u64 {
    if depth > cadcraft_doc::MAX_BLOCK_DEPTH {
        return 0;
    }
    let key = name.to_ascii_lowercase();
    if let Some(&c) = memo.get(&key) {
        return c;
    }
    memo.insert(key.clone(), 0); // referência circular: não conta de novo
    let Some(b) = d.block(name) else { return 0 };
    let c = b.entities.iter().fold(0u64, |acc, e| acc.saturating_add(1).saturating_add(expansion(d, e, memo, depth)));
    memo.insert(key, c);
    c
}

/// Pontos no total, somando as partes (cada parte do renderizador aceita até 64 milhões). Acima
/// disso a imagem afastada fica incompleta e o resto aparece no detalhe ao aproximar (memória).
const MAX_TOTAL_POINTS: usize = 24_000_000;
/// Cópias de objetos de bloco por parte: abaixo do limite do renderizador (2 milhões).
const PART_EXPANSION: u64 = 1_500_000;

/// Monta os objetos `all` do modelo em partes (o limite de cópias de blocos do renderizador
/// deixaria de fora o fim de desenhos grandes) e entrega cada parte a `each` assim que fica
/// pronta, para a memória não acumular. `each` devolve false para parar.
fn build_model(d: &mut Drawing, all: Vec<std::sync::Arc<cadcraft_doc::Entity>>, opts: &Options, mut each: impl FnMut(cadcraft_render::DisplayList) -> bool) {
    let mut memo = HashMap::new();
    let mut parts: Vec<Vec<std::sync::Arc<cadcraft_doc::Entity>>> = vec![Vec::new()];
    let mut cost = 0u64;
    for e in all {
        let c = 1 + expansion(d, &e, &mut memo, 0);
        if cost > 0 && cost.saturating_add(c) > PART_EXPANSION {
            parts.push(Vec::new());
            cost = 0;
        }
        cost = cost.saturating_add(c);
        if let Some(p) = parts.last_mut() {
            p.push(e);
        }
    }
    let full = std::mem::take(&mut d.model);
    for part in parts {
        let mut sub = cadcraft_doc::EntityStore::new();
        for e in part {
            sub.push((*e).clone());
        }
        d.model = sub;
        let list = cadcraft_render::build_plot(d, &Space::Model, opts);
        if !each(list) {
            break;
        }
    }
    d.model = full;
}

/// Traços de uma camada, já no formato do visualizador.
#[derive(Default)]
struct LayerBuf {
    line_pos: Vec<f32>,
    line_col: Vec<u32>,
    /// índices relativos aos vértices desta camada
    line_idx: Vec<u32>,
    tri_pos: Vec<f32>,
    tri_col: Vec<u32>,
    pt_pos: Vec<f32>,
    pt_col: Vec<u32>,
}

/// Recebe as partes montadas e converte na hora (coordenadas relativas à origem, em f32).
struct Sink {
    layers: Vec<LayerBuf>,
    origin: Vec2,
    far: f64,
    full: cadcraft_geom::Bounds2,
    images: u32,
    points: usize,
    truncated: bool,
}

impl Sink {
    fn new(n_layers: usize, robust: cadcraft_geom::Bounds2) -> Sink {
        Sink {
            layers: (0..n_layers).map(|_| LayerBuf::default()).collect(),
            origin: robust.center(),
            far: (robust.width().powi(2) + robust.height().powi(2)).sqrt().max(1e-9) * 20.0,
            full: cadcraft_geom::Bounds2::EMPTY,
            images: 0,
            points: 0,
            truncated: false,
        }
    }

    fn add(&mut self, list: &cadcraft_render::DisplayList) {
        use cadcraft_geom::Bounds2;
        let none = self.layers.len() - 1;
        let (ox, oy, far) = (self.origin.x, self.origin.y, self.far);
        let rel = |q: &Vec2| [(q.x - ox) as f32, (q.y - oy) as f32];
        let mut full = self.full;
        let mut grow = |q: &Vec2| {
            if q.x.is_finite() && q.y.is_finite() {
                full = full.union(&Bounds2::new(*q, *q));
            }
        };
        for (i, p) in list.prims.iter().enumerate() {
            let l = list.prim_layers.get(i).map(|&l| l as usize).filter(|&l| l < none).unwrap_or(none);
            let buf = &mut self.layers[l];
            let col = rgba(p.color.0, p.color.1, p.color.2, if p.aci7 { 254 } else { 255 });
            let (s, n) = (p.start as usize, p.len as usize);
            match p.kind {
                Kind::Polyline => {
                    let Some(pts) = list.verts.get(s..s + n) else { continue };
                    let base = (buf.line_pos.len() / 2) as u32;
                    let mut k = 0u32;
                    for q in pts {
                        if !(q.x.is_finite() && q.y.is_finite()) {
                            continue;
                        }
                        grow(q);
                        let [x, y] = rel(q);
                        buf.line_pos.push(x);
                        buf.line_pos.push(y);
                        buf.line_col.push(col);
                        if k > 0 {
                            buf.line_idx.push(base + k - 1);
                            buf.line_idx.push(base + k);
                        }
                        k += 1;
                    }
                }
                Kind::Infinite { ray } => {
                    let (Some(b), Some(dir)) = (list.verts.get(s), list.verts.get(s + 1)) else { continue };
                    let a = if ray { *b } else { Vec2::new(b.x - dir.x * far, b.y - dir.y * far) };
                    let z = Vec2::new(b.x + dir.x * far, b.y + dir.y * far);
                    let base = (buf.line_pos.len() / 2) as u32;
                    for q in [a, z] {
                        let [x, y] = rel(&q);
                        buf.line_pos.push(x);
                        buf.line_pos.push(y);
                        buf.line_col.push(col);
                    }
                    buf.line_idx.push(base);
                    buf.line_idx.push(base + 1);
                }
                Kind::Tris | Kind::Mask => {
                    let Some(pts) = list.tris.get(s..s + n) else { continue };
                    let c = if matches!(p.kind, Kind::Mask) { rgba(0, 0, 0, 253) } else { col };
                    for q in pts {
                        grow(q);
                        let [x, y] = rel(q);
                        buf.tri_pos.push(x);
                        buf.tri_pos.push(y);
                        buf.tri_col.push(c);
                    }
                }
                Kind::Point => {
                    let Some(q) = list.verts.get(s) else { continue };
                    grow(q);
                    let [x, y] = rel(q);
                    buf.pt_pos.push(x);
                    buf.pt_pos.push(y);
                    buf.pt_col.push(col);
                }
                Kind::Image { .. } => self.images += 1,
            }
        }
        self.full = full;
        self.points += list.verts.len() + list.tris.len();
        self.truncated |= list.truncated;
    }

    /// Cabeçalho (160 bytes) + seções, como descrito em `src/viewer/format.ts`.
    fn finish(mut self, robust: cadcraft_geom::Bounds2, sheet: Option<cadcraft_geom::Bounds2>, tol: f64) -> Vec<u8> {
        let n_layers = self.layers.len();
        let nv: usize = self.layers.iter().map(|l| l.line_col.len()).sum();
        let ni: usize = self.layers.iter().map(|l| l.line_idx.len()).sum();
        let nt: usize = self.layers.iter().map(|l| l.tri_col.len()).sum();
        let np: usize = self.layers.iter().map(|l| l.pt_col.len()).sum();
        let mut out: Vec<u8> = Vec::with_capacity(160 + 12 * (n_layers + 1) + nv * 12 + ni * 4 + nt * 12 + np * 12);
        let u32s = |o: &mut Vec<u8>, v: &[u32]| v.iter().for_each(|x| o.extend_from_slice(&x.to_le_bytes()));
        let f32s = |o: &mut Vec<u8>, v: &[f32]| v.iter().for_each(|x| o.extend_from_slice(&x.to_le_bytes()));
        let f64s = |o: &mut Vec<u8>, v: &[f64]| v.iter().for_each(|x| o.extend_from_slice(&x.to_le_bytes()));
        let flags = u32::from(self.truncated) | if self.images > 0 { 2 } else { 0 };
        u32s(&mut out, &[0x3156_4c50, 2, n_layers as u32, nv as u32, ni as u32, nt as u32, np as u32, flags]);
        f64s(&mut out, &[self.origin.x, self.origin.y]);
        let fb = if self.full.is_empty() { robust } else { self.full };
        f64s(&mut out, &[fb.min.x, fb.min.y, fb.max.x, fb.max.y]);
        f64s(&mut out, &[robust.min.x, robust.min.y, robust.max.x, robust.max.y]);
        let sh = sheet.map_or([f64::NAN; 4], |b| [b.min.x, b.min.y, b.max.x, b.max.y]);
        f64s(&mut out, &sh);
        f64s(&mut out, &[tol, 0.0]);
        // início de cada camada em cada seção
        for count in [|l: &LayerBuf| l.line_idx.len(), |l: &LayerBuf| l.tri_col.len(), |l: &LayerBuf| l.pt_col.len()] {
            let mut acc = 0u32;
            out.extend_from_slice(&acc.to_le_bytes());
            for l in &self.layers {
                acc += count(l) as u32;
                out.extend_from_slice(&acc.to_le_bytes());
            }
        }
        // vértices de linha de cada camada (os índices de cada uma são relativos aos seus)
        let vcount: Vec<u32> = self.layers.iter().map(|l| l.line_col.len() as u32).collect();
        // seções; cada parte é liberada assim que escrita
        for l in &mut self.layers {
            f32s(&mut out, &std::mem::take(&mut l.line_pos));
        }
        for l in &mut self.layers {
            u32s(&mut out, &std::mem::take(&mut l.line_col));
        }
        let mut base = 0u32;
        for (l, n) in self.layers.iter_mut().zip(&vcount) {
            for i in std::mem::take(&mut l.line_idx) {
                out.extend_from_slice(&(base + i).to_le_bytes());
            }
            base += n;
        }
        for l in &mut self.layers {
            f32s(&mut out, &std::mem::take(&mut l.tri_pos));
        }
        for l in &mut self.layers {
            u32s(&mut out, &std::mem::take(&mut l.tri_col));
        }
        for l in &mut self.layers {
            f32s(&mut out, &std::mem::take(&mut l.pt_pos));
        }
        for l in &mut self.layers {
            u32s(&mut out, &std::mem::take(&mut l.pt_col));
        }
        out
    }
}

/// Extensão robusta (2% a 98% das caixas, sem o lixo muito distante comum em DWG).
fn robust_of(boxes: &mut [[f64; 4]]) -> cadcraft_geom::Bounds2 {
    use cadcraft_geom::Bounds2;
    if boxes.is_empty() {
        return Bounds2::new(Vec2::new(0.0, 0.0), Vec2::new(1.0, 1.0));
    }
    let (lo, hi) = if boxes.len() > 50 { (0.02, 0.98) } else { (0.0, 1.0) };
    let col = |k: usize, p: f64| {
        let mut v: Vec<f64> = boxes.iter().map(|b| b[k]).collect();
        quantile(&mut v, p)
    };
    Bounds2::new(Vec2::new(col(0, lo), col(1, lo)), Vec2::new(col(2, hi), col(3, hi)))
}

fn display(d: &mut Drawing, space: i32, tolerance: f64, vx0: f64, vy0: f64, vx1: f64, vy1: f64) -> Vec<u8> {
    use cadcraft_geom::Bounds2;
    let sp = space_of(d, space);
    let windowed = matches!(sp, Space::Model) && vx0.is_finite() && vy0.is_finite() && vx1.is_finite() && vy1.is_finite();
    let ext = d.extents(&sp);
    let diag = if ext.is_empty() { 1.0 } else { (ext.width().powi(2) + ext.height().powi(2)).sqrt().max(1e-9) };
    // automática: ~meio pixel com o desenho inteiro numa tela grande (ao aproximar, o
    // visualizador pede a região visível com tolerância menor)
    let tol = if tolerance > 0.0 { tolerance } else { diag / 8000.0 };
    let win = Bounds2::new(Vec2::new(vx0, vy0), Vec2::new(vx1, vy1));
    let opts = Options {
        tolerance: tol,
        min_dash: tol * 6.0,
        text: true,
        linetypes: true,
        fill: true,
        lineweights: false,
        view: if windowed { Some(win) } else { None },
        ..Options::default()
    };
    // Camadas como no arquivo (desligadas e congeladas ficam de fora, como no AutoCAD: um bloco
    // inserido numa camada congelada some inteiro), exceto as que o visualizador mandou mostrar.
    // A montagem "de plotagem" informa a camada de cada traço, inclusive dentro de blocos.
    let saved: Vec<(bool, bool)> = d.layers.iter().map(|l| (l.on, l.frozen)).collect();
    FORCED.with(|f| {
        for (l, &on) in d.layers.iter_mut().zip(f.borrow().iter()) {
            if on != 0 {
                l.on = true;
                l.frozen = false;
            }
        }
    });
    let n_layers = d.layers.len() + 1; // a última: traços sem camada conhecida
    let (sink, robust, sheet) = if matches!(sp, Space::Model) {
        // objetos a montar (no detalhe, só os que tocam a janela) e o enquadramento pelas caixas
        let mut cache = cadcraft_doc::BlockBoundsCache::default();
        let mut ents = Vec::new();
        let mut boxes = Vec::new();
        for e in d.model.iter() {
            let b = cadcraft_doc::extent_bounds_cached(d, e, &mut cache);
            if windowed && !(b.is_empty() || (b.max.x >= win.min.x && b.min.x <= win.max.x && b.max.y >= win.min.y && b.min.y <= win.max.y)) {
                continue;
            }
            let shown = d.layer(&e.common.layer).is_none_or(|l| l.on && !l.frozen) && e.common.visible;
            if shown && !b.is_empty() && [b.min.x, b.min.y, b.max.x, b.max.y].iter().all(|v| v.is_finite()) {
                boxes.push([b.min.x, b.min.y, b.max.x, b.max.y]);
            }
            ents.push(e.clone());
        }
        let robust = robust_of(&mut boxes);
        drop(boxes);
        let mut sink = Sink::new(n_layers, robust);
        build_model(d, ents, &opts, |list| {
            sink.add(&list);
            if sink.points > MAX_TOTAL_POINTS {
                // memória: o resto aparece no detalhe ao aproximar
                sink.truncated = true;
                return false;
            }
            true
        });
        (sink, robust, None)
    } else {
        let list = cadcraft_render::build_plot(d, &sp, &opts);
        let mut boxes: Vec<[f64; 4]> = list
            .prims
            .iter()
            .filter_map(|p| {
                let b = Bounds2::from_points(list.points(p).iter().copied().filter(|q| q.x.is_finite() && q.y.is_finite()));
                (!b.is_empty()).then_some([b.min.x, b.min.y, b.max.x, b.max.y])
            })
            .collect();
        // folha: o enquadramento é o papel
        let sheet = list.sheet.as_ref().map(cadcraft_render::Sheet::bounds).filter(|b| !b.is_empty() && b.width() > 0.0 && b.height() > 0.0);
        let robust = sheet.unwrap_or_else(|| robust_of(&mut boxes));
        let mut sink = Sink::new(n_layers, robust);
        sink.add(&list);
        (sink, robust, sheet)
    };
    for (l, (on, frozen)) in d.layers.iter_mut().zip(saved) {
        l.on = on;
        l.frozen = frozen;
    }
    sink.finish(robust, sheet, tol)
}

// ---------------------------------------------------------------------------------------------
// Estrutura intermediária para o editor do ProjetaLivre (o mesmo formato que o leitor anterior
// produzia; a conversão para os objetos editáveis continua em src/io/raw.ts, função fromRaw).
// O JSON é escrito direto num texto (sem montar árvores de valores), o que é ~10× mais rápido.

use cadcraft_color::Color;
use cadcraft_doc::{Entity, EntityKind, HAlign, VAlign};

/// Gera o JSON `{ layers, entities, paper, blocks, angleDeg: false, skipped }` do desenho aberto.
#[unsafe(no_mangle)]
pub extern "C" fn pl_raw() -> i32 {
    DRAWING.with(|s| {
        let s = s.borrow();
        let Some(d) = s.as_ref() else {
            set_result(b"nenhum desenho aberto".to_vec());
            return 1;
        };
        set_result(raw_doc(d).into_bytes());
        0
    })
}

/// Escritor de JSON.
struct W {
    b: String,
    num: ryu::Buffer,
}

impl W {
    fn raw(&mut self, s: &str) {
        self.b.push_str(s);
    }
    fn num(&mut self, v: f64) {
        if v.is_finite() {
            let s = self.num.format_finite(v);
            self.b.push_str(s.strip_suffix(".0").unwrap_or(s));
        } else {
            self.b.push('0');
        }
    }
    fn int(&mut self, v: i64) {
        self.b.push_str(&v.to_string());
    }
    fn str(&mut self, s: &str) {
        self.b.push('"');
        for c in s.chars() {
            match c {
                '"' => self.b.push_str("\\\""),
                '\\' => self.b.push_str("\\\\"),
                '\n' => self.b.push_str("\\n"),
                '\r' => self.b.push_str("\\r"),
                '\t' => self.b.push_str("\\t"),
                c if (c as u32) < 0x20 => self.b.push_str(&format!("\\u{:04x}", c as u32)),
                c => self.b.push(c),
            }
        }
        self.b.push('"');
    }
    /// `,"chave":`
    fn k(&mut self, key: &str) {
        self.b.push_str(",\"");
        self.b.push_str(key);
        self.b.push_str("\":");
    }
    fn kn(&mut self, key: &str, v: f64) {
        self.k(key);
        self.num(v);
    }
    fn pt(&mut self, x: f64, y: f64) {
        self.b.push_str("{\"x\":");
        self.num(x);
        self.b.push_str(",\"y\":");
        self.num(y);
        self.b.push('}');
    }
    fn kpt(&mut self, key: &str, x: f64, y: f64) {
        self.k(key);
        self.pt(x, y);
    }
    fn pts<'a>(&mut self, it: impl IntoIterator<Item = &'a Vec2>) {
        self.b.push('[');
        for (i, q) in it.into_iter().enumerate() {
            if i > 0 {
                self.b.push(',');
            }
            self.pt(q.x, q.y);
        }
        self.b.push(']');
    }
}

use cadcraft_geom::Vec2;

/// Cor própria no formato intermediário: None = da camada (ausente), Some(None) = do bloco
/// (null), Some(Some(rgb)) = própria.
fn own_color(c: Color) -> Option<Option<(u8, u8, u8)>> {
    match c {
        Color::ByLayer => None,
        Color::ByBlock => Some(None),
        c => {
            let rgb = c.resolve(Color::Index(7), Color::Index(7));
            Some(Some((rgb.0, rgb.1, rgb.2)))
        }
    }
}

/// Cor de uma peça (de tabela, de cota): "do bloco" quer dizer a cor do próprio objeto.
fn piece_color(c: Color, ent: Color) -> Color {
    if matches!(c, Color::ByBlock) { ent } else { c }
}

struct Raw<'a> {
    d: &'a Drawing,
    opts: Options,
    skipped: HashMap<&'static str, u32>,
    w: W,
    in_block: bool,
}

impl Raw<'_> {
    /// Abre um objeto: separador do vetor, tipo, camada e cor.
    fn open(&mut self, n: &mut usize, kind: &str, layer: &str, color: Option<Option<(u8, u8, u8)>>) {
        if *n > 0 {
            self.w.raw(",");
        }
        *n += 1;
        self.w.raw("{\"type\":\"");
        self.w.raw(kind);
        self.w.raw("\",\"layer\":");
        self.w.str(layer);
        match color {
            None => {}
            Some(None) => self.w.raw(",\"_color\":null"),
            Some(Some((r, g, b))) => {
                self.w.k("_color");
                self.w.raw(&format!("\"#{r:02x}{g:02x}{b:02x}\""));
            }
        }
    }

    fn open_e(&mut self, n: &mut usize, e: &Entity, kind: &str) {
        self.open(n, kind, &e.common.layer, own_color(e.common.color));
    }

    fn close(&mut self) {
        self.w.raw("}");
    }

    fn text_fields(&mut self, t: &cadcraft_doc::Text, invisible: bool) {
        let ha = match t.halign {
            HAlign::Left => 0,
            HAlign::Center => 1,
            HAlign::Right => 2,
            HAlign::Aligned => 3,
            HAlign::Middle => 4,
            HAlign::Fit => 5,
        };
        let va = match t.valign {
            VAlign::Baseline => 0,
            VAlign::Bottom => 1,
            VAlign::Middle => 2,
            VAlign::Top => 3,
        };
        self.w.k("text");
        self.w.str(&t.value);
        self.w.kn("textHeight", t.height);
        self.w.kpt("startPoint", t.insert.x, t.insert.y);
        if let Some(a) = t.align_pt {
            self.w.kpt("endPoint", a.x, a.y);
        }
        self.w.kn("rotation", t.rotation);
        self.w.kn("halign", f64::from(ha));
        self.w.kn("valign", f64::from(va));
        if invisible {
            self.w.raw(",\"invisible\":true");
        }
    }

    fn mtext(&mut self, n: &mut usize, layer: &str, color: Option<Option<(u8, u8, u8)>>, t: &cadcraft_doc::MText) {
        self.open(n, "MTEXT", layer, color);
        self.w.k("text");
        self.w.str(&t.contents);
        self.w.kn("height", t.height);
        self.w.kpt("position", t.insert.x, t.insert.y);
        self.w.kn("rotation", t.rotation);
        self.w.kn("attachmentPoint", f64::from(t.attach.clamp(1, 9)));
        self.close();
    }

    fn line(&mut self, n: &mut usize, layer: &str, color: Option<Option<(u8, u8, u8)>>, pts: &[Vec2]) {
        if pts.len() < 2 {
            return;
        }
        self.open(n, if pts.len() == 2 { "LINE" } else { "LWPOLYLINE" }, layer, color);
        self.w.k("vertices");
        self.w.pts(pts);
        if pts.len() > 2 {
            self.w.raw(",\"shape\":false");
        }
        self.close();
    }

    /// Hachura sólida com um contorno por polígono.
    fn solid_fill<'a>(&mut self, n: &mut usize, layer: &str, color: Option<Option<(u8, u8, u8)>>, loops: impl Iterator<Item = &'a [Vec2]>) {
        let mut first = true;
        for l in loops {
            if l.len() < 3 {
                continue;
            }
            if first {
                self.open(n, "HATCH", layer, color);
                self.w.raw(",\"solidFill\":1,\"patternName\":\"SOLID\",\"boundaryPaths\":[");
                first = false;
            } else {
                self.w.raw(",");
            }
            self.w.raw("{\"boundaryPathTypeFlag\":2,\"isClosed\":true,\"vertices\":");
            self.w.pts(l);
            self.w.raw("}");
        }
        if !first {
            self.w.raw("]}");
        }
    }

    /// Uma entidade do CADCraft no formato intermediário (pode virar várias, no caso genérico).
    fn entity(&mut self, e: &Entity, n: &mut usize) {
        if !e.common.visible {
            return;
        }
        match &e.kind {
            EntityKind::Line(l) => {
                self.open_e(n, e, "LINE");
                self.w.k("vertices");
                self.w.raw("[");
                self.w.pt(l.a.x, l.a.y);
                self.w.raw(",");
                self.w.pt(l.b.x, l.b.y);
                self.w.raw("]");
            }
            EntityKind::Circle(c) => {
                self.open_e(n, e, "CIRCLE");
                self.w.kpt("center", c.center.x, c.center.y);
                self.w.kn("radius", c.radius);
            }
            EntityKind::Arc(a) => {
                self.open_e(n, e, "ARC");
                self.w.kpt("center", a.center.x, a.center.y);
                self.w.kn("radius", a.radius);
                self.w.kn("startAngle", a.start);
                self.w.kn("endAngle", a.end);
            }
            EntityKind::Ellipse(el) => {
                self.open_e(n, e, "ELLIPSE");
                self.w.kpt("center", el.center.x, el.center.y);
                self.w.kpt("majorAxisEndPoint", el.major.x, el.major.y);
                self.w.kn("axisRatio", el.ratio);
                self.w.kn("startAngle", el.start);
                self.w.kn("endAngle", el.end);
            }
            EntityKind::LwPolyline(p) => {
                self.open_e(n, e, "LWPOLYLINE");
                self.w.k("vertices");
                self.w.raw("[");
                for (i, v) in p.vertices.iter().enumerate() {
                    if i > 0 {
                        self.w.raw(",");
                    }
                    self.w.raw("{\"x\":");
                    self.w.num(v.p.x);
                    self.w.raw(",\"y\":");
                    self.w.num(v.p.y);
                    if v.bulge != 0.0 {
                        self.w.kn("bulge", v.bulge);
                    }
                    self.w.raw("}");
                }
                self.w.raw("]");
                self.w.raw(if p.closed { ",\"shape\":true" } else { ",\"shape\":false" });
            }
            EntityKind::Polyline3d(p) => {
                self.open_e(n, e, "POLYLINE");
                self.w.k("vertices");
                self.w.raw("[");
                for (i, q) in p.points.iter().enumerate() {
                    if i > 0 {
                        self.w.raw(",");
                    }
                    self.w.pt(q.x, q.y);
                }
                self.w.raw("]");
                self.w.raw(if p.closed { ",\"shape\":true" } else { ",\"shape\":false" });
            }
            EntityKind::Point(p) => {
                self.open_e(n, e, "POINT");
                self.w.kpt("position", p.p.x, p.p.y);
            }
            EntityKind::Text(t) => {
                self.open_e(n, e, "TEXT");
                self.text_fields(t, false);
            }
            EntityKind::MText(t) => {
                self.mtext(n, &e.common.layer, own_color(e.common.color), t);
                return;
            }
            EntityKind::Solid(s) | EntityKind::Trace(s) => {
                self.open_e(n, e, "SOLID");
                self.w.k("points");
                self.w.raw("[");
                for (i, q) in s.corners.iter().enumerate() {
                    if i > 0 {
                        self.w.raw(",");
                    }
                    self.w.pt(q.x, q.y);
                }
                self.w.raw("]");
            }
            EntityKind::Face3d(f) => {
                self.open_e(n, e, "3DFACE");
                self.w.k("points");
                self.w.raw("[");
                for (i, q) in f.corners.iter().enumerate() {
                    if i > 0 {
                        self.w.raw(",");
                    }
                    self.w.pt(q.x, q.y);
                }
                self.w.raw("]");
            }
            EntityKind::Insert(i) if self.d.blocks.contains_key(&i.block) => {
                self.open_e(n, e, "INSERT");
                self.w.k("name");
                self.w.str(&i.block);
                self.w.kpt("position", i.insert.x, i.insert.y);
                self.w.kn("xScale", i.scale.x);
                self.w.kn("yScale", i.scale.y);
                self.w.kn("rotation", i.rotation);
                self.w.kn("columnCount", f64::from(i.cols.max(1)));
                self.w.kn("rowCount", f64::from(i.rows.max(1)));
                self.w.kn("columnSpacing", i.col_spacing);
                self.w.kn("rowSpacing", i.row_spacing);
                self.w.k("attribs");
                self.w.raw("[");
                let mut na = 0usize;
                for a in &i.attribs {
                    self.open_e(&mut na, e, "TEXT");
                    self.text_fields(&a.text, a.invisible);
                    self.close();
                }
                self.w.raw("]");
            }
            EntityKind::Dimension(dm) => {
                if dm.block.as_ref().is_some_and(|b| self.d.blocks.contains_key(b)) {
                    self.open_e(n, e, "DIMENSION");
                    self.w.k("block");
                    self.w.str(dm.block.as_deref().unwrap_or_default());
                } else {
                    self.dimension(e, dm, n);
                    return;
                }
            }
            EntityKind::Hatch(h) => {
                self.open_e(n, e, "HATCH");
                self.w.k("boundaryPaths");
                self.w.raw("[");
                for (li, l) in h.loops.iter().enumerate() {
                    if li > 0 {
                        self.w.raw(",");
                    }
                    self.w.raw("{\"boundaryPathTypeFlag\":2,\"isClosed\":true,\"vertices\":[");
                    for (i, v) in l.vertices.iter().enumerate() {
                        if i > 0 {
                            self.w.raw(",");
                        }
                        self.w.raw("{\"x\":");
                        self.w.num(v.p.x);
                        self.w.raw(",\"y\":");
                        self.w.num(v.p.y);
                        if v.bulge != 0.0 {
                            self.w.kn("bulge", v.bulge);
                        }
                        self.w.raw("}");
                    }
                    self.w.raw("]}");
                }
                self.w.raw("]");
                self.w.kn("solidFill", if h.solid || h.gradient.is_some() { 1.0 } else { 0.0 });
                self.w.k("patternName");
                self.w.str(&h.pattern);
                if !h.solid {
                    let lib;
                    let lines = if h.pattern_lines.is_empty() {
                        lib = cadcraft_doc::library::pattern(&h.pattern).map(|p| p.lines).unwrap_or_default();
                        &lib
                    } else {
                        &h.pattern_lines
                    };
                    let k = if h.scale.is_finite() && h.scale > 1e-12 { h.scale } else { 1.0 };
                    let (ca, sa) = (h.angle.cos(), h.angle.sin());
                    self.w.k("definitionLines");
                    self.w.raw("[");
                    for (i, f) in lines.iter().enumerate() {
                        if i > 0 {
                            self.w.raw(",");
                        }
                        let th = f.angle.to_radians() + h.angle;
                        let (c, s) = (th.cos(), th.sin());
                        // origem da família girada e escalada com a hachura
                        let (ox, oy) = (f.origin.0 * k, f.origin.1 * k);
                        // deslocamento (ao longo, espaçamento) no sentido da linha → vetor no mundo
                        let (al, sp) = (f.delta.0 * k, f.delta.1 * k);
                        self.w.raw("{\"angle\":");
                        self.w.num(th);
                        self.w.kpt("base", h.origin.x + ox * ca - oy * sa, h.origin.y + ox * sa + oy * ca);
                        self.w.kpt("offset", al * c - sp * s, al * s + sp * c);
                        self.w.raw("}");
                    }
                    self.w.raw("]");
                }
            }
            EntityKind::Leader(l) => {
                self.open_e(n, e, "LEADER");
                self.w.k("vertices");
                self.w.raw("[");
                for (i, q) in l.vertices.iter().enumerate() {
                    if i > 0 {
                        self.w.raw(",");
                    }
                    self.w.pt(q.x, q.y);
                }
                self.w.raw("]");
            }
            EntityKind::Ray(r) | EntityKind::XLine(r) => {
                self.open_e(n, e, if matches!(e.kind, EntityKind::Ray(_)) { "RAY" } else { "XLINE" });
                let len = (r.dir.x.powi(2) + r.dir.y.powi(2)).sqrt().max(1e-300);
                self.w.kpt("firstPoint", r.base.x, r.base.y);
                self.w.kpt("unitDirection", r.dir.x / len, r.dir.y / len);
            }
            // definição de atributo solta no desenho: aparece o nome (dentro de blocos, nada)
            EntityKind::AttDef(a) if !self.in_block => {
                let tag = cadcraft_doc::Text { value: a.tag.clone(), ..a.text.clone() };
                self.open_e(n, e, "TEXT");
                self.text_fields(&tag, false);
            }
            EntityKind::Viewport(_) | EntityKind::AttDef(_) => return,
            EntityKind::Image(_) => {
                *self.skipped.entry("IMAGE").or_default() += 1;
                return;
            }
            EntityKind::MLeader(ml) => {
                // linhas, seta e bloco pelo renderizador; o texto continua um texto editável
                let mut bare = e.clone();
                if let EntityKind::MLeader(m) = &mut bare.kind {
                    m.text = None;
                }
                self.generic(&bare, n);
                if let Some(t) = &ml.text {
                    self.mtext(n, &e.common.layer, own_color(e.common.color), t);
                }
                return;
            }
            EntityKind::Table(t) => {
                self.table(e, t, n);
                return;
            }
            // o resto (tolerâncias, multilinhas, splines, hélices, regiões, malhas, proxies…):
            // a geometria que o renderizador do CADCraft desenha
            _ => {
                self.generic(e, n);
                return;
            }
        }
        self.close();
    }

    /// Cota sem bloco: linhas e setas geradas pelo CADCraft, e o valor como texto editável.
    fn dimension(&mut self, e: &Entity, dm: &cadcraft_doc::Dimension, n: &mut usize) {
        let g = cadcraft_render::dimension_in(self.d, dm);
        let layer = e.common.layer.clone();
        let col = own_color(e.common.color);
        for l in &g.lines {
            self.line(n, &layer, col, l);
        }
        self.solid_fill(n, &layer, col, g.fills.iter().map(Vec::as_slice));
        if !g.value.trim().is_empty() && g.text_height > 0.0 {
            self.open(n, "TEXT", &layer, col);
            self.w.k("text");
            self.w.str(&g.value);
            self.w.kn("textHeight", g.text_height);
            self.w.kpt("startPoint", g.text_pos.x, g.text_pos.y);
            self.w.kpt("endPoint", g.text_pos.x, g.text_pos.y);
            self.w.kn("rotation", g.text_angle);
            self.w.raw(",\"halign\":1,\"valign\":2}");
        }
    }

    /// Tabela: linhas e fundos das células, e o texto de cada célula como texto editável.
    fn table(&mut self, e: &Entity, t: &cadcraft_doc::Table, n: &mut usize) {
        let g = cadcraft_render::table_geometry(self.d, t);
        let layer = e.common.layer.clone();
        for f in &g.fills {
            self.solid_fill(n, &layer, own_color(piece_color(f.color, e.common.color)), std::iter::once(&f.corners[..]));
        }
        for l in &g.lines {
            self.line(n, &layer, own_color(piece_color(l.color, e.common.color)), &[l.a, l.b]);
        }
        for tx in &g.texts {
            if tx.text.trim().is_empty() {
                continue;
            }
            self.open(n, "MTEXT", &layer, own_color(piece_color(tx.color, e.common.color)));
            self.w.k("text");
            self.w.str(&tx.text);
            self.w.kn("height", tx.height);
            self.w.kpt("position", tx.at.x, tx.at.y);
            self.w.raw(",\"rotation\":0");
            self.w.kn("attachmentPoint", f64::from(tx.attach.clamp(1, 9)));
            self.close();
        }
    }

    /// Converte o que o renderizador desenha para a entidade: traços viram polilinhas,
    /// preenchimentos viram hachuras sólidas, pontos viram pontos.
    fn generic(&mut self, e: &Entity, n: &mut usize) {
        let list = cadcraft_render::build_entities(self.d, [e], &self.opts);
        let layer_rgb = self.d.layer(&e.common.layer).map(|l| l.color.resolve(l.color, l.color));
        for p in &list.prims {
            let col = if !p.aci7 && Some(p.color) != layer_rgb { Some(Some((p.color.0, p.color.1, p.color.2))) } else { None };
            let (s, len) = (p.start as usize, p.len as usize);
            match p.kind {
                Kind::Polyline => {
                    let Some(pts) = list.verts.get(s..s + len) else { continue };
                    self.line(n, &e.common.layer, col, pts);
                }
                Kind::Tris | Kind::Mask => {
                    let Some(pts) = list.tris.get(s..s + len) else { continue };
                    self.solid_fill(n, &e.common.layer, col, pts.chunks_exact(3));
                }
                Kind::Point => {
                    let Some(q) = list.verts.get(s) else { continue };
                    self.open(n, "POINT", &e.common.layer, col);
                    self.w.kpt("position", q.x, q.y);
                    self.close();
                }
                _ => {}
            }
        }
    }
}

fn raw_doc(d: &Drawing) -> String {
    let ext = d.extents(&Space::Model);
    let diag = if ext.is_empty() { 1.0 } else { (ext.width().powi(2) + ext.height().powi(2)).sqrt().max(1e-9) };
    let tol = diag / 20000.0;
    let opts = Options { tolerance: tol, min_dash: 0.0, text: true, linetypes: false, fill: true, lineweights: false, ..Options::default() };
    let cap = 64 + d.model.len() * 120;
    let mut r = Raw { d, opts, skipped: HashMap::new(), in_block: false, w: W { b: String::with_capacity(cap), num: ryu::Buffer::new() } };
    r.w.raw("{\"angleDeg\":false,\"layers\":[");
    for (i, l) in d.layers.iter().enumerate() {
        if i > 0 {
            r.w.raw(",");
        }
        let rgb = l.color.resolve(l.color, l.color);
        r.w.raw("{\"name\":");
        r.w.str(&l.name);
        r.w.raw(&format!(",\"color\":\"#{:02x}{:02x}{:02x}\"", rgb.0, rgb.1, rgb.2));
        r.w.raw(if l.on && !l.frozen { ",\"visible\":true" } else { ",\"visible\":false" });
        r.w.raw(if l.frozen { ",\"frozen\":true" } else { ",\"frozen\":false" });
        r.w.raw(if l.locked { ",\"locked\":true}" } else { ",\"locked\":false}" });
    }
    r.w.raw("],\"entities\":[");
    let mut n = 0;
    for e in d.model.iter() {
        r.entity(e, &mut n);
    }
    r.w.raw("],\"blocks\":{");
    for (bi, (name, b)) in d.blocks.iter().enumerate() {
        if bi > 0 {
            r.w.raw(",");
        }
        r.w.str(name);
        r.w.raw(":{\"base\":");
        r.w.pt(b.base.x, b.base.y);
        r.w.raw(",\"entities\":[");
        let mut n = 0;
        r.in_block = true;
        for e in b.entities.iter() {
            r.entity(e, &mut n);
        }
        r.in_block = false;
        r.w.raw("]}");
    }
    // folha ativa (ou a primeira pela ordem das abas)
    let layout = d
        .active_layout
        .as_ref()
        .and_then(|nm| d.layouts.iter().find(|l| &l.name == nm))
        .or_else(|| d.layouts.iter().min_by_key(|l| l.tab_order));
    r.w.raw("},\"paper\":[");
    if let Some(l) = layout {
        let mut n = 0;
        for e in l.entities.iter() {
            r.entity(e, &mut n);
        }
    }
    r.w.raw("],\"skipped\":{");
    let skipped: Vec<_> = r.skipped.iter().map(|(k, v)| (*k, *v)).collect();
    for (i, (k, v)) in skipped.into_iter().enumerate() {
        if i > 0 {
            r.w.raw(",");
        }
        r.w.str(k);
        r.w.raw(":");
        r.w.int(i64::from(v));
    }
    r.w.raw("}}");
    r.w.b
}
