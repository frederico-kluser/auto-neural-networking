/**
 * web/src/worker/trainer.worker.js [F] · worker de treino (neuroevolução).
 * Contrato: demo/CONTRACTS.md § "Worker [F]" + EMENDA v2 § E4 + EMENDA v6 §§ E16-E18.
 *
 * Entradas: { type:'init', config }  { type:'run', generations }  { type:'pause' }
 *           { type:'resume' }  { type:'reset', config? }  { type:'setSpeed', gensPerBatch }
 *           { type:'setTimeLimit', timeLimitMs } (extra: limite de tempo ao vivo)
 * Saídas:   { type:'generation', stats }  { type:'best', net }  { type:'done', summary }
 *
 * E4 · paragem: por omissão a corrida SÓ pára quando o desafio está resolvido (ou o
 * utilizador pausa/reinicia). `run` com `generations: 0` (ou ausente) = correr até
 * resolver; `generations: n > 0` = teto de segurança opcional (pára na geração n
 * mesmo sem resolver).
 *
 * E17 · curriculum: o treino começa em labirintos de `config.curriculum.startSize`
 * (defeito 5×5) e SOBE de tamanho (5→7→…→`config.mazeSize`, o tamanho ALVO) quando o
 * melhor da geração resolve TODOS os labirintos do nível atual. A população e o banco
 * de mutações seguem para o nível seguinte (transferência) e cada subida dispara um
 * burst de neurogénese (E12: `bank.setBias({ addNeuron: 2.5, addMemoryNeuron: 3 })`
 * por 50 gerações). Critério de vitória: resolver todos os labirintos DO NÍVEL ALVO;
 * só aí `done.summary.solved` é true. `done.summary.finalLevel` = tamanho do nível
 * final. Cada `generation` ganha `level` (tamanho atual), `levelProgress`
 * ({ solved, total } do nível) e `targetSize` (alvo), no topo da mensagem e em stats.
 * Os labirintos do nível atual são recriados a cada subida (3 por nível por omissão).
 * Quando `config.mazes` é uma LISTA explícita de tamanhos, o curriculum fica
 * desligado (modo legado: treino e vitória nesses labirintos, E4 puro).
 *
 * E16 · horizonte de memória: `memoryHorizon = min(800, max(60, 2*openCells))` do
 * labirinto do nível atual, passado a `makeNetwork` (quando o core o honra) e
 * aplicado como `net.fastLambda = exp(-1/H)` em toda a população (recalculado na
 * subida de nível).
 *
 * E18 · seleção rápida: quando `evaluate` do core aceita `opts.mazePerGen` (detetado
 * em runtime pelo nome da opção), cada indivíduo é avaliado em 1 labirinto rotativo
 * por geração (`evaluate(net, mazes, { mazePerGen: true, rng })`). A VERIFICAÇÃO do
 * campeão mantém-se exata: sempre sobre TODOS os labirintos do nível
 * (`solvedCount` de core/evolution.mjs quando existe, senão runEpisode por labirinto).
 *
 * REORIENTAÇÃO (utilizador):
 *   - memória: o modo está FIXO em 'sinapses' (12 entradas; o agente não vê o
 *     mapa). O seletor saiu da UI; `config.memoryMode` é aceite por compatibilidade
 *     mas ignorado (nunca 'mapa'/'ambos').
 *   - limite de tempo: `config.timeLimitMs` (ms; 0 = sem limite; defeito 30 min).
 *     O tempo conta só enquanto o treino corre (pausas não contam) e, quando se
 *     esgota, a corrida pára com `done.summary.reason = 'time'`. `done.summary`
 *     ganha `reason` ('solved' | 'time' | 'limit' | 'error'), `elapsedMs` e
 *     `timeLimitMs`; cada `generation` ecoa `elapsedMs` (topo + stats) para a UI
 *     mostrar "a treinar há 12 min". Mensagem extra (fora do contrato base):
 *     `{ type:'setTimeLimit', timeLimitMs }` ajusta o limite em tempo real sem
 *     reiniciar o desafio.
 *
 * O ciclo de gerações é conduzido aqui com as primitivas de core/* (evaluate,
 * applyOp, makeOperatorBank, cloneNet) porque evolve() não devolve a população
 * entre lotes (o `population` das stats é só introspeção); a semântica segue o
 * contrato: elitismo, mutationRate, rng determinístico por seed e banco
 * adaptativo (pursuit). As helpers do core são PREFERIDAS quando expostas
 * (sondagem em runtime, fallback local sempre disponível):
 * `curriculumMazes(size, seeds)` (labirintos por nível), `memoryHorizonFor(maze)`
 * (E16) e `evaluate(..., { mazePerGen, rng })` (E18). As stats de cada geração
 * adoptam a forma do core: `level` (tamanho), `levelProgress` ({ solved, total })
 * e `promoted` ({ from, to, gen } | null); `targetSize`/`levelIndex`/`levelCount`
 * são extras para a UI (aqui levelCount = TOTAL de níveis do curriculum).
 * O `config.curriculum` segue também nas opções das chamadas ao core
 * (evaluate/solvedCount/runEpisode) para o core poder tratá-lo se o fizer.
 * O `net` de 'best' é o objeto Net clonado (structured clone do postMessage),
 * nunca serializado à mão. A aridade de entrada da rede é detetada a partir do
 * tamanho real do vetor de sensores do core; em modos com mapa ('mapa'/'ambos')
 * a aridade cresce com o nível e as entradas são reamarradas na subida
 * (remapInputs: as 12 primeiras passam tal e quais).
 * Sem DOM; imports apenas de core/*.
 */

import * as evolution from '../../../core/evolution.mjs';
import * as sensors from '../../../core/sensors.mjs';
import { makeRng } from '../../../core/rng.mjs';
import { generateMaze } from '../../../core/maze.mjs';
import { applyOp, makeOperatorBank } from '../../../core/ops.mjs';
import { makeNetwork, cloneNet, countNeurons, countConns } from '../../../core/network.mjs';

const { evaluate, runEpisode } = evolution;
const N_IN_FALLBACK = 8; // só se o core não expuser sensores
const N_OUT = 4;
const N_SLOTS = 8; // slots iniciais; crescem por mutação (máx. 256 em core/network.mjs)
const MAZE_COUNT = 3; // labirintos de avaliação por nível (E17: "os 3 do nível atual")
const GEN_MAX = 1000000; // teto absoluto de gerações por pedido de `run`
const LEVEL_SEED_STRIDE = 1000; // seeds por nível: seed + nível*1000 + k (determinístico)

// E17/E12: burst de neurogénese em cada subida de nível.
const NEUROGENESIS_BIAS = { addNeuron: 2.5, addMemoryNeuron: 3 };
const NEUROGENESIS_BURST_GENS = 50;

const DEFAULTS = {
  population: 60,
  generations: 0, // E4: 0 = até resolver (teto de segurança só se pedido)
  seed: 1,
  elite: 6,
  mutationRate: 0.9,
  mazeSize: 11,
  memoryMode: 'sinapses', // REORIENTAÇÃO: fixo; 'sinapses' = 12 entradas, sem mapa
  timeLimitMs: 30 * 60 * 1000, // limite de tempo de treino (0 = sem limite)
};

/** Inteiro com clamping; não finito => fallback. */
function clampInt(raw, min, max, fallback) {
  const n = Math.trunc(Number(raw));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/** Lado do labirinto: ímpar em [5, 31] (generateMaze também defende). */
function oddSize(raw, fallback) {
  const n = clampInt(raw, 5, 31, fallback);
  return n % 2 ? n : Math.min(31, n + 1);
}

/** Config do worker: merge de `raw` sobre `base`, sempre sanitizada. */
function sanitizeConfig(raw, base) {
  const c = { ...(base || {}), ...(raw && typeof raw === 'object' ? raw : {}) };
  const population = clampInt(c.population, 2, 10000, DEFAULTS.population);
  const mr = Number(c.mutationRate);
  // E17: o tamanho escolhido (mazeSize) é o ALVO do curriculum; startSize vem de
  // config.curriculum.startSize (defeito 5) e nunca ultrapassa o alvo.
  const targetSize = oddSize(c.mazeSize, DEFAULTS.mazeSize);
  const rawCur = c.curriculum && typeof c.curriculum === 'object' ? c.curriculum : {};
  let startSize = oddSize(rawCur.startSize ?? 5, 5);
  if (startSize > targetSize) startSize = targetSize;
  // lista explícita de labirintos => modo legado sem subidas de nível (E4 puro)
  const legacy = Array.isArray(c.mazes) && c.mazes.length > 0;
  return {
    population,
    // E4: 0 válido = "até resolver"; n > 0 = teto de segurança
    generations: clampInt(c.generations, 0, GEN_MAX, DEFAULTS.generations),
    seed: clampInt(c.seed, 0, 2147483647, DEFAULTS.seed),
    elite: clampInt(c.elite, 1, Math.max(1, population - 1), Math.min(DEFAULTS.elite, population - 1)),
    mutationRate: Number.isFinite(mr) ? Math.min(1, Math.max(0, mr)) : DEFAULTS.mutationRate,
    mazeSize: targetSize,
    // REORIENTAÇÃO: memória fixa em 'sinapses' (12 entradas; o agente não vê o
    // mapa). `config.memoryMode` é aceite mas ignorado.
    memoryMode: 'sinapses',
    // limite de tempo de treino em ms (0 = sem limite; defeito 30 min)
    timeLimitMs: clampInt(c.timeLimitMs, 0, 24 * 60 * 60 * 1000, DEFAULTS.timeLimitMs),
    mazes: c.mazes,
    // E17: objeto canónico passado adiante nas chamadas ao core
    curriculum: { targetSize, startSize, enabled: !legacy },
  };
}

/**
 * Tamanhos dos níveis do curriculum: startSize, startSize+2, ..., targetSize.
 * PREFERE helpers do core quando estão expostas (o core é de outro agente; a
 * forma é validada em runtime e qualquer surpresa cai para a lista local).
 */
function levelSizesOf(cur) {
  for (const name of ['curriculumSizes', 'makeCurriculum', 'buildCurriculum']) {
    const fn = evolution[name];
    if (typeof fn !== 'function') continue;
    try {
      const r = fn({ targetSize: cur.targetSize, startSize: cur.startSize });
      const sizes = Array.isArray(r) ? r : r && Array.isArray(r.sizes) ? r.sizes : null;
      if (sizes && sizes.length && sizes.every((n) => Number.isFinite(Number(n)))) {
        return sizes.map((n) => oddSize(n, cur.targetSize));
      }
    } catch {
      // helper inesperada: segue para a implementação local
    }
  }
  const out = [];
  for (let s = cur.startSize; s <= cur.targetSize; s += 2) out.push(s);
  return out.length ? out : [cur.targetSize];
}

/**
 * Labirintos do nível `li` (E17: 3 por nível por omissão). PREFERE
 * `curriculumMazes(size, seeds)` de core/evolution.mjs ("reutilizável pelo
 * worker"); as seeds derivam do "labirinto nº" (config.seed) para cada número
 * gerar labirintos diferentes. Sem a helper: generateMaze local (mesma ideia).
 */
function buildLevelMazes(li) {
  const out = [];
  const gen = (size, seedList) => {
    const helper = evolution.curriculumMazes;
    if (typeof helper === 'function') {
      try {
        const r = helper(size, seedList);
        if (Array.isArray(r) && r.length === seedList.length) {
          out.push(...r);
          return;
        }
      } catch {
        // helper inesperada: segue para o generateMaze local
      }
    }
    for (const s of seedList) out.push(generateMaze(size, size, s));
  };
  const seedsFor = (n, k0 = 0) => Array.from({ length: n }, (_, k) => cfg.seed + li * LEVEL_SEED_STRIDE + k0 + k);
  if (cfg.curriculum.enabled) {
    const n = clampInt(cfg.mazes, 1, 16, MAZE_COUNT);
    gen(levelSizes[Math.min(li, levelSizes.length - 1)], seedsFor(n));
  } else {
    // legado: lista explícita de tamanhos (um labirinto por entrada)
    (Array.isArray(cfg.mazes) ? cfg.mazes : []).forEach((sz, k) => gen(oddSize(sz, cfg.mazeSize), seedsFor(1, k)));
  }
  return out;
}

/** Células abertas de um labirinto (E16: horizonte de memória). */
function openCellsOf(maze) {
  let c = 0;
  for (let y = 0; y < maze.rows; y++) {
    for (let x = 0; x < maze.cols; x++) if (!maze.isWall(x, y)) c++;
  }
  return c;
}

/**
 * E16: H = min(800, max(60, 2*openCells)) do labirinto do nível atual.
 * PREFERE `memoryHorizonFor(maze)` de core/evolution.mjs; fallback local.
 */
function horizonOf(maze) {
  const helper = evolution.memoryHorizonFor;
  if (typeof helper === 'function') {
    try {
      const h = Number(helper(maze));
      if (Number.isFinite(h) && h > 0) return h;
    } catch {
      // helper inesperada: fórmula local
    }
  }
  return Math.min(800, Math.max(60, 2 * openCellsOf(maze)));
}

/**
 * Aridade de entrada da rede = tamanho real do vetor de sensores do core.
 * A EMENDA v2 § E2 faz `sense` passar de 8 para 12 valores; deteta-se em runtime
 * para o worker acompanhar o core quer ele já tenha migrado quer ainda não.
 */
function detectInputCount(mazeList, withMap = false) {
  try {
    const mz = mazeList && mazeList[0];
    if (mz && typeof sensors.sense === 'function') {
      const s = sensors.sense(mz, mz.start.x, mz.start.y, null, { withMap });
      if (s && Number.isFinite(s.length) && s.length > 0) return Math.trunc(s.length);
    }
  } catch {
    // sense indisponível: segue para SENSOR_NAMES
  }
  try {
    const names = sensors.SENSOR_NAMES;
    if (Array.isArray(names) && names.length > 0) return names.length;
  } catch {
    // sem módulo de sensores: fallback
  }
  return N_IN_FALLBACK;
}

// ---- critério de resolvido (EMENDA v2 § E4; com E17 = nível atual) ----

/** Contagem inteira clipada a [0, total]. */
function clipCount(n, total) {
  const c = Math.trunc(Number(n));
  if (!Number.isFinite(c)) return 0;
  return Math.max(0, Math.min(total, c));
}

/** Quantos labirintos o `net` resolve (episode solved=true) — fallback por runEpisode. */
function countSolvedByEpisodes(net, mazeList) {
  let c = 0;
  for (const mz of mazeList) {
    try {
      const ep = runEpisode(net, mz, { memoryMode: cfg.memoryMode });
      if (ep && ep.solved) c++;
    } catch {
      // episódio falhou: conta como não resolvido
    }
  }
  return c;
}

/**
 * { solvedCount, total } do `net` sobre os labirintos do nível numa avaliação
 * (sempre TODOS: verificação exata do campeão, E18).
 * Prefere o helper `solvedCount(net, mazes, opts)` de core/evolution.mjs (E4,
 * acrescentado em paralelo), com verificação defensiva da forma: { solved, total }
 * onde `solved` é CONTAGEM (a forma confirmada por tests/validate.mjs); booleano
 * também é tolerado (true = todos; false = conta-se com runEpisode). Sem helper,
 * com forma inesperada ou em erro, cai para runEpisode por labirinto. Nunca lança.
 */
function evalSolved(net, mazeList) {
  const total = mazeList.length;
  const helper = evolution.solvedCount;
  if (typeof helper === 'function') {
    try {
      const r = helper(net, mazeList, { memoryMode: cfg.memoryMode, curriculum: cfg.curriculum });
      if (r && typeof r === 'object') {
        const t = Number.isFinite(Number(r.total)) ? Math.trunc(Number(r.total)) : total;
        if (Number.isFinite(Number(r.solvedCount))) {
          return { solvedCount: clipCount(r.solvedCount, t), total: t };
        }
        if (typeof r.solved === 'boolean') {
          return r.solved
            ? { solvedCount: t, total: t }
            : { solvedCount: countSolvedByEpisodes(net, mazeList), total: t };
        }
        if (Number.isFinite(Number(r.solved))) {
          return { solvedCount: clipCount(r.solved, t), total: t };
        }
      }
    } catch {
      // helper inesperado: segue para o fallback
    }
  }
  return { solvedCount: countSolvedByEpisodes(net, mazeList), total };
}

// ---- E18: seleção por geração (1 labirinto rotativo) quando o core a expõe ----

const CORE_MAZE_PER_GEN = (() => {
  try {
    return /mazePerGen/.test(String(evaluate));
  } catch {
    return false;
  }
})();

/** Opções de avaliação da população (seleção); o campeão é sempre reavaliado em todos. */
function selectionOpts() {
  const opts = { memoryMode: cfg.memoryMode, curriculum: cfg.curriculum };
  if (CORE_MAZE_PER_GEN) {
    opts.mazePerGen = true;
    opts.rng = rng;
  }
  return opts;
}

// ---- E16/E17: adaptação das redes ao nível (horizonte + entradas do mapa) ----

/**
 * Reamarra as entradas da rede quando o nº de entradas muda com o nível
 * (só em modos com mapa: nIn = 12 + células do labirinto, E13).
 * Tensão E17×E13 (documentada): o mapa de um nível 7×7 não tem o mesmo tamanho
 * que o de um nível 5×5; as 12 primeiras entradas (sinais) passam tal e quais,
 * as entradas novas nascem ligadas ao neurónio 0 com pesos pequenos (como em
 * makeNetwork) e as do mapa antigo que excedem o novo nIn são largadas.
 */
function remapInputs(net, newNIn) {
  const cap = net.nSlots;
  const oldNIn = net.nIn;
  if (!(newNIn > 0) || newNIn === oldNIn) return;
  const W_in = new Float64Array(newNIn * cap);
  const M_in = new Uint8Array(newNIn * cap);
  const keep = Math.min(oldNIn, newNIn);
  for (let k = 0; k < keep; k++) {
    for (let j = 0; j < cap; j++) {
      W_in[k * cap + j] = net.W_in[k * cap + j] || 0;
      M_in[k * cap + j] = net.M_in[k * cap + j] || 0;
    }
  }
  if (newNIn > oldNIn) {
    const inScale = Math.min(0.5, 1 / Math.sqrt(newNIn)); // E10: não saturar a tanh
    for (let k = oldNIn; k < newNIn; k++) {
      M_in[k * cap] = 1; // -> neurónio 0
      W_in[k * cap] = (rng.next() - 0.5) * 2 * inScale;
    }
  }
  net.W_in = W_in;
  net.M_in = M_in;
  net.nIn = newNIn;
}

/** Aplica o nível atual a uma rede: entradas + horizonte de memória (E16). */
function adaptNetToLevel(net, nIn) {
  if (net.nIn !== nIn) remapInputs(net, nIn);
  net.memoryHorizon = levelHorizon;
  net.fastLambda = Math.exp(-1 / levelHorizon); // λ = exp(−1/H)
}

/** Rede nova para o nível atual (nIn e horizonte do nível). */
function makeLevelNet() {
  const nIn = detectInputCount(mazes, cfg.memoryMode !== 'sinapses'); // E13: mapa só em 'mapa'/'ambos'
  const net = makeNetwork({
    nInputs: nIn,
    nOutputs: N_OUT,
    seed: drawSeed(),
    nSlots: N_SLOTS,
    fastOn: cfg.memoryMode !== 'mapa',
    memoryHorizon: levelHorizon, // E16: honrado pelo core quando o suporta
  });
  adaptNetToLevel(net, nIn); // garante λ = exp(−1/H) mesmo com core antigo
  return net;
}

// ---- estado persistente da corrida ----

let cfg = sanitizeConfig({}, DEFAULTS);
let rng = null;
let bank = null;
let mazes = [];
let levelSizes = [DEFAULTS.mazeSize]; // tamanhos dos níveis (E17)
let levelIndex = 0; // nível atual (índice em levelSizes; 0 = primeiro)
let levelHorizon = 60; // E16: horizonte de memória do nível atual (ticks)
let burstLeft = 0; // gerações de burst de neurogénese ainda ativas (E17/E12)
let pop = [];
let fits = [];
let creditOp = []; // operação que gerou cada indivíduo (para recompensa diferida)
let creditParent = [];
let gen = 0;
// orçamento de gerações do(s) pedido(s) `run`: número finito = teto de segurança;
// Infinity = até resolver (E4). Zerado quando a corrida termina.
let remaining = 0;
let running = false;
let paused = false;
let timer = null;
let gensPerBatch = 1;
let globalBest = -Infinity;
let lastBest = 0;
let lastMean = 0;
let elapsedMs = 0; // tempo de treino decorrido (ms; pausas NÃO contam)

function drawSeed() {
  return Math.floor(rng.next() * 0x7fffffff);
}

/** Tamanho do nível atual (mensagem `level`); legado = tamanho do desafio. */
function currentLevel() {
  return cfg.curriculum.enabled ? levelSizes[Math.min(levelIndex, levelSizes.length - 1)] : cfg.mazeSize;
}

/** true quando o nível atual é o ALVO (E17: vencer aí = desafio vencido). */
function isTargetLevel() {
  return !cfg.curriculum.enabled || levelIndex >= levelSizes.length - 1;
}

/** Tamanho alvo (mensagem `targetSize`). */
function currentTarget() {
  return cfg.curriculum.enabled ? cfg.curriculum.targetSize : cfg.mazeSize;
}

/**
 * Subida de nível (E17): novos labirintos do tamanho seguinte, POPULAÇÃO e banco
 * mantidos (transferência) e burst de neurogénese por NEUROGENESIS_BURST_GENS
 * gerações. As redes são adaptadas ao novo nível (nIn do mapa + horizonte E16).
 */
function promoteLevel() {
  levelIndex++;
  mazes = buildLevelMazes(levelIndex);
  levelHorizon = horizonOf(mazes[0]);
  const nIn = detectInputCount(mazes, cfg.memoryMode !== 'sinapses');
  for (const net of pop) adaptNetToLevel(net, nIn);
  bank.setBias(NEUROGENESIS_BIAS); // "novos neurónios para memórias novas" (E12)
  burstLeft = NEUROGENESIS_BURST_GENS;
  globalBest = -Infinity; // a escala de resultado muda com os labirintos do nível
}

/** (Re)constrói rng, banco, labirintos e população; zera contadores. */
function init(rawConfig) {
  stopLoop();
  cfg = sanitizeConfig(rawConfig, cfg);
  rng = makeRng(cfg.seed);
  bank = makeOperatorBank(rng);
  levelSizes = levelSizesOf(cfg.curriculum);
  levelIndex = 0;
  burstLeft = 0;
  mazes = buildLevelMazes(0);
  levelHorizon = horizonOf(mazes[0]);
  pop = [];
  for (let i = 0; i < cfg.population; i++) pop.push(makeLevelNet());
  fits = new Array(pop.length).fill(0);
  creditOp = new Array(pop.length).fill(null);
  creditParent = new Array(pop.length).fill(0);
  gen = 0;
  remaining = 0;
  running = false;
  paused = false;
  globalBest = -Infinity;
  lastBest = 0;
  lastMean = 0;
  elapsedMs = 0;
}

/**
 * Uma geração completa: avaliar, dar crédito ao banco, reportar, reproduzir.
 * Devolve { solved, promoted } (E4/E17): solved = true quando o melhor atual
 * resolve TODOS os labirintos DO NÍVEL ALVO numa avaliação (único motivo de
 * paragem por omissão); promoted = true quando o nível subiu nesta geração.
 */
// ── máquina de fatias da geração (PAUSA IMEDIATA) ─────────────────────────────
// A avaliação de uma geração inteira era síncrona: a mensagem 'pause' nem chegava a
// ser recebida até o lote acabar (nível 31×31 = minutos). Agora a geração é avaliada
// em fatias de IND_PER_CHUNK indivíduos com yield entre fatias: pausar trava em ms e
// o RESUME continua a MESMA geração (determinismo intacto, sem repetir trabalho).
let evalCursor = -1; // -1 = sem geração em curso
let gBest = -Infinity;
let gBestIdx = 0;
let gSum = 0;
let gEvalOpts = null;
let genT0 = 0;
const IND_PER_CHUNK = 4;

function beginGeneration() {
  genT0 = Date.now(); // limite de tempo: conta só o treino que corre
  gEvalOpts = selectionOpts(); // E18: 1 labirinto rotativo por indivíduo quando existe
  gBest = -Infinity;
  gBestIdx = 0;
  gSum = 0;
  evalCursor = 0;
}

/** Avalia até IND_PER_CHUNK indivíduos; devolve 'more' | 'ready'. */
function evalSlice() {
  const end = Math.min(pop.length, evalCursor + IND_PER_CHUNK);
  for (; evalCursor < end; evalCursor++) {
    const f = evaluate(pop[evalCursor], mazes, gEvalOpts);
    fits[evalCursor] = f;
    gSum += f;
    if (f > gBest) {
      gBest = f;
      gBestIdx = evalCursor;
    }
  }
  return evalCursor >= pop.length ? 'ready' : 'more';
}

function runOneGeneration() {
  const t0 = genT0;
  const evalOpts = gEvalOpts;
  const best = gBest;
  const bestIdx = gBestIdx;
  const mean = gSum / pop.length;
  evalCursor = -1;

  // crédito diferido: recompensa da op = ganho do filho sobre o pai (>= 0);
  // cada operação do filho recebe o mesmo crédito (contrato: 1–3 ops por descendente)
  for (let i = 0; i < pop.length; i++) {
    const ops = creditOp[i];
    if (ops && ops.length) {
      const gain = fits[i] - creditParent[i];
      const reward = gain > 0 ? gain : 0;
      for (const op of ops) bank.update(op, reward);
      creditOp[i] = null;
    }
  }

  // E17/E12: contagem decrescente do burst de neurogénese da última subida
  if (burstLeft > 0) {
    burstLeft--;
    if (burstLeft === 0) bank.setBias({});
  }

  // E4/E17: quantos labirintos do nível resolve o melhor atual?
  // (critério de paragem/promoção + UI; verificação sempre em TODOS, E18)
  const { solvedCount, total: mazeCount } = evalSolved(pop[bestIdx], mazes);
  const allSolved = mazeCount > 0 && solvedCount >= mazeCount;
  const atTarget = isTargetLevel();
  const solved = allSolved && atTarget; // vitória SÓ no nível alvo (E17)
  const willPromote = allSolved && cfg.curriculum.enabled && !atTarget;
  const level = currentLevel();
  const targetSize = currentTarget();
  const levelProgress = { solved: solvedCount, total: mazeCount };
  elapsedMs += Date.now() - t0; // tempo de treino até ao relatório (o resto conta-se no fim)

  gen++;
  lastBest = best;
  lastMean = mean;
  // forma das stats do core (evolve): promoted = { from, to, gen } | null
  const promoted = willPromote
    ? { from: level, to: levelSizes[Math.min(levelIndex + 1, levelSizes.length - 1)], gen }
    : null;
  const improved = best > globalBest;
  if (improved) {
    globalBest = best;
    self.postMessage({ type: 'best', net: cloneNet(pop[bestIdx]), epoch });
  } else if (solved) {
    // vitória no nível alvo: o campeão reproduzido pela UI é a rede que resolveu
    self.postMessage({ type: 'best', net: cloneNet(pop[bestIdx]), epoch });
  }
  self.postMessage({
    type: 'generation',
    epoch,
    solvedCount, // eco no topo da mensagem (E4); o canónico é stats.solvedCount
    mazeCount,
    level, // E17: tamanho do nível atual
    levelProgress, // E17: { solved, total } do nível
    targetSize, // E17: tamanho alvo (config.mazeSize)
    elapsedMs, // tempo de treino decorrido (ms; UI: "a treinar há 12 min")
    stats: {
      gen,
      best,
      mean,
      nNeurons: countNeurons(pop[bestIdx]),
      nConns: countConns(pop[bestIdx]),
      bankProbs: bank.probs(),
      bankStats: bank.stats(), // extra sobre o contrato: { op: { p, q, count } } para a UI
      solvedCount,
      mazeCount,
      level,
      levelProgress,
      targetSize,
      elapsedMs,
      levelIndex: levelIndex + 1, // extra: "nível k/N" (1-based)
      levelCount: cfg.curriculum.enabled ? levelSizes.length : 1,
      promoted,
    },
  });

  const tRest = Date.now(); // o que resta da geração (reprodução + subida) conta-se no fim
  // reprodução: elitismo + cópias dos elite mutadas com o banco adaptativo
  const order = pop.map((_, i) => i).sort((a, b) => fits[b] - fits[a] || a - b);
  const elite = Math.min(cfg.elite, pop.length - 1);
  const next = [];
  const nextOp = [];
  const nextParent = [];
  for (let r = 0; r < elite; r++) {
    next.push(cloneNet(pop[order[r]]));
    nextOp.push(null);
    nextParent.push(0);
  }
  for (let i = elite; i < pop.length; i++) {
    const pIdx = order[i % elite]; // pais em rodízio pelos ranks de elite
    const child = cloneNet(pop[pIdx]);
    if (rng.next() < cfg.mutationRate) {
      // contrato: 1 a 3 mutações por descendente (mais exploração que 1 só)
      const nOps = 1 + Math.floor(rng.next() * 3);
      const applied = [];
      for (let k = 0; k < nOps; k++) {
        const op = bank.pick();
        if (applyOp(child, op, rng)) applied.push(op);
      }
      nextOp.push(applied);
      nextParent.push(fits[pIdx]);
    } else {
      nextOp.push(null);
      nextParent.push(0);
    }
    next.push(child);
  }
  pop = next;
  creditOp = nextOp;
  creditParent = nextParent;

  // E17: subida de nível DEPOIS da reprodução (a população sobe como está)
  if (willPromote) promoteLevel();
  elapsedMs += Date.now() - tRest; // reprodução + subida de nível contam como treino
  return { solved, promoted };
}

// ---- escalonador: lotes de `gensPerBatch` gerações com yield entre lotes ----

function stopLoop() {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}

function scheduleNext() {
  if (timer !== null) return;
  timer = setTimeout(() => {
    timer = null;
    tick();
  }, 0);
}

function tick() {
  if (!running || paused) return;
  const batch = Math.max(1, gensPerBatch | 0);
  let stopSolved = false;
  let stopTime = false;
  try {
    // orçamento de TEMPO por tick (não nº de gerações): a mensagem 'pause' só é
    // processada quando o call stack esvazia, por isso cada tick tem de ser curto.
    // Pausa reage em <= ~50 ms a qualquer velocidade; resume continua a geração.
    const budgetMs = Math.min(24, 2 + 2 * (batch | 0));
    const t0 = Date.now();
    while (Date.now() - t0 < budgetMs) {
      if (!running || paused) break;
      if (!(remaining > 0)) break; // teto de segurança esgotado (remaining finito)
      if (evalCursor < 0) beginGeneration();
      const slice = evalSlice();
      if (slice === 'more') continue; // geração em curso: próxima fatia
      const res = runOneGeneration();
      if (remaining !== Infinity) remaining--;
      if (res && res.solved) {
        stopSolved = true;
        break;
      }
      // limite de tempo de treino esgotado (pausas não contam no elapsedMs)
      if (cfg.timeLimitMs > 0 && elapsedMs >= cfg.timeLimitMs) {
        stopTime = true;
        break;
      }
    }
  } catch (err) {
    running = false;
    remaining = 0;
    self.postMessage({
      type: 'done',
      epoch,
      summary: {
        gen,
        best: lastBest,
        mean: lastMean,
        globalBest,
        solved: false,
        reason: 'error',
        finalLevel: currentLevel(), // E17: nível onde a corrida parou
        targetSize: currentTarget(),
        elapsedMs,
        timeLimitMs: cfg.timeLimitMs,
        error: String(err),
      },
    });
    return;
  }
  // E4: paragem por resolução (solved: true), limite de tempo (reason 'time')
  // ou teto de segurança (reason 'limit'); nunca paragem silenciosa.
  if (stopSolved || stopTime || !(remaining > 0)) {
    running = false;
    remaining = 0;
    self.postMessage({
      type: 'done',
      epoch,
      summary: {
        gen,
        best: lastBest,
        mean: lastMean,
        globalBest,
        solved: stopSolved,
        reason: stopSolved ? 'solved' : stopTime ? 'time' : 'limit',
        finalLevel: currentLevel(), // E17: nível final atingido (tamanho)
        targetSize: currentTarget(),
        elapsedMs,
        timeLimitMs: cfg.timeLimitMs,
      },
    });
    return;
  }
  scheduleNext();
}

// ---- protocolo de mensagens ----

// `epoch`: carimbo de corrida ecoado em TODAS as mensagens de saída. O reset/init
// recebem um epoch novo e as mensagens da corrida antiga (ainda enfileiradas quando o
// reset chega) são descartadas pelo recetor por divergência de epoch.
let epoch = 0;

function handle(msg) {
  if (msg.epoch != null) epoch = msg.epoch | 0;
  switch (msg.type) {
    case 'init': {
      init(msg.config);
      break;
    }
    case 'run': {
      if (!pop.length) init({}); // defensivo: run sem init
      // E4: 0/ausente = até resolver (sem teto); n > 0 = teto de segurança.
      // Pedidos acumulam-se; qualquer pedido "até resolver" deixa a corrida sem teto.
      const g = msg.generations == null ? 0 : clampInt(msg.generations, 0, GEN_MAX, 0);
      remaining = g > 0 ? remaining + g : Infinity;
      running = true;
      paused = false;
      scheduleNext();
      break;
    }
    case 'pause': {
      paused = true;
      break;
    }
    case 'resume': {
      if (!pop.length) init({});
      paused = false;
      if (remaining > 0) {
        running = true;
        scheduleNext();
      }
      break;
    }
    case 'reset': {
      init(msg.config || {});
      break;
    }
    case 'setSpeed': {
      gensPerBatch = clampInt(msg.gensPerBatch, 1, 200, 1);
      break;
    }
    case 'setTimeLimit': {
      // extra (fora do contrato base): ajusta o limite de tempo em tempo real,
      // sem reiniciar o desafio (0 = sem limite). Ignorada em silêncio se não
      // for enviada: o limite de config também serve.
      cfg = { ...cfg, timeLimitMs: clampInt(msg.timeLimitMs, 0, 24 * 60 * 60 * 1000, cfg.timeLimitMs) };
      break;
    }
    default:
      break; // mensagens desconhecidas são ignoradas
  }
}

self.onmessage = (ev) => {
  const msg = ev && ev.data;
  if (msg && typeof msg === 'object') handle(msg);
};
