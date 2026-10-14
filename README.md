# ProjetaLivre

**CAD 2D livre, direto no navegador.** Abra desenhos **DWG**, **DXF** e **SVG**, edite com
ferramentas no estilo AutoCAD (linha de comando, snaps, grips, camadas, cotas) e salve em
**10 formatos**. Tudo roda no seu computador: nenhum arquivo é enviado a servidor.

## Pesquisa: em que o projeto se apoia

Antes de escrever o editor, pesquisei projetos abertos que reproduzem funções do AutoCAD:

| Projeto | O que é | Como entrou no ProjetaLivre |
|---|---|---|
| [LibreDWG](https://www.gnu.org/software/libredwg/) / [libredwg-web](https://github.com/mlightcad/libredwg-web) | Leitor de DWG (GNU) compilado para WebAssembly | **Abrir DWG** (R13–2018), direto no navegador |
| [mlightcad/cad-viewer](https://github.com/mlightcad/cad-viewer) | Visualizador/editor DWG/DXF web (Vue + THREE.js) | Referência de arquitetura: tudo no cliente, sem backend |
| [dxf-parser](https://github.com/gdsestimating/dxf-parser) | Leitor de DXF em JavaScript | **Abrir DXF** |
| [dxfjs/writer](https://github.com/dxfjs/writer) (`@tarikjabiri/dxf`) | Gerador de DXF | **Salvar DXF** (abre no AutoCAD, LibreCAD, QCAD) |
| [jsPDF](https://github.com/parallax/jsPDF) | Geração de PDF | **Salvar PDF** em A4–A0, ajustado ou em escala 1:N |
| [LibreCAD](https://librecad.org) / [QCAD](https://qcad.org) | CADs 2D de desktop | Inspiração para o conjunto de comandos e o fluxo de trabalho |

O núcleo de desenho (geometria, snaps, interseções, aparar, deslocar, grips, renderização e
animações) foi escrito para este projeto, em TypeScript, sem framework.

## Recursos

- **Abrir:** DWG, DXF, SVG e `.plv` (formato nativo). Também por arrastar e soltar.
- **Salvar como:** `.plv`, `.dxf`, `.svg`, `.pdf`, `.png`, `.jpg`, `.webp`, `.plt` (HPGL para plotters),
  `.gcode` (laser/CNC) e `.geojson` (SIG).
- **Desenhar:** linha, polilinha, retângulo, círculo, arco por 3 pontos, elipse, polígono, ponto.
- **Anotar:** texto, cota alinhada, medir distância, área.
- **Modificar:** mover, copiar, rotacionar, escala, espelhar, deslocar (offset), aparar (trim),
  matriz, explodir, apagar; edição por grips (arrastar pontos de controle).
- **Precisão:** snaps de extremidade, meio, centro, quadrante e interseção; modo orto; snap de grade;
  coordenadas `x,y`, `@dx,dy`, `@dist<ângulo` ou só a distância na direção do cursor.
- **Camadas:** cor, mostrar/ocultar, travar, renomear, camada atual.
- **Propriedades:** edição numérica de cada objeto (coordenadas, raio, ângulos, texto…).
- Desfazer/refazer, copiar/colar, rascunho salvo automaticamente no navegador.
- Visual próprio ("Tinta Elétrica"): botões hexagonais, menu radial, traços que se desenham como
  tinta, objetos que se desfazem em partículas ao apagar, tema tinta/papel e portal com
  título traçado por uma "pena de plotter".

## Comandos (digite na barra de baixo, como no AutoCAD)

| Comando | Atalhos |
|---|---|
| Linha | `L` · `LINHA` |
| Polilinha | `PL` |
| Retângulo | `REC` |
| Círculo | `C` (depois `D` para diâmetro) |
| Arco | `A` |
| Elipse / Polígono / Ponto | `EL` · `POL` · `PO` |
| Texto / Cota | `T` · `DIM` |
| Mover / Copiar / Rotacionar / Escala / Espelhar | `M` · `CO` · `RO` · `SC` · `MI` |
| Deslocar / Aparar / Matriz / Explodir / Apagar | `O` · `TR` · `AR` · `X` · `E` |
| Medir / Área / Enquadrar | `DI` · `AA` · `Z` |

Enter ou Espaço confirma (e repete o último comando), Esc cancela, botão direito abre o menu
radial, roda do mouse dá zoom, botão do meio (ou Alt+arrastar, ou dois dedos) move a vista.
`F3` snap · `F7` grade · `F8` orto · `F9` snap de grade · `F10` modo leve · `F1` ajuda.

## Desempenho e computadores fracos

- Editar não refaz o desenho inteiro: só a região que mudou é redesenhada, o desfazer guarda só
  o que mudou (não uma cópia do arquivo) e o índice espacial é atualizado aos poucos.
- Seleções e prévias com milhares de objetos (mover, girar, escala, espelhar) são desenhadas de
  uma vez, pela matriz da transformação, sem recriar cada objeto a cada movimento do mouse.
- Parado, o programa quase não usa CPU: a tela só é redesenhada quando algo muda e as animações
  de enfeite param depois de alguns segundos sem uso.
- **Modo leve** (botão **LEVE** na barra de baixo ou `F10`): tira brilhos, animações, o desfoque
  atrás dos painéis e a textura da tela, usa resolução 1× e mostra textos muito pequenos como
  traços. Liga sozinho em computadores com pouca memória ou poucos núcleos, ou se a tela ficar
  lenta enquanto você edita; a escolha feita no botão fica guardada no navegador.

## Rodar localmente

```bash
npm install
npm run dev      # servidor de desenvolvimento
npm run build    # gera o site estático em dist/
npm run preview  # serve o dist/ para conferir
npm test         # testes (desfazer, índice espacial, geometria)
```

## Publicar

O site é 100% estático (a pasta `dist/`). O workflow `.github/workflows/deploy.yml` publica no
**GitHub Pages** a cada push na `main` — basta ativar em *Settings → Pages → Source: GitHub Actions*.
Também funciona em Netlify, Vercel, Render ou qualquer hospedagem de arquivos.

## Limitações conhecidas

- **Salvar em DWG** não é possível no navegador hoje (o LibreDWG para web é compilado sem escrita).
  Salve em **DXF**, que o AutoCAD abre normalmente, e use "Salvar como DWG" lá se precisar.
- Hachuras, tabelas, sólidos 3D e imagens raster de arquivos DWG/DXF ainda não são exibidos.
- Textos usam uma fonte monoespaçada; a largura pode diferir um pouco da fonte original do desenho.

## Licença

GPL-3.0-or-later (veja `LICENSE`) — compatível com o LibreDWG, que é GPL-3.0.
