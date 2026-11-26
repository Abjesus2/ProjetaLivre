//! Objetos fora do plano XY (extrusão inclinada: uma vista lateral inserida "em pé" num desenho
//! 3D, um telhado inclinado…): referências de bloco, círculos, arcos e elipses.
//!
//! O leitor do CADCraft guarda as referências de bloco como foram lidas, com o plano do bloco
//! deitado sobre o XY ("needs the full 3D block transform, which Insert cannot hold"), e leva só o
//! centro de círculos e arcos para o lugar certo; o renderizador desenha tudo isso deitado na
//! planta: aparecem linhas compridas e círculos que o AutoCAD, olhando de cima, mostra de perfil
//! (reduzidos a uma linha) ou inclinados (encurtados, círculos viram elipses).
//!
//! Aqui cada uma é desenhada pelo próprio renderizador no plano dela e então projetada na planta
//! (o mesmo que o AutoCAD mostra na vista de cima). O resultado vira um bloco novo, plano, e a
//! referência original é trocada por uma referência comum a ele, na mesma camada, com a mesma cor
//! e as mesmas propriedades: camadas congeladas, cores "do bloco" e a camada 0 continuam valendo.
//! Referências iguais (mesmo bloco, mesma orientação e escala) compartilham o bloco projetado.

use std::collections::HashMap;
use std::sync::Arc;

use cadcraft_color::{Color, Rgb};
use cadcraft_doc::{Drawing, Entity, EntityKind, EntityStore, Space};
use cadcraft_geom::{PolyVertex, Vec2, Vec3};
use cadcraft_render::{Kind, Options};

/// Camada e cor de marcação: o conteúdo na camada 0 do bloco e o conteúdo com cor "do bloco"
/// saem do renderizador com elas e voltam a ser camada 0 e cor "do bloco".
const MARK_LAYER: &str = "\u{1}projetalivre-plano";
const MARK_RGB: Rgb = Rgb(1, 254, 3);

/// Extrusão fora do eixo Z (o espelhamento, (0,0,-1), o leitor já resolve).
fn is_tilted(n: Vec3) -> bool {
    let h = n.x.hypot(n.y);
    h.is_finite() && n.z.is_finite() && h > 1e-9 && h > 1e-3 * n.z.abs()
}

fn tilted_insert(e: &Entity) -> bool {
    matches!(e.kind, EntityKind::Insert(_) | EntityKind::Circle(_) | EntityKind::Arc(_) | EntityKind::Ellipse(_)) && is_tilted(e.common.extrusion)
}

/// Eixos do sistema do objeto (algoritmo do eixo arbitrário do DXF).
fn ocs_axes(n: Vec3) -> (Vec3, Vec3, Vec3) {
    let unit = |v: Vec3| {
        let l = v.len().max(1e-300);
        Vec3::new(v.x / l, v.y / l, v.z / l)
    };
    let n = unit(n);
    let ax = unit(if n.x.abs() < 1.0 / 64.0 && n.y.abs() < 1.0 / 64.0 { Vec3::new(0.0, 1.0, 0.0).cross(n) } else { Vec3::Z.cross(n) });
    let ay = n.cross(ax);
    (ax, ay, n)
}

/// Projeta todas as referências inclinadas (no modelo, nas folhas e dentro de blocos).
/// Devolve quantas foram projetadas.
pub fn bake(d: &mut Drawing) -> usize {
    let any = d.model.iter().any(|e| tilted_insert(e))
        || d.blocks.values().any(|b| b.entities.iter().any(|e| tilted_insert(e)))
        || d.layouts.iter().any(|l| l.entities.iter().any(|e| tilted_insert(e)));
    if !any {
        return 0;
    }
    let ext = d.extents(&Space::Model);
    let diag = if ext.is_empty() { 1.0 } else { (ext.width().powi(2) + ext.height().powi(2)).sqrt().max(1e-9) };
    let mut b = Baker { tol: diag / 20000.0, shared: HashMap::new(), done: HashMap::new(), count: 0 };
    // todas as camadas ligadas enquanto o conteúdo é desenhado: o que aparece depois é decidido
    // pela camada de cada traço
    let saved: Vec<(bool, bool)> = d.layers.iter().map(|l| (l.on, l.frozen)).collect();
    for l in d.layers.iter_mut() {
        l.on = true;
        l.frozen = false;
    }
    // blocos de dentro para fora: um bloco projetado já leva os blocos internos corrigidos
    let names: Vec<String> = d.blocks.keys().cloned().collect();
    for n in &names {
        b.block(d, n, 0);
    }
    let model: Vec<Arc<Entity>> = d.model.iter().filter(|e| tilted_insert(e)).cloned().collect();
    for e in model {
        let ne = b.project(d, &e);
        d.model.replace(ne);
    }
    for li in 0..d.layouts.len() {
        let ents: Vec<Arc<Entity>> = d.layouts[li].entities.iter().filter(|e| tilted_insert(e)).cloned().collect();
        for e in ents {
            let ne = b.project(d, &e);
            d.layouts[li].entities.replace(ne);
        }
    }
    for (l, (on, frozen)) in d.layers.iter_mut().zip(saved) {
        l.on = on;
        l.frozen = frozen;
    }
    b.count
}

struct Baker {
    tol: f64,
    /// (bloco, orientação, escala…) → bloco projetado
    shared: HashMap<String, String>,
    /// blocos já revisados
    done: HashMap<String, ()>,
    count: usize,
}

impl Baker {
    fn block(&mut self, d: &mut Drawing, name: &str, depth: usize) {
        let key = name.to_ascii_lowercase();
        if depth > cadcraft_doc::MAX_BLOCK_DEPTH || self.done.insert(key, ()).is_some() {
            return;
        }
        let Some(b) = d.block(name).cloned() else { return };
        for e in b.entities.iter() {
            if let EntityKind::Insert(i) = &e.kind {
                self.block(d, &i.block, depth + 1);
            }
        }
        let tilted: Vec<Arc<Entity>> = b.entities.iter().filter(|e| tilted_insert(e)).cloned().collect();
        if tilted.is_empty() {
            return;
        }
        let mut store = b.entities.clone();
        for e in tilted {
            let ne = self.project(d, &e);
            store.replace(ne);
        }
        let Some(real) = d.blocks.keys().find(|k| k.eq_ignore_ascii_case(name)).cloned() else { return };
        let mut nb = (*b).clone();
        nb.entities = store;
        d.blocks.insert(real, Arc::new(nb));
    }

    /// O objeto `e` (inclinado) trocado por uma referência plana ao bloco com a sua projeção.
    fn project(&mut self, d: &mut Drawing, e: &Entity) -> Entity {
        let (ax, ay, n) = ocs_axes(e.common.extrusion);
        let EntityKind::Insert(ins) = &e.kind else { return self.project_curve(d, e, (ax, ay, n)) };
        // a mesma orientação do mesmo bloco gera o mesmo desenho (os atributos variam: sem partilha)
        let key = format!(
            "{}|{:?}|{:?}|{:?}|{}|{}|{}|{}|{}",
            ins.block.to_ascii_lowercase(),
            (n.x.to_bits(), n.y.to_bits(), n.z.to_bits()),
            ins.rotation.to_bits(),
            (ins.scale.x.to_bits(), ins.scale.y.to_bits()),
            ins.cols,
            ins.rows,
            ins.col_spacing.to_bits(),
            ins.row_spacing.to_bits(),
            ins.clip.is_some()
        );
        let shareable = ins.attribs.is_empty() && ins.clip.is_none();
        let name = match self.shared.get(&key).filter(|_| shareable) {
            Some(n) => n.clone(),
            None => {
                if d.block(&ins.block).is_none() {
                    return e.clone();
                }
                let mut flat = e.clone();
                if let EntityKind::Insert(i) = &mut flat.kind {
                    // os atributos ficam onde estão, relativos ao ponto de inserção
                    let off = Vec3::new(-i.insert.x, -i.insert.y, 0.0);
                    for a in &mut i.attribs {
                        a.text.insert = Vec3::new(a.text.insert.x + off.x, a.text.insert.y + off.y, a.text.insert.z);
                        if let Some(q) = a.text.align_pt.as_mut() {
                            *q = Vec3::new(q.x + off.x, q.y + off.y, q.z);
                        }
                    }
                    i.insert = Vec3::ZERO;
                }
                let Some(n) = self.render(d, flat, (ax, ay), Vec2::ZERO) else { return e.clone() };
                if shareable {
                    self.shared.insert(key, n.clone());
                }
                n
            }
        };
        self.count += 1;
        // ponto de inserção: do sistema do objeto para o mundo, visto de cima
        let p = ins.insert;
        let at = Vec3::new(p.x * ax.x + p.y * ay.x + p.z * n.x, p.x * ax.y + p.y * ay.y + p.z * n.y, 0.0);
        let mut ne = e.clone();
        ne.common.extrusion = Vec3::Z;
        ne.kind = EntityKind::Insert(cadcraft_doc::Insert {
            block: name,
            insert: at,
            scale: Vec3::new(1.0, 1.0, 1.0),
            rotation: 0.0,
            attribs: Vec::new(),
            cols: 1,
            rows: 1,
            col_spacing: 0.0,
            row_spacing: 0.0,
            clip: None,
        });
        ne
    }

    /// Círculo, arco ou elipse inclinado: desenhado no plano dele e projetado (sem partilha).
    fn project_curve(&mut self, d: &mut Drawing, e: &Entity, (ax, ay, n): (Vec3, Vec3, Vec3)) -> Entity {
        // do mundo para o sistema do objeto (eixos ortonormais)
        let to_ocs = |p: Vec3| Vec3::new(p.dot(ax), p.dot(ay), p.dot(n));
        let mut flat = e.clone();
        let elevation = match &mut flat.kind {
            EntityKind::Circle(c) => {
                let p = to_ocs(c.center);
                c.center = Vec3::new(p.x, p.y, 0.0);
                p.z
            }
            EntityKind::Arc(a) => {
                let p = to_ocs(a.center);
                a.center = Vec3::new(p.x, p.y, 0.0);
                if e.common.extrusion.z < 0.0 {
                    // o leitor inverteu os ângulos supondo um plano espelhado; desfaz
                    let (s, t) = (std::f64::consts::PI - a.end, std::f64::consts::PI - a.start);
                    a.start = cadcraft_geom::norm_angle(s);
                    a.end = cadcraft_geom::norm_angle(t);
                }
                p.z
            }
            EntityKind::Ellipse(el) => {
                let p = to_ocs(el.center);
                let m = to_ocs(el.major);
                el.center = Vec3::new(p.x, p.y, 0.0);
                el.major = Vec3::new(m.x, m.y, 0.0);
                if e.common.extrusion.z < 0.0 && (cadcraft_geom::ccw_sweep(el.start, el.end) - std::f64::consts::TAU).abs() > 1e-9 {
                    let (s, t) = (-el.end, -el.start);
                    el.start = cadcraft_geom::norm_angle(s);
                    el.end = cadcraft_geom::norm_angle(t);
                }
                p.z
            }
            _ => return e.clone(),
        };
        let Some(name) = self.render(d, flat, (ax, ay), Vec2::new(elevation * n.x, elevation * n.y)) else { return e.clone() };
        self.count += 1;
        let mut ne = e.clone();
        ne.common.extrusion = Vec3::Z;
        ne.kind = EntityKind::Insert(cadcraft_doc::Insert {
            block: name,
            insert: Vec3::ZERO,
            scale: Vec3::new(1.0, 1.0, 1.0),
            rotation: 0.0,
            attribs: Vec::new(),
            cols: 1,
            rows: 1,
            col_spacing: 0.0,
            row_spacing: 0.0,
            clip: None,
        });
        ne
    }

    /// Desenha `flat` (o objeto já no seu próprio plano, com extrusão Z), projeta na planta
    /// (`offset` somado) e guarda como bloco novo. Devolve o nome do bloco.
    fn render(&mut self, d: &mut Drawing, mut flat: Entity, (ax, ay): (Vec3, Vec3), offset: Vec2) -> Option<String> {
        flat.common.extrusion = Vec3::Z;
        flat.common.layer = MARK_LAYER.into();
        flat.common.color = Color::True(MARK_RGB);
        let opts = Options { tolerance: self.tol, min_dash: 0.0, text: true, linetypes: true, fill: true, lineweights: false, ..Options::default() };
        let mut st = EntityStore::new();
        st.push(flat);
        let model = std::mem::replace(&mut d.model, st);
        let list = cadcraft_render::build_plot(d, &Space::Model, &opts);
        d.model = model;

        let proj = |q: &Vec2| Vec2::new(q.x * ax.x + q.y * ay.x + offset.x, q.x * ax.y + q.y * ay.y + offset.y);
        let layer_rgb: Vec<Rgb> = d.layers.iter().map(|l| l.color.resolve(l.color, l.color)).collect();
        let mut ents: Vec<(String, Color, EntityKind)> = Vec::new();
        for (k, p) in list.prims.iter().enumerate() {
            let li = list.prim_layers.get(k).copied().map(|l| l as usize).filter(|&l| l < d.layers.len());
            let layer = li.map_or_else(|| "0".to_string(), |l| d.layers[l].name.clone());
            let color = if p.color == MARK_RGB {
                Color::ByBlock
            } else if li.is_some_and(|l| layer_rgb[l] == p.color) || (li.is_none() && p.aci7) {
                Color::ByLayer
            } else if p.aci7 {
                Color::Index(7)
            } else {
                Color::True(p.color)
            };
            let (s, len) = (p.start as usize, p.len as usize);
            match p.kind {
                Kind::Polyline => {
                    let Some(pts) = list.verts.get(s..s + len) else { continue };
                    let mut v: Vec<Vec2> = Vec::with_capacity(pts.len());
                    for q in pts.iter().filter(|q| q.x.is_finite() && q.y.is_finite()) {
                        let q = proj(q);
                        if v.last().is_none_or(|l| (l.x - q.x).abs() + (l.y - q.y).abs() > 1e-12) {
                            v.push(q);
                        }
                    }
                    match v.len() {
                        0 | 1 => {}
                        2 => ents.push((layer, color, EntityKind::Line(cadcraft_doc::Line { a: Vec3::new(v[0].x, v[0].y, 0.0), b: Vec3::new(v[1].x, v[1].y, 0.0) }))),
                        _ => ents.push((
                            layer,
                            color,
                            EntityKind::LwPolyline(cadcraft_doc::LwPolyline {
                                vertices: v.into_iter().map(|q| PolyVertex { p: q, ..PolyVertex::default() }).collect(),
                                closed: false,
                                const_width: 0.0,
                                elevation: 0.0,
                                plinegen: false,
                            }),
                        )),
                    }
                }
                Kind::Tris | Kind::Mask => {
                    let Some(pts) = list.tris.get(s..s + len) else { continue };
                    for t in pts.chunks_exact(3) {
                        let [a, b, c] = [proj(&t[0]), proj(&t[1]), proj(&t[2])];
                        // triângulo achatado (plano de perfil) não preenche nada
                        if ((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)).abs() < 1e-18 {
                            continue;
                        }
                        let v3 = |q: Vec2| Vec3::new(q.x, q.y, 0.0);
                        ents.push((layer.clone(), color, EntityKind::Solid(cadcraft_doc::Solid { corners: [v3(a), v3(b), v3(c), v3(c)] })));
                    }
                }
                Kind::Point => {
                    let Some(q) = list.verts.get(s) else { continue };
                    let q = proj(q);
                    ents.push((layer, color, EntityKind::Point(cadcraft_doc::Point { p: Vec3::new(q.x, q.y, 0.0), angle: 0.0 })));
                }
                Kind::Infinite { ray } => {
                    let (Some(b), Some(dir)) = (list.verts.get(s), list.verts.get(s + 1)) else { continue };
                    let (b, dir) = (proj(b), Vec2::new(dir.x * ax.x + dir.y * ay.x, dir.x * ax.y + dir.y * ay.y));
                    if dir.x.hypot(dir.y) < 1e-12 {
                        continue;
                    }
                    let r = cadcraft_doc::RayLine { base: Vec3::new(b.x, b.y, 0.0), dir: Vec3::new(dir.x, dir.y, 0.0) };
                    ents.push((layer, color, if ray { EntityKind::Ray(r) } else { EntityKind::XLine(r) }));
                }
                Kind::Image { .. } => {}
            }
        }
        let mut store = EntityStore::new();
        for (layer, color, kind) in ents {
            let mut ent = Entity::new(d.new_handle(), kind);
            ent.common.layer = layer;
            ent.common.color = color;
            store.push(ent);
        }
        let name = format!("*PLV{}", d.new_handle().0);
        let mut nb = cadcraft_doc::Block::new(&name);
        nb.entities = store;
        d.blocks.insert(name.clone(), Arc::new(nb));
        Some(name)
    }
}
