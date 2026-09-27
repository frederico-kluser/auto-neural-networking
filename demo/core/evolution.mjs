// Episódios e neuroevolução (CONTRACTS.md §core/evolution.mjs).
// Dependências declaradas: ./network.mjs, ./ops.mjs, ./maze.mjs (DIR_VEC), ./sensors.mjs (sense).

import { makeNetwork, resetNet, step, cloneNet, countNeurons, countConns } from './network.mjs';
import { applyOp, makeOperatorBank } from './ops.mjs';
import { DIR_VEC } from './maze.mjs';
import { sense } from './sensors.mjs';

export const STEP_TICKS = 3;

const REVISIT_PENALTY = -0.005;
const BUMP_PENALTY = -0.005; // "senão fica, penalidade" (contrato não quantifica; usa a mesma constante)

// ── EMENDA v5/E13: modo de memória configurável ───────────────────────────────
// 'sinapses' (DEFEITO): 12 entradas + sinapses rápidas (W+F) — a memória vive na rede;
// 'mapa':              12 + cols*rows entradas (mapa E7) e sinapses rápidas DESLIGADAS;
// 'ambos':             12 + cols*rows entradas E sinapses rápidas ligadas.
// Consequência-chave: com 12 entradas fixas uma rede treinada num labirinto joga em
// QUALQUER labirinto, de qualquer tamanho (reprodução cruzada).
export const MEMORY_MODES = {
  sinapses: { withMap: false, fastOn: true },
  mapa: { withMap: true, fastOn: false },
  ambos: { withMap: true, fastOn: true },
};

// Normaliza opts.memoryMode; valor desconhecido/ausente cai no defeito 'sinapses'.
function memoryModeOf(opts) {
  const name = opts && MEMORY_MODES[opts.memoryMode] ? opts.memoryMode : 'sinapses';
  return { name, ...MEMORY_MODES[name] };
}

// PRNG interno (mulberry32): evolve() é determinístico para o mesmo seed sem depender de rng.mjs.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Fórmula canónica de fitness (copiada literalmente do contrato).
// startDist = manhattan(start, exit), endDist = manhattan(posFinal, exit),
// visited = células visitadas distintas, openCells = total de células abertas do labirinto.
export function fitnessOf({ solved, steps, maxSteps, startDist, endDist, visited, openCells }) {
  return solved
    ? 1.5 + (1 - steps / maxSteps) + 0.5 * (visited / openCells)
    : (1 - endDist / startDist) * 1.0 - steps * 0.002 + 0.25 * (visited / openCells);
}

const manhattan = (ax, ay, bx, by) => Math.abs(ax - bx) + Math.abs(ay - by);

function countOpenCells(maze) {
  let c = 0;
  for (let y = 0; y < maze.rows; y++) {
    for (let x = 0; x < maze.cols; x++) if (!maze.isWall(x, y)) c++;
  }
  return c;
}

export function runEpisode(net, maze, opts = {}) {
  const maxSteps = opts.maxSteps ?? maze.cols * maze.rows * 2;
  const trace = opts.trace === true;
  const mode = memoryModeOf(opts); // E13
  resetNet(net);
  net.fastOn = mode.fastOn; // E13: o modo liga/desliga as sinapses rápidas (W+F)
  let x = maze.start.x;
  let y = maze.start.y;
  const exit = maze.exit;
  const startDist = manhattan(x, y, exit.x, exit.y);
  // Memória E2: Uint8Array(cols*rows) indexado como maze.grid (1 = célula já ocupada).
  // Marca o start e cada célula ocupada (incluindo a final) e alimenta sense().
  const visited = new Uint8Array(maze.cols * maze.rows);
  visited[maze.idx(x, y)] = 1;
  let visitedCount = 1;
  const path = [{ x, y }];
  const sensorTrace = trace ? [] : null;
  let steps = 0;
  let solved = false;
  let penalty = 0;
  while (steps < maxSteps) {
    const s = sense(maze, x, y, visited, { withMap: mode.withMap }); // E13
    if (trace) sensorTrace.push(s);
    let yOut = null;
    for (let t = 0; t < STEP_TICKS; t++) yOut = step(net, s);
    let dir = 0;
    for (let i = 1; i < yOut.length; i++) if (yOut[i] > yOut[dir]) dir = i;
    const d = DIR_VEC[dir % DIR_VEC.length];
    const nx = x + d[0];
    const ny = y + d[1];
    steps++;
    if (maze.isWall(nx, ny)) {
      penalty += BUMP_PENALTY; // fica no lugar
    } else {
      x = nx;
      y = ny;
      const id = maze.idx(x, y);
      if (visited[id]) penalty += REVISIT_PENALTY;
      else {
        visited[id] = 1;
        visitedCount++;
      }
      if (x === exit.x && y === exit.y) solved = true;
    }
    path.push({ x, y });
    if (solved) break;
  }
  const endDist = manhattan(x, y, exit.x, exit.y);
  const fitness = fitnessOf({
    solved,
    steps,
    maxSteps,
    startDist,
    endDist,
    visited: visitedCount,
    openCells: countOpenCells(maze),
  }) + penalty;
  return { solved, steps, path, fitness, sensorTrace };
}

export function evaluate(net, mazes, opts = {}) {
  let sum = 0;
  for (const maze of mazes) sum += runEpisode(net, maze, opts).fitness;
  return sum / mazes.length;
}

// EMENDA v2/E4 (núcleo): quantos mazes o net resolve numa avaliação (o worker usa isto
// como critério de paragem "resolve TODOS os labirintos de treino").
export function solvedCount(net, mazes, opts = {}) {
  let solved = 0;
  for (const maze of mazes) if (runEpisode(net, maze, opts).solved) solved++;
  return { solved, total: mazes.length };
}

// evolve({ population=60, generations=50, mazes, seed=1, elite=6, mutationRate=0.9,
//          memoryMode='sinapses' }) (E13: nIn e sinapses rápidas seguem o modo).
// Por geração: avalia todos em todos os mazes (média), elitismo dos `elite` melhores,
// resto = cópias de elite + 1 a 3 ops de applyOp (banco adaptativo, uma op por sorteio)
// quando rng.next() < mutationRate.
// Recompensa do banco = max(0, fitness_filho − fitness_pai), creditada a cada op do filho.
// E12: estagnação do melhor global por 25 gerações ⇒ burst de neurogénese (setBias
// {addNeuron:2.5, addMemoryNeuron:3} por 50 gerações); o resultado inclui
// `neurogenesisBursts` e as stats de hooks.onGeneration incluem `stalled`.
export function evolve(config = {}, hooks = {}) {
  const population = Math.max(2, Math.floor(config.population ?? 60));
  const generations = Math.max(1, Math.floor(config.generations ?? 50));
  const mazes = config.mazes;
  if (!Array.isArray(mazes) || !mazes.length) throw new Error('evolve: config.mazes vazio');
  const seed = config.seed ?? 1;
  const elite = Math.min(population, Math.max(1, Math.floor(config.elite ?? 6)));
  const mutationRate = config.mutationRate ?? 0.9;
  const nSlots = config.nSlots ?? 32;
  // E13: modo de memória ('sinapses' | 'mapa' | 'ambos', defeito 'sinapses').
  const mode = memoryModeOf(config);
  const epOpts = { memoryMode: mode.name };

  const rng = { next: mulberry32(seed) };
  const bank = makeOperatorBank(rng);
  let nextIdx = population;

  // EMENDA v4/E7 + v5/E13: nIn dinâmico DETETADO a partir do labirinto e do modo —
  // 12 sinais nomeados (+ 1 entrada por célula quando o modo traz mapa). Sem contagens
  // fixas em lado nenhum: o comprimento sai do próprio sense().
  const nInputs = sense(mazes[0], mazes[0].start.x, mazes[0].start.y, null, { withMap: mode.withMap }).length;

  const pop = [];
  for (let i = 0; i < population; i++) {
    pop.push({
      idx: i,
      net: makeNetwork({ nInputs, nOutputs: 4, seed: (seed * 1000003 + i * 7919 + 1) >>> 0, nSlots, fastOn: mode.fastOn }),
      fitness: NaN,
      mutOps: null,
      parentFitness: 0,
    });
  }

  const history = [];
  let best = -Infinity;
  let bestNet = null;
  let generationsRun = 0;

  // ── EMENDA v5/E12: neurogénese por estagnação (Cascade-Correlation, Fahlman &
  // Lebiere 1990; "novos neurónios para memórias novas", Deng 2010) ──────────────
  // Quando o MELHOR GLOBAL não melhora durante K gerações consecutivas, ativa-se um
  // burst de neurogénese: setBias({addNeuron: 2.5, addMemoryNeuron: 3}) por 50
  // gerações e depois limpa. Repetível após OUTRA estagnação de K gerações.
  const STALL_K = 25;
  const BURST_GENS = 50;
  const NEUROGENESIS_BIAS = { addNeuron: 2.5, addMemoryNeuron: 3 };
  let stallCount = 0; // gerações consecutivas sem melhoria do melhor global
  let stallAnchor = 0; // stallCount da última âncora (burst terminado/melhoria)
  let burstLeft = 0; // gerações de burst ainda ativas
  let neurogenesisBursts = 0;

  for (let gen = 1; gen <= generations; gen++) {
    let mean = 0;
    for (const ind of pop) {
      ind.fitness = evaluate(ind.net, mazes, epOpts);
      mean += ind.fitness;
      if (ind.mutOps) {
        // crédito do banco: melhoria do filho vs pai, repartida por todas as ops do filho
        const reward = Math.max(0, ind.fitness - ind.parentFitness);
        for (const opName of ind.mutOps) bank.update(opName, reward);
        ind.mutOps = null;
      }
    }
    mean /= population;

    const ranked = pop.slice().sort((a, b) => (b.fitness - a.fitness) || (a.idx - b.idx));
    const genBest = ranked[0];
    const improved = genBest.fitness > best;
    if (improved) {
      best = genBest.fitness;
      bestNet = cloneNet(genBest.net);
    }
    // Estagnação do melhor global (E12)
    if (improved) {
      stallCount = 0;
      stallAnchor = 0;
    } else {
      stallCount++;
    }
    if (burstLeft > 0) {
      burstLeft--;
      if (burstLeft === 0) { // burst terminou: limpa o bias e reancora a estagnação
        bank.setBias({});
        stallAnchor = stallCount;
      }
    } else if (stallCount - stallAnchor >= STALL_K) {
      // estagnação de K gerações ⇒ burst de neurogénese por BURST_GENS gerações
      bank.setBias(NEUROGENESIS_BIAS);
      burstLeft = BURST_GENS;
      neurogenesisBursts++;
    }
    const stalled = stallCount >= STALL_K;
    const entry = {
      gen,
      best: genBest.fitness,
      mean,
      nNeurons: countNeurons(genBest.net),
      nConns: countConns(genBest.net),
    };
    history.push(entry);
    generationsRun = gen;

    const stats = { ...entry, bankStats: bank.stats(), bestNet: genBest.net, globalBestNet: bestNet, stalled };
    if (hooks.onGeneration) hooks.onGeneration(gen, stats);
    if (hooks.shouldStop && hooks.shouldStop(stats)) break;
    if (gen === generations) break;

    const next = [];
    for (let i = 0; i < elite; i++) next.push(ranked[i]);
    for (let i = elite; i < population; i++) {
      const parent = ranked[rndInt(rng, elite)];
      const child = {
        idx: nextIdx++, // identificador estável para desempate determinístico
        net: cloneNet(parent.net),
        fitness: NaN,
        mutOps: null,
        parentFitness: parent.fitness,
      };
      if (rng.next() < mutationRate) {
        const nOps = 1 + rndInt(rng, 3); // 1 a 3 ops, uma por sorteio
        const ops = [];
        for (let m = 0; m < nOps; m++) {
          const opName = bank.pick();
          applyOp(child.net, opName, rng);
          ops.push(opName);
        }
        child.mutOps = ops;
      }
      next.push(child);
    }
    pop.length = 0;
    for (const ind of next) pop.push(ind);
  }

  return { best, bestNet, history, bankStats: bank.stats(), generations: generationsRun, neurogenesisBursts };
}

function rndInt(rng, m) {
  return Math.floor(rng.next() * m);
}
