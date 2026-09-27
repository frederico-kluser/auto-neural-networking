# CONTRACTS.md — Demo "auto-neural-networking" (labirinto + rede que evolui)

Contrato de interfaces entre módulos. **Todos os subagents devem respeitar exatamente** os nomes,
assinaturas e invariantes abaixo. Nenhum módulo pode importar de outro fora do que está declarado.

## Layout de ficheiros (dono de cada ficheiro = um único subagent)

```
demo/
  CONTRACTS.md              (este ficheiro — NÃO editar)
  core/
    rng.mjs                 [A]
    maze.mjs                [A]
    sensors.mjs             [A]
    network.mjs             [B]
    ops.mjs                 [B]
    evolution.mjs           [B]
    index.mjs               [A e B: export barrel — A cria, B acrescenta as suas linhas em patch único]
  tests/
    unit-core.mjs           [A] testes unitários de rng/maze/sensors
    unit-net.mjs            [B] testes unitários de network/ops/evolution
    validate.mjs            [INTEGRAÇÃO] harness completo (fase 2)
  web/
    index.html              [C]
    styles.css              [C]
    vendor/three.module.js  [C] (copiado de npm three@0.16x.x)
    vendor/OrbitControls.js [C]
    src/state.js            [C] store central (pub/sub simples)
    src/main.js             [INTEGRAÇÃO]
    src/viz/neural3d.js     [D]
    src/viz/maze3d.js       [E]
    src/ui/controls.js      [F]
    src/ui/stats.js         [F]
    src/worker/trainer.worker.js [F]
  package.json              [C]
  README.md                 [INTEGRAÇÃO]
```

Regras: ESM puro (`.mjs`/`.js` com `type: module`), zero dependências em `core/` (só stdlib JS),
`core/` tem de correr em Node ≥ 20 sem DOM. Ficheiros são owned por um só agente; nunca editar
ficheiros de outro domínio.

## core/rng.mjs [A]

```js
export function makeRng(seed = 1) // seed: number inteiro
// retorna { next(): number em [0,1), int(n): inteiro em [0,n), range(a,b), pick(arr), seed }
```
Determinístico para o mesmo seed (mulberry32 ou xorshift — escolha livre, testada).

## core/maze.mjs [A]

```js
export function generateMaze(cols, rows, seed = 1, opts = {}) => Maze
export function solveMaze(maze) => Array<{x,y}> | null   // caminho BFS start→exit (inclui start e exit)
export function rayInfo(maze, x, y, dir) => { dist, exitVisible }
```

- `Maze`: `{ cols, rows, seed, grid: Uint8Array(cols*rows), start: {x,y}, exit: {x,y}, isWall(x,y), idx(x,y) }`.
  `grid[i] === 1` é parede. Fronteira do labirinto é sempre parede. `start = {x:1,y:1}`,
  `exit = {x:cols-2, y:rows-2}` (portanto `cols`/`rows` têm de ser ímpares e ≥ 5; clampar se necessário).
- Geração: *recursive backtracker* (DFS com stack) sobre células ímpares → labirinto perfeito
  (exatamente um caminho entre qualquer par de células). Determinístico para o mesmo `seed`+tamanho.
- Coordenadas: `x` cresce para a direita, `y` cresce para baixo. Direções (ordem canónica em todo o projeto):
  `0=up (y-1)`, `1=down (y+1)`, `2=left (x-1)`, `3=right (x+1)`. Exportar também `export const DIRS = ['up','down','left','right']` e `export const DIR_VEC = [[0,-1],[0,1],[-1,0],[1,0]]`.
- `rayInfo(maze, x, y, dir)`: caminha a partir de `(x,y)` na direção `dir`; `dist` = número de células
  abertas até à primeira parede (mínimo 1; se a célula adjacente for parede, `dist = 0`... NÃO: usar
  definição seguinte) — **definição exata**: `dist` = quantas células consecutivas abertas existem
  começando na célula adjacente (adjacente parede ⇒ `dist = 0`; adjacente aberta e a seguinte parede ⇒ `dist = 1`).
  `exitVisible` = `true` se o `exit` estiver estritamente nessa linha/coluna e nenhuma parede existir
  entre `(x,y)` e o exit nessa direção.

## core/sensors.mjs [A]

```js
export const EXIT_SIGNAL = 1.0
export function sense(maze, x, y) => Float32Array(8)
export const SENSOR_NAMES = ['parede↑','parede↓','parede←','parede→','saída↑','saída↓','saída←','saída→']
```

- Índices 0..3: distância à parede em cada direção, **normalizada por `Math.max(maze.cols, maze.rows)`**
  e clipada a [0,1]. Usa `rayInfo(...).dist`.
- Índices 4..7: `EXIT_SIGNAL` se `rayInfo(...).exitVisible` nessa direção, senão `0`.
- Mais NADA entra na rede: o agente não vê posição, direção, mapa nem saída fora destes 8 valores.

## core/network.mjs [B]

Rede do projeto (README §2.1–2.2): slots de neurónios sem camadas, dinâmica leaky-tanh.

```js
export function makeNetwork({ nInputs = 8, nOutputs = 4, seed = 1, nSlots = 8 } = {}) => Net
export function resetNet(net)                  // zera estado h
export function step(net, inputArr) => Float32Array(nOutputs)   // 1 tick; inputArr: array-like length nInputs
export function cloneNet(net) => Net           // deep copy (inclui h)
export function countNeurons(net) => number    // alive
export function countConns(net) => number      // M[i][j]===1
export function spectralRadius(net) => number  // estimativa por potência (máx ~40 iters)
export function spectralThermostat(net, target = 0.95) => number  // escala W⊙M se ρ̂ > target; devolve ρ̂ final
```

`Net` (campos públicos, mutáveis por ops.mjs):
- `nIn, nOut, nSlots` (nSlots máx. 256; começa pequeno e cresce por mutação)
- `alive: Uint8Array(nSlots)` — no arranque só o slot 0 está vivo
- `W: Float64Array(nSlots*nSlots)`, `M: Uint8Array(nSlots*nSlots)` — `M[i*nSlots+j]=1` ⇒ ligação i→j
- `b: Float64Array(nSlots)`, `alpha: number` (vazamento, arranque 0.25; 0 < alpha ≤ 1)
- `h: Float64Array(nSlots)` (estado atual)
- `W_in: Float64Array(nIn*nSlots)`, `M_in: Uint8Array(nIn*nSlots)`
- `W_out: Float64Array(nSlots*nOut)`, `M_out: Uint8Array(nSlots*nOut)`, `b_out: Float64Array(nOut)`
- Invariante: `M[i][j] === 0 ⇒ W[i*nSlots+j] === 0`; `M_in[k][j] === 0 ⇒ W_in[...] === 0`; idem out.

Dinâmica por tick (exatamente):
```
drive_j = Σ_k in[k]·W_in[k][j]·M_in[k][j] + b_j
h_j ← (1−α)·h_j + α·tanh( h·(W⊙M)_col_j + drive_j )      (só j vivo; mortos ficam a 0)
y_i = Σ_j h_j·W_out[j][i]·M_out[j][i] + b_out[i]
```
Arranque minimalista: só o neurónio 0 vivo, ligado de todos os inputs e para todos os outputs
(pesos pequenos ~ U(−0.5,0.5)), `b=0`.

## core/ops.mjs [B]

```js
export const OP_NAMES = ['addNeuron','addConn','removeConn','rewire','pruneNeuron','changeLeak','splitNeuron','perturbWeights']
export function applyOp(net, opName, rng) => boolean  // true se aplicada; preserva invariantes
export function makeOperatorBank(rng) => {
  pick(): opName,                       // adaptive pursuit (Thierens 2005): P_min=0.05, β=0.3
  update(opName, reward /* ≥ 0 */),
  probs(): Float32Array(OP_NAMES.length),
  stats(): { opName: { p, q, count } }
}
```
- `addNeuron`: usa 1 slot morto (se não houver, false); liga 1 input→novo e novo→1 output (ou a 1
  neurónio vivo); pesos de entrada U(−0.5,0.5), saída = **0** (preserva função).
- `addConn`: cria `i→j` inexistente (inclui autoconexão) com peso **0**.
- `removeConn`: remove a conexão existente de menor |w|.
- `rewire`: `i→j` passa a `i→k`; peso novo = 0.
- `pruneNeuron`: desliga (alive=0) o neurónio vivo (≠0) de menor contribuição (aprox.: soma |h_j·W_out|
  numa amostra; pode usar heurística barata por pesos), limpa M/M_in/M_out associadas.
- `changeLeak`: `alpha *= 0.8` ou `*1.25`, clipado a [0.02, 1].
- `splitNeuron`: duplica um neurónio vivo para um slot morto (copia entradas; divide saídas por 2).
- `perturbWeights`: escolhe 1 a 4 pesos **com máscara ativa** (sorteando entre `W_in`, `W`, `W_out`, `b`, `b_out`)
  e soma ruído gaussiano N(0, 0.25) (soma uniforme equivalente é aceitável). É a única op que altera
  valores de pesos existentes e, por isso, a única que torna funcionais as ligações nascidas a 0
  (`addConn`, `addNeuron`, `rewire`). Sem ela, os neurónios novos ficariam inertes para sempre.
- Nenhuma op pode deixar a rede sem neurónios vivos ou sem caminho input→output (pelo menos o slot 0).

## core/evolution.mjs [B]

```js
export const STEP_TICKS = 3          // ticks de rede por decisão de movimento
export function runEpisode(net, maze, opts = {}) => {
  solved: boolean, steps: number, path: Array<{x,y}>, fitness: number,
  sensorTrace: Array<Float32Array> | null   // só se opts.trace === true
}
export function evaluate(net, mazes, opts) => number   // média de runEpisode(...).fitness
export function evolve(config, hooks = {}) => { best, bestNet, history, bankStats, generations }
```

- `runEpisode`: resetNet; por passo: `sense()` → alimenta a rede `STEP_TICKS` ticks →
  direção = argmax(y) do último tick → move se a célula destino não for parede (senão fica, penalidade).
  Máx. `opts.maxSteps` (defeito `maze.cols*maze.rows*2`). Revisitar célula: −0.005.
- **Fitness (exato)** — função exportada `fitnessOf({solved, steps, maxSteps, startDist, endDist, visited, openCells})`:
  - `startDist` = manhattan(start, exit), `endDist` = manhattan(posFinal, exit),
    `visited` = células visitadas distintas, `openCells` = total de células abertas do labirinto.
  - `solved === true` ⇒ `1.5 + (1 − steps/maxSteps) + 0.5*(visited/openCells)`
  - `solved === false` ⇒ `(1 − endDist/startDist)*1.0 − steps*0.002 + 0.25*(visited/openCells)`
  - Colocar literalmente este cálculo em `fitnessOf` e usá-lo em `runEpisode`. Chegada à saída ⇒ `solved=true` e o episódio termina.
- `evolve({ population=60, generations=50, mazes, seed=1, elite=6, mutationRate=0.9 })`:
  por geração: avaliar todos em todos os `mazes` (fitness = média), elitismo dos `elite` melhores,
  resto = cópias do elite + **1 a 3 ops** de `applyOp` (banco adaptativo, uma op por sorteio) quando
  `rng.next() < mutationRate`; `hooks.onGeneration(gen, stats)` é chamado a cada geração;
  `hooks.shouldStop(stats)` pode abortar. `history`: array de `{ gen, best, mean, nNeurons, nConns }`.
- Determinístico para o mesmo `seed`.

## web/src/state.js [C]

```js
export const store = {
  get(), set(patch), subscribe(fn) => unsubscribe
}
```
Estado inicial (formas livres, mas estas chaves existem):
`{ training: 'idle'|'running'|'paused', generation, bestFitness, meanFitness, mazeSize, seed,
   bankStats, nNeurons, nConns, episode: { x, y, path, sensors, outputs, solved } | null, speed: 1 }`

## Worker [F] — `web/src/worker/trainer.worker.js`

- Importa `core/*` (caminho relativo `../../..`) e corre `evolve` em lotes de gerações.
- Mensagens recebidas: `{ type:'init', config }` (config = {population, generations, mazes?: tamanhos, seed, elite, mutationRate, mazeSize}),
  `{ type:'run', generations }`, `{ type:'pause' }`, `{ type:'resume' }`, `{ type:'reset', config? }`, `{ type:'setSpeed', gensPerBatch }`.
- Mensagens enviadas: `{ type:'generation', stats: { gen, best, mean, nNeurons, nConns, bankProbs } }` (1 por geração),
  `{ type:'best', net }` quando o melhor global melhora (net = objeto Net clonado via structured clone; NÃO serializar à mão),
  `{ type:'done', summary }` ao terminar as gerações pedidas. `pause`/`resume` implementados com flag verificada entre gerações.
- O worker NUNCA toca no DOM. O treino corre inteiramente aqui.

## Playback ao vivo [INTEGRAÇÃO — main.js]

- O episódio animado (agente a mover-se + atividade da rede) corre na UI thread em `requestAnimationFrame`,
  importando `core/sensors.mjs`, `core/network.mjs` e `core/evolution.mjs` diretamente: por frame avança
  `speed` passos de episódio (`sense` → `STEP_TICKS` ticks de `step` → argmax → move), chamando
  `mazeView.updateAgent({x, y, path, sensors})` e `neuralView.update(net, { h: net.h, y })`.
- `net.h` é o estado interno da rede (Float64Array) — passa-se tal e qual; a viz usa-o para colorir pulsos.

## web/src/ui/controls.js [F]

```js
export function mountControls(store, actions) => { destroy() }
// actions (fornecido por main.js): { train(), pause(), reset(), setSpeed(n), setMazeSize(n), setSeed(n) }
```

## web/src/ui/stats.js [F]

```js
export function mountStats(store) => { destroy() }
```
- Subscreve o store e atualiza os elementos DOM já existentes no `index.html` de C (usa os ids documentados
  no comentário do topo do index.html). Inclui a sparkline de fitness em `<canvas id="spark-fitness">`
  (canvas 2D próprio, sem libs) e as barras de sensores/saída.

## Visualização 3D [D] — `web/src/viz/neural3d.js`

```js
export function createNeuralView(container) => {
  update(net, activity),     // activity: { h: Float64Array, y: Float32Array, pulse?: {from,to}[] }
  resize(), dispose(), setCameraPreset(name)
}
```
- Three.js vendored (`../vendor/`). Desempenho obrigatório: neurónios em `InstancedMesh`,
  ligações em um único `LineSegments` com vertex colors + blending aditivo, pulsos de sinal via
  shader (uniform `uTime`) ou pontos instanciados — **sem** criar meshes por frame. ≥ 55 fps com
  256 neurónios e ~2000 ligações. Sem OrbitControls no worker; controlo de câmara orbit simples.

## Visualização 3D [E] — `web/src/viz/maze3d.js`

```js
export function createMazeView(container) => {
  setMaze(maze), updateAgent({ x, y, path, sensors }), resize(), dispose()
}
```
- Paredes em `InstancedMesh`, agente (esfera/box) e saída distintos, raios dos sensores como
  linhas coloridas com comprimento proporcional à distância medida.

## UI [F] — `web/src/ui/controls.js` + `stats.js`

- Painel de controlo: tamanho do labirinto (5×5 … 31×31, ímpares), seed, população, gerações,
  velocidade (1×/4×/16×/máx), botões Treinar/Pausar/Reiniciar, opção "rede campeã" vs "episódio ao vivo".
- Painel de estatísticas: fitness (best/mean) por geração (sparkline canvas própria, sem libs),
  nº de neurónios/conexões, probabilidades do banco de operações, sensores atuais (8 barras), saída da rede (4 valores).
- Linguagem da UI: **português (pt-PT)**. Design: dark-tech editorial, sem em-dashes (`—`) na copy,
  sem gradientes AI-purple, sem cards genéricos, mono para números.

## Validação (fase 2) — `tests/validate.mjs` [INTEGRAÇÃO]

Corre com `node demo/tests/validate.mjs` e termina exit 0 só se TODOS os checks passarem:
1. Labirintos: fronteira fechada, start/exit abertos, perfeito (BFS resolve, caminho único), determinismo por seed, vários tamanhos.
2. Sensores: casos construídos à mão (corredor, célula aberta, saída visível/invisível).
3. Rede: determinismo, invariantes M/W, addConn com peso 0 não altera saída, spectralThermostat ≤ alvo.
4. Ops: cada op preserva invariantes; rede nunca fica sem input→output.
5. Evolução: com seed fixo e 5×5, `bestFitness` da última geração > `bestFitness` da 1ª e ≥ 1.2 (rede resolve).
6. Performance: ≥ 20 000 ticks de rede/segundo em Node (medir e reportar), ≥ 50 episódios/segundo 5×5.
Imprime tabela final e escreve `demo/tests/last-validation.json` com métricas.

---

# EMENDA v2 (2026-09-26) — alterações pedidas pelo utilizador

## E1. Capacidade de neurónios que cresce sozinha (core/network.mjs + core/ops.mjs) [G]

- `export const MAX_SLOTS = 256` (teto; orçamento da viz). `export function ensureCapacity(net, need = 1) => boolean`:
  se `(nSlots − vivos) < need` e `nSlots < MAX_SLOTS`, duplica `nSlots` (mínimo `nSlots + 16`),
  realoca `W`, `M`, `h`, `b` e ajusta `W_in`/`M_in`/`W_out`/`M_out` ao novo stride **preservando
  exatamente a função** (cada `W[i*nSlots+j]` migra para `W'[i*nSlots'+j]`). Devolve false só se
  `nSlots === MAX_SLOTS` e não houver espaço.
- `applyOp(net, 'addNeuron', ...)`: quando não há slot morto, chama `ensureCapacity(net, 1)` antes de
  falhar. Resultado: a rede **cresce sozinha ao chegar ao limite** (32 → 64 → 128 → 256).
- `makeNetwork`: `nInputs` por defeito passa a **12** (ver E2); `nSlots` inicial por defeito 32.

## E2. Memória de onde já esteve (core/sensors.mjs) [G]

- `sense(maze, x, y, visited = null) => Float32Array(12)`:
  - `[0..3]` distâncias às paredes (inalterado);
  - `[4..7]` sinais de saída (inalterado);
  - `[8..11]` **fração de células visitadas ao longo do raio** de cada direção:
    `(nº de células abertas do raio já visitadas) / (nº de células abertas do raio)`; `0` se `dist === 0`
    ou se `visited` for `null`.
- `visited`: `Uint8Array(cols*rows)` (1 = já esteve), da responsabilidade de quem corre o episódio:
  marca o start e cada célula ocupada. `SENSOR_NAMES` passa a 12 entradas
  (`'visitado↑'` etc. nos índices 8..11).
- `runEpisode` (core/evolution.mjs) mantém o `visited` interno e passa-o a `sense`; o playback em
  `main.js` faz o mesmo por episódio (reinicia a cada episódio).

## E3. Rotação automática com toggle (viz) [H]

- Ambas as views ganham `setAutoRotate(enabled: boolean)` no objeto devolvido.
- **Por defeito DESLIGADA** (sem rotação infinita). `prefers-reduced-motion` continua a forçar off.

## E4. Treino só pára ao resolver (worker + evolution + UI) [I]

- Critério de resolvido: o melhor net resolve (solved) TODOS os labirintos de treino numa avaliação.
- `generation.stats` ganha `solvedCount` e `mazeCount`; `done.summary` ganha `solved: boolean`.
- `run` com `generations: 0` (ou ausente) = correr **até resolver** (ou pausa/reset do utilizador).
  `generations: n > 0` = teto de segurança opcional. Campo na UI: "limite de gerações (0 = até resolver)",
  defeito **0**.
- UI: contadores ganham `#stat-solved` ("resolvidos", ex. `2/3`); chip ganha estado "Resolvido"
  (verde semântico) quando `done.solved`; store ganha chaves `solved`, `solvedCount`, `mazeCount`, `autoRotate`.

## E5. Novos ids DOM [I]

- `#ctrl-auto-rotate` (checkbox "rotação automática", desligado por defeito) no painel de controlo.
- Sensores: `#sensor-fill-8..11` + `#sensor-val-8..11`, rótulos `visitado cima/baixo/esq./dir.`.
- `#stat-solved` na lista de contadores.
- Input de gerações: rótulo "limite de gerações", valor por defeito 0, `min=0`.

---

# EMENDA v3 (2026-09-26) — aprendizagem real (probe-informada)

## E6. addNeuron nasce FUNCIONAL (core/ops.mjs) [integração]

Problema medido (probe): com saídas exatamente a 0 e sem treino por gradientes, os neurónios novos
ficavam inertes até `perturbWeights` os ativar; o campeão permanecia com 1 neurónio, cuja classe de
políticas (todas as saídas monotónicas num único escalar h) não resolve labirintos 7×7. Resultado:
0/1 vitórias em 2000 épocas mesmo treinando no próprio labirinto.

- `addNeuron`: pesos de SAÍDA passam a `U(-0.3, 0.3)` (tanto `W_out` como `W` recorrente), em vez de 0.
  A função deixa de ser EXATAMENTE preservada por addNeuron (mudança limitada e pequena na saída).
- `addConn` e `rewire` MANTÊM peso 0 (preservação exata de função permanece válida para eles).
- Consequência nos testes: a preservação exata passa a ser assertada só para addConn/rewire;
  addNeuron ganha assert de invariantes + mudança limitada.

---

# EMENDA v4 (2026-09-26) — mapa do labirinto como entradas + viz com valores

## E7. Cada casa é uma entrada (core/sensors.mjs + core/evolution.mjs) [K]

O agente tem de perceber que está em loop. Para além dos 12 sinais atuais, a rede passa a receber
o MAPA de visitas completo: uma entrada por célula do labirinto.

- `sense(maze, x, y, visited) => Float32Array(12 + cols*rows)`:
  - `[0..11]` inalterados (4 paredes, 4 saída visível, 4 fração de visitadas por direção);
  - `[12 + idx]` estado da célula `idx = y*cols + x`:
    `0` = nunca visitada · `0.5` = já visitada · `1.0` = posição ATUAL do agente.
    A posição atual com valor próprio liga o mapa ao "onde estou" (sem isso o mapa é igual em
    qualquer posição e a rede não consegue agir sobre ele nem detectar loops).
  - `visited` continua Uint8Array(cols*rows); a célula atual conta como visitada.
- `nIn` da rede = `12 + cols*rows` e é DETETADO a partir do labirinto (evolve/worker/main não
  podem ter 12 fixo). `evolve` usa `12 + mazes[0].cols*mazes[0].rows`; worker já deteta por
  `sense().length`; `main.js` cria a rede provisória com o nIn do labirinto corrente.
- Custo: `W_in` denso cresce com `nIn × nSlots` (aceitável para os tamanhos padrão; 31×31 com
  população grande fica pesado — documentado, não bloqueante).

## E8. Visualização 3D da rede (core → viz) [L]

- **Distância mínima entre neurónios**: o layout garante um espaçamento mínimo entre quaisquer
  dois nós visíveis (relaxação sobre a casca/arcos; a grelha do mapa tem passo fixo). Nada se
  sobrepõe, mesmo com 256 slots.
- **Valor escrito em cada nó**: rótulo numérico (textura canvas) sobre cada neurónio com o seu
  valor atual (entradas: valor do sinal; ocultos: h; saídas: y). Cor atrelada ao sinal/magnitude:
  positivo → âmbar #F5B04A, negativo → ardósia #5C6B7A, intensidade pela magnitude; texto legível
  (contraste), `prefers-reduced-motion` não afeta (é estado).
- **Mapa de entradas acende**: as entradas de células são desenhadas como UMA GRELHA (mini-mapa do
  labirinto, passo fixo) onde cada célula acende consoante o valor: 0 = apagada, 0.5 = âmbar ténue,
  1.0 (posição atual) = âmbar forte. Acende em tempo real quando o agente entra em casas novas.
- Orçamento de desempenho mantido (≥55 fps com o mapa de 31×31 incluído; rótulos em atlas de
  textura, não em objetos DOM).

## E9. UI (texto) [integração]

- Painel "o que a rede vê": manter as 12 linhas (índices 0..11) e acrescentar nota
  `+ mapa do labirinto: N células que acendem quando visitadas`.

## E10. Afinamento para entradas de alta dimensão (network.mjs + ops.mjs) [integração]

Medido: com o mapa (E7) a aprendizagem degradava (seed 123: 0 vitórias em 6000 épocas) porque
(1) a inicialização U(-0.5,0.5) sobre 61 entradas satura a tanh (drive ~ N(0,2.3)) e
(2) o pool de perturbações diluía-se num W_in 5× maior.

- Inicialização de `W_in` (makeNetwork e addNeuron): `U(-s, s)` com `s = min(0.5, 1/sqrt(nIn))`.
- `perturbWeights`: 2 a 6 pesos por aplicação (era 1-4) com ruído N(0, 0.35) (era 0.25).

---

# EMENDA v5 (2026-09-26) — MEMÓRIA ESTRUTURAL + TREINOS GUARDADOS

Base literária (pesquisa de hoje):
- Butz & van Ooyen 2009 (PubMed 19162072) e Fauth et al. 2016 (Front. Neuroanat.): a memória forma-se
  por CRIAÇÃO/RETRAÇÃO de sinapses e neurónios (plasticidade estrutural), não só por pesos.
- Deng 2010 (PMC2886712, "New neurons and new memories") + modelos computacionais de Aimone:
  integrar NOVOS neurónios aumenta a capacidade de memória e reduz interferência ("novos neurónios
  para memórias novas").
- Ba, Hinton, Mnih, Leibo, Ionescu 2016 (arXiv:1610.06258, "Fast Weights to Attend to the Recent Past"):
  sinapses com dinâmica em várias escalas de tempo; "fast weights" guardam memória temporária do
  passado recente SEM copiar atividade para as entradas. É exatamente a alternativa pedida a
  "passar mais informação".
- Fahlman & Lebiere 1990 (Cascade-Correlation): recrutar neurónios novos quando o erro estagna,
  congelando os existentes (criação de neurónio como mecanismo de capacidade/memória).
- Acervo do projeto (README §2.4): addNeuron/addConn com init preservadora e adaptive pursuit.

## E11. Sinapses rápidas Hebbianas (core/network.mjs) [P]

- `Net` ganha `F: Float64Array(nSlots*nSlots)` (pesos rápidos), `fastLambda` (decay, defeito 0.92),
  `fastEta` (aprendizagem, defeito 0.35).
- Por tick, DEPOIS de calcular `h`: `F_ij ← clip(λ·F_ij + η·h_i·h_j, ±2)` só onde `M[i][j]===1`.
- O tick usa peso efetivo `W + F` (onde M=1). `resetNet` ZERA F (a memória é do episódio corrente).
  `cloneNet` copia F. `ensureCapacity` migra F como migra W.
- `spectralRadius/spectralThermostat` continuam sobre W (F é dinâmica rápida, documentado).

## E12. Neurónio de memória + neurogénese por estagnação (core/ops.mjs, evolution.mjs) [P]

- Nova operação `addMemoryNeuron` (OP_NAMES → 9): cria um neurónio com AUTOCONEXÃO forte
  (`W_jj ≈ 0.85`, `M_jj=1`) e `alpha` baixo (≈0.05) → atividade persistente (célula de memória de
  trabalho), ligada a 1 input e 1 output como addNeuron (saídas pequenas U(-0.3,0.3), E6).
- `makeOperatorBank` ganha `setBias(porOp: Record<string, number>)` (multiplicador de probabilidade,
  renormalizado, P_min mantido) — usado para o burst de neurogénese.
- `evolve`: quando o melhor global não melhora durante `K=25` gerações, ativa burst de neurogénese
  (`setBias({addNeuron: 2.5, addMemoryNeuron: 3})` por 50 gerações, repetível) — "novos neurónios
  para memórias novas"; regista `neurogenesisBursts` no resultado.

## E13. Modo de memória configurável (core/sensors.mjs + evolution.mjs + worker) [P]

- `memoryMode: 'sinapses' | 'mapa' | 'ambos'` (defeito **'sinapses'** — a memória vive na rede).
- `sense(maze, x, y, visited, opts)` com `opts.withMap` (default false): `false` → Float32Array(12);
  `true` → 12 + cols*rows (mapa, E7). 'ambos' = withMap + sinapses rápidas ligadas; 'sinapses' = 12
  entradas + sinapses rápidas; 'mapa' = mapa + sinapses rápidas DESLIGADAS (comparabilidade).
- CONSEQUÊNCIA-chave: com 12 entradas fixas, uma rede treinada num labirinto joga em QUALQUER
  labirinto, de qualquer tamanho (reprodução cruzada).

## E14. Treinos guardados + reprodução cruzada + reprodução dupla (web) [Q, R, integração]

- `demo/web/src/training-store.js` [Q]: persistência em localStorage (`ann.trainings.v1`):
  `save({name, net, meta})` (net serializado: typed arrays → arrays), `list()`, `load(id)`,
  `remove(id)`, `exportJSON()`, `importJSON(str)`. meta: `{mazeSize, seed, epochs, fitness,
  memoryMode, nIn, createdAt}`. API devolve promessas síncronas simples (tudo síncrono, localStorage).
- UI [Q]: painel "treinos guardados" (guardar treino atual, lista com nome/data/melhor resultado,
  botões "jogar" / "comparar" / apagar); seletor "memória da rede: sinapses | mapa | ambos";
  seleção dupla para "comparar dois treinos".
- Playback [integração]: escolher fonte (campeão atual ou treino guardado) e jogar no labirinto
  corrente; compatibilidade exigida só de `nIn` (redes de 12 entradas valem para todos os tamanhos;
  redes com mapa exigem mesmo nº de células — a UI explica quando incompatível).
- **Reprodução dupla** [R + integração]: `maze3d` ganha `updateAgents([{x,y,path,sensors,visited,
  color}])` (2 agentes: A âmbar #F5B04A, B azul-pálido #8FB8DA); a vista labirinto mostra os dois a
  jogar o MESMO labirinto ao mesmo tempo, cada um com o seu treino. Etiquetas de estado por agente.
