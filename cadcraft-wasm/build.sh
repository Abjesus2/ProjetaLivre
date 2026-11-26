#!/bin/sh
# Recompila o leitor CADCraft para WebAssembly e coloca o resultado em src/io/cadcraft/.
# Precisa de: Rust com o alvo wasm32 (rustup target add wasm32-unknown-unknown) e Node.js
# (o wasm-opt do binaryen, que reduz ~13% o tamanho, vem pelo npx).
set -eu
cd "$(dirname "$0")"
cargo build --release --target wasm32-unknown-unknown
out="${CARGO_TARGET_DIR:-target}/wasm32-unknown-unknown/release/projetalivre_cadcraft.wasm"
npx --yes -p binaryen@123.0.0 wasm-opt -Oz \
  --enable-bulk-memory --enable-sign-ext --enable-mutable-globals --enable-nontrapping-float-to-int \
  "$out" -o ../src/io/cadcraft/projetalivre_cadcraft.wasm
ls -l ../src/io/cadcraft/projetalivre_cadcraft.wasm
