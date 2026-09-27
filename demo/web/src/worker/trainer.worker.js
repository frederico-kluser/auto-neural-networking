/**
 * web/src/worker/trainer.worker.js [F] · worker de treino (neuroevolução).
 * Contrato: demo/CONTRACTS.md § "Worker [F]" + EMENDA v2 § E4.
 *
 * Entradas: { type:'init', config }  { type:'run', generations }  { type:'pause' }
 *           { type:'resume' }  { type:'reset', config? }  { type:'setSpeed', gensPerBatch }
 * Saídas:   { type:'generation', stats }  { type:'best', net }  { type:'done', summary }
 *
 * E4 · paragem: por omissão a corrida SÓ pára quando o desafio está resolvido (ou o
 * utilizador pausa/reinicia). `run` com `generations: 0` (ou ausente) = correr até
 * resolver; `generations: n > 0` = teto de segurança opcional (pára na geração n
 * mesmo sem resolver). Critério de resolvido: o melhor da geração resolve
 * (episode solved=true) TODOS os labirintos de treino numa avaliação.
 * Cada `generation` ganha `stats.solvedCount`/`stats.mazeCount` (números; ecoados
 * também no topo da mensagem) e `done.summary.solved` é true APENAS quando a
 * paragem foi por resolução (falso no teto de segurança, erro, etc.).
 *
 * O ciclo de gerações é conduzido aqui com as primitivas de core/* (evaluate,
 * applyOp, makeOperatorBank, cloneNet) porque evolve() não devolve a população
 * entre lotes; a semântica segue o contrato: elitismo, mutationRate, rng
 * determinístico por seed e banco adaptativo (pursuit). O `net` de 'best' é o
 * objeto Net clonado (structured clone do postMessage), nunca serializado à mão.
 * Para o critério E4 usa-se `solvedCount(net, mazes, opts)` de core/evolution.mjs
 * quando existe (helper acrescentado em paralelo; verificado em runtime a cada
 * geração) com verificação defensiva da forma { solved, total }, e fallback para
 * runEpisode por labirinto. A aridade de entrada da rede é detetada a partir do
 * tamanho real do vetor de sensores do core (8; 12 depois da EMENDA v2 § E2).
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
const MAZE_COUNT = 3; // labirintos de avaliação por omissão
const GEN_MAX = 1000000; // teto absoluto de gerações por pedido de `run`

const DEFAULTS = {
  population: 60,
  generations: 0, // E4: 0 = até resolver (teto de segurança só se pedido)
  seed: 1,
  elite: 6,
  mutationRate: 0.9,
  mazeSize: 11,
  memoryMode: 'sinapses', // E13: 'sinapses' | 'mapa' | 'ambos'
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
  return {
    population,
    // E4: 0 válido = "até resolver"; n > 0 = teto de segurança
    generations: clampInt(c.generations, 0, GEN_MAX, DEFAULTS.generations),
    seed: clampInt(c.seed, 0, 2147483647, DEFAULTS.seed),
    elite: clampInt(c.elite, 1, Math.max(1, population - 1), Math.min(DEFAULTS.elite, population - 1)),
    mutationRate: Number.isFinite(mr) ? Math.min(1, Math.max(0, mr)) : DEFAULTS.mutationRate,
    mazeSize: oddSize(c.mazeSize, DEFAULTS.mazeSize),
    memoryMode: ['sinapses', 'mapa', 'ambos'].includes(c.memoryMode) ? c.memoryMode : (['sinapses', 'mapa', 'ambos'].includes(base?.memoryMode) ? base.memoryMode : DEFAULTS.memoryMode),
    mazes: c.mazes,
  };
}

/** Labirintos de avaliação: `seed + k` para cada um (determinístico). */
function buildMazes(cfg) {
  const out = [];
  const add = (size, k) => out.push(generateMaze(size, size, cfg.seed + k));
  if (Array.isArray(cfg.mazes) && cfg.mazes.length) {
    // lista de tamanhos (um labirinto por entrada)
    cfg.mazes.forEach((sz, k) => add(oddSize(sz, cfg.mazeSize), k));
  } else {
    // número => quantidade de labirintos (por omissão MAZE_COUNT)
    const n = clampInt(cfg.mazes, 1, 16, MAZE_COUNT);
    for (let k = 0; k < n; k++) add(cfg.mazeSize, k);
  }
  return out;
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

// ---- critério de resolvido (EMENDA v2 § E4) ----

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
 * { solvedCount, total } do `net` sobre os labirintos de treino numa avaliação.
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
      const r = helper(net, mazeList, { memoryMode: cfg.memoryMode });
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

// ---- estado persistente da corrida ----

let cfg = sanitizeConfig({}, DEFAULTS);
let rng = null;
let bank = null;
let mazes = [];
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

function drawSeed() {
  return Math.floor(rng.next() * 0x7fffffff);
}

/** (Re)constrói rng, banco, labirintos e população; zera contadores. */
function init(rawConfig) {
  stopLoop();
  cfg = sanitizeConfig(rawConfig, cfg);
  rng = makeRng(cfg.seed);
  bank = makeOperatorBank(rng);
  mazes = buildMazes(cfg);
  const nIn = detectInputCount(mazes, cfg.memoryMode !== 'sinapses'); // E13: mapa só em 'mapa'/'ambos'
  pop = [];
  for (let i = 0; i < cfg.population; i++) {
    pop.push(makeNetwork({ nInputs: nIn, nOutputs: N_OUT, seed: drawSeed(), nSlots: N_SLOTS, fastOn: cfg.memoryMode !== 'mapa' }));
  }
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
}

/**
 * Uma geração completa: avaliar, dar crédito ao banco, reportar, reproduzir.
 * Devolve { solved } (E4): true quando o melhor atual resolve TODOS os labirintos
 * de treino numa avaliação — único motivo de paragem por omissão da corrida.
 */
function runOneGeneration() {
  // avaliação de toda a população em todos os labirintos (média)
  let best = -Infinity;
  let bestIdx = 0;
  let sum = 0;
  for (let i = 0; i < pop.length; i++) {
    const f = evaluate(pop[i], mazes, { memoryMode: cfg.memoryMode });
    fits[i] = f;
    sum += f;
    if (f > best) {
      best = f;
      bestIdx = i;
    }
  }
  const mean = sum / pop.length;

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

  // E4: quantos labirintos resolve o melhor atual? (critério de paragem + UI)
  const { solvedCount, total: mazeCount } = evalSolved(pop[bestIdx], mazes);
  const solved = mazeCount > 0 && solvedCount >= mazeCount;

  gen++;
  lastBest = best;
  lastMean = mean;
  if (best > globalBest) {
    globalBest = best;
    self.postMessage({ type: 'best', net: cloneNet(pop[bestIdx]), epoch });
  }
  self.postMessage({
    type: 'generation',
    epoch,
    solvedCount, // eco no topo da mensagem (E4); o canónico é stats.solvedCount
    mazeCount,
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
    },
  });

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
  return { solved };
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
  try {
    for (let k = 0; k < batch; k++) {
      if (!running || paused) break;
      if (!(remaining > 0)) break; // teto de segurança esgotado (remaining finito)
      const res = runOneGeneration();
      if (remaining !== Infinity) remaining--;
      if (res && res.solved) {
        stopSolved = true;
        break;
      }
    }
  } catch (err) {
    running = false;
    remaining = 0;
    self.postMessage({
      type: 'done',
      epoch,
      summary: { gen, best: lastBest, mean: lastMean, globalBest, solved: false, error: String(err) },
    });
    return;
  }
  // E4: paragem por resolução (solved: true) ou teto de segurança (solved: false)
  if (stopSolved || !(remaining > 0)) {
    running = false;
    remaining = 0;
    self.postMessage({
      type: 'done',
      epoch,
      summary: { gen, best: lastBest, mean: lastMean, globalBest, solved: stopSolved },
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
    default:
      break; // mensagens desconhecidas são ignoradas
  }
}

self.onmessage = (ev) => {
  const msg = ev && ev.data;
  if (msg && typeof msg === 'object') handle(msg);
};