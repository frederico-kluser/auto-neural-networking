# Demo — rede que evolui em labirintos

Demo executável do projeto **auto-neural-networking**: uma rede neuronal sem camadas
(leaky-tanh, dinâmica de sistema dinâmico do README §2.1–2.2) evolui sozinha por operações
mutacionais com banco adaptativo (`addNeuron`, `addConn`, `removeConn`, `rewire`, `pruneNeuron`,
`changeLeak`, `splitNeuron`) e aprende a resolver labirintos gerados em vários tamanhos.

O agente vê **apenas 12 números**: a distância à parede em cada uma das 4 direções
(cima/baixo/esquerda/direita), um sinal de valor fixo na direção em que a saída está visível
em linha reta, e a fração do percurso já percorrido em cada direção (memória de onde já esteve).
Sem coordenadas, sem mapa, sem bússola.

## Estrutura

```
demo/
  core/        motor headless (Node + browser, zero dependências)
    rng.mjs        RNG determinístico (mulberry32)
    maze.mjs       gerador de labirintos perfeitos (DFS iterativo), BFS solver, rayInfo
    sensors.mjs    vetor de sensores de 8 dimensões
    network.mjs    grafo de neurónios sem camadas (leaky-tanh), raio espectral + termostato;
                   capacidade que cresce sozinha (ensureCapacity, 32 → 64 → 128 → 256 slots)
    ops.mjs        banco de operações mutacionais + adaptive pursuit (Thierens 2005)
    evolution.mjs  episódios, fitness, loop evolutivo com elitismo
  tests/
    unit-core.mjs      testes unitários de rng/maze/sensors
    unit-net.mjs       testes unitários de network/ops/evolution
    validate.mjs       harness completo de validação (contrato de saída verde)
    last-validation.json  métricas da última validação
  web/         interface (ESM puro, sem build step)
    index.html   shell + import map (three vendored, sem CDN)
    styles.css   design system dark-tech
    src/state.js             store pub/sub
    src/main.js              integração + playback ao vivo
    src/viz/neural3d.js      visualização 3D de neurónios/conexões (Three.js, instanced)
    src/viz/maze3d.js        visualização 3D do labirinto (Three.js, instanced)
    src/ui/controls.js       painel de controlo
    src/ui/stats.js          estatísticas + sparkline
    src/worker/trainer.worker.js  treino em Web Worker (UI nunca bloqueia)
  CONTRACTS.md contrato de interfaces entre módulos
```

## Validar (headless, em JS)

```bash
node demo/tests/unit-core.mjs     # labirintos + sensores
node demo/tests/unit-net.mjs      # rede + operações + evolução
node demo/tests/validate.mjs      # harness completo: checks + performance + relatório JSON
```

`validate.mjs` só termina com exit 0 se todos os checks passarem: propriedades dos labirintos,
semântica dos sensores, invariantes da rede, preservação de função das mutações, aprendizagem
comprovada (fitness final > inicial e ≥ 1.2 em 5×5) e desempenho (≥ 20 000 ticks de rede/s,
≥ 50 episódios/s em 5×5).

## Correr a demo

```bash
cd demo && python3 -m http.server 8080
# abrir http://localhost:8080/web/
```

Qualquer servidor estático serve (a app usa ES modules + Web Worker, precisa de http://).
A UI permite: escolher o tamanho do labirinto (5×5 … 31×31), seed, população, gerações,
velocidade do treino (1×/4×/16×/máx) e ver em tempo real:

- **labirinto 3D** — agente, raios dos sensores, trilha, saída;
- **rede 3D** — neurónios e conexões com os sinais a circular (pulsos proporcionais à ativação);
- **estatísticas** — evolução por época, topologia (neurónios/conexões que crescem sozinhos
  quando precisos), mutações em ensaio, leitura dos 12 sinais da rede e das 4 saídas.

O treino corre **até vencer o desafio** (o campeão resolve todos os labirintos de treino), com
limite de épocas opcional (0 = até vencer). Quando vence, a interface mostra **RESOLVIDO** e o
campeão reproduz a solução até à saída. A rotação automática da câmara é opcional (desligada por
defeito; ligável no painel).

## Design

Instrumento científico dark-tech: fundo #0B0B0D, texto #E8E8EA, acento âmbar único #F5B04A,
verde semântico #3FB984 reservado a "saída/resolvido", números em mono, raios 4px, bordas 1px.
Tema escuro único, `prefers-reduced-motion` respeitado.
