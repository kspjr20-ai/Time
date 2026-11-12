# Rota no Shopping · Salvador Norte

PWA de navegação a pé dentro do Salvador Norte Shopping. Sem GPS: você informa a
loja onde está e a loja de destino, e o app desenha a rota sobre a planta do
piso, com as trocas de piso (escada rolante, elevador, esteira).

- `index.html` – app de navegação (busca de loja, rota por A*, passo a passo, opção sem escada rolante, funciona offline).
- `editor.html` – editor do grafo (nós, arestas, lojas, trocas de piso) com exportação em JSON.
- `data/mall.json` – pisos, nós, arestas e lojas. É o arquivo que o editor exporta.
- `maps/*.webp` – planta de cada piso.
- `tools/` – scripts que geraram os dados iniciais a partir do mapa oficial.

## Rodar

É um site estático, sem build:

```sh
cd shopping && python3 -m http.server 8000
# app:    http://localhost:8000/
# editor: http://localhost:8000/editor.html
```

Para instalar no celular como app, a pasta precisa estar publicada em HTTPS
(GitHub Pages serve).

## Corrigir o mapa

1. Abra `editor.html` (melhor no computador).
2. Ferramentas: **Nó** (N), **Aresta** (E), **Loja** (L), **Troca de piso** (T), **Selecionar** (V). Delete apaga, Ctrl+Z desfaz.
3. **Verificar grafo** lista lojas sem caminho e nós soltos.
4. **Testar no app** abre o app usando o rascunho, sem publicar.
5. **Exportar JSON** baixa `mall.json`; substitua `data/mall.json` e aumente `VERSION` em `sw.js`.

## Formato do `mall.json`

```jsonc
{
  "meta":   { "name": "...", "pxPerMeter": 9.5 },
  "floors": [{ "id": "L1", "name": "L1", "level": 1, "image": "maps/l1.webp", "width": 2926, "height": 2070 }],
  "nodes":  [{ "id": 0, "f": "L1", "x": 1950.8, "y": 864.3, "t": "c" }],   // t: c (corredor), door, escalator, elevator, stairs, ramp
  "edges":  [{ "a": 0, "b": 1, "t": "walk" }],                              // t: walk, escalator, elevator, stairs, ramp
  "pois":   [{ "id": "p0", "name": "...", "f": "L1", "x": 0, "y": 0, "node": 12, "group": "Moda", "cat": "...", "poly": [x0, y0, x1, y1] }]
}
```

Coordenadas em pixels da imagem do piso. `node` é o nó da porta da loja.

## Origem dos dados e limites

Plantas, posições das lojas, corredores e trocas de piso vieram do mapa oficial
do shopping (`salvadornorteshopping.com.br/mapa-de-lojas`), em novembro de 2026.
Esse material pertence ao shopping e ao fornecedor do mapa: para uso além do
pessoal, peça autorização.

- A porta de cada loja foi estimada (ponto da loja mais próximo de um corredor); em lojas grandes pode estar no lado errado.
- Distâncias e tempos são aproximados (escala estimada em ~9,5 px por metro).
- Na garagem G1 só há caminhos mapeados perto dos acessos; por isso alguns pontos do G1 não têm rota sem escada rolante.
- Lojas mudam: refaça os dados com `tools/` ou ajuste no editor.
