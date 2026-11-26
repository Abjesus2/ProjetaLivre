# Leitor CADCraft do ProjetaLivre (WebAssembly)

Esta pasta compila o leitor e o renderizador do **[CADCraft](https://github.com/storytold/cadcraft)**
(MIT OR Apache-2.0) para WebAssembly. O resultado, `src/io/cadcraft/projetalivre_cadcraft.wasm`,
é usado pelo site em dois caminhos, sempre dentro de um Web Worker:

- **Editar** (`pl_raw`): lê DWG/DXF e entrega a estrutura intermediária em JSON que
  `src/io/raw.ts` (`fromRaw`) transforma nos objetos editáveis. Os leitores anteriores
  (dxf-parser e LibreDWG) continuam como reserva, usados só se o CADCraft falhar.
- **Só visualizar** (`pl_display`): entrega a lista de desenho do renderizador do CADCraft
  (blocos, cotas, hachuras, textos e tipos de linha já expandidos; cor e camada de cada traço)
  num formato binário que vai direto para a placa de vídeo. Formato descrito em
  `src/viewer/format.ts`. Ao aproximar muito, o visualizador pede de novo só a região visível,
  com mais detalhe.

A interface com o JavaScript não usa wasm-bindgen: são funções `extern "C"` (ver `src/lib.rs`) e
o módulo não importa nada do JavaScript. A ponte em TypeScript está em `src/io/cadcraft/bridge.ts`.

## Recompilar

```sh
rustup target add wasm32-unknown-unknown   # uma vez
npm run build:cadcraft                     # = sh cadcraft-wasm/build.sh
```

O script compila (`cargo build --release --target wasm32-unknown-unknown`) e reduz o arquivo com
o `wasm-opt -Oz` do binaryen (via `npx`). O `.wasm` resultante fica versionado no repositório,
então o site e o `npm run build` não precisam de Rust.

Versões fixadas: CADCraft `0d4b100`, craft-libs `453b0da` (ver `Cargo.toml` e `Cargo.lock`).

## Cópias modificadas (`vendor/`)

- `vendor/craft-dwg`: cópia do `craft-dwg` (storytold/craft-libs, MIT OR Apache-2.0). Única
  mudança: o leitor de DWG (acadrust) também é compilado para WebAssembly, sem threads, rodando
  no próprio processo. No navegador o isolamento é o Web Worker: se um arquivo derrubar a
  leitura, só o worker cai e o site mostra o erro.
- `vendor/web-time`: substituto mínimo do crate `web-time` (o acadrust só mede durações para
  registro); no WebAssembly sem wasm-bindgen não há relógio e tudo devolve zero.

## Licenças

| Componente | Licença | Texto |
|---|---|---|
| Esta ponte (`src/lib.rs`) | GPL-3.0-or-later (como o ProjetaLivre) | `../LICENSE` |
| CADCraft (cadcraft-io, -doc, -render, -geom, -color) | MIT OR Apache-2.0 | `licenses/CADCraft-LICENSE-MIT`, `licenses/CADCraft-LICENSE-APACHE` |
| craft-libs (craft-dwg, craft-dxf e outros) | MIT OR Apache-2.0 | `licenses/craft-libs-LICENSE-MIT` |
| [acadrust](https://github.com/hakanaktt/acadrust) 0.6.6 (leitura de DWG), sem modificações | MPL-2.0 | `licenses/acadrust-LICENSE-MPL-2.0`, `licenses/acadrust-THIRD_PARTY_NOTICES.md` |

O código-fonte do acadrust usado está no crates.io (`acadrust` 0.6.6) e no repositório acima.
As demais dependências (lista completa no `Cargo.lock`) usam licenças permissivas compatíveis com
a GPL-3.0: MIT, Apache-2.0, BSD, Zlib, 0BSD, Unlicense, Unicode-3.0, BSL-1.0 e IJG.

AutoCAD e DWG são marcas da Autodesk, Inc. O ProjetaLivre e o CADCraft não têm relação com a
Autodesk.
