/**
 * main.js — integração da demo (integração).
 *
 * Liga: store · views 3D (neural3d/maze3d) · UI (controls/stats) · training-store ·
 * worker de treino · playback de episódios na UI thread (1 ou 2 agentes).
 *
 * Regras-chave (emendas v5):
 *  - cada rede é alimentada com o SEU layout de entradas: nIn === 12 → sem mapa;
 *    nIn > 12 → com mapa (opts.withMap). É isto que permite jogar com treinos de
 *    labirintos diferentes (e de tamanhos diferentes, no modo 'sinapses').
 *  - reprodução dupla: dois treinos no MESMO labirinto (A âmbar, B azul-pálido).
 *  - treino corre no worker até vencer; o playback nunca bloqueia.
 */

import { store } from './state.js';
import { createNeuralView } from './viz/neural3d.js';
import { createMazeView } from './viz/maze3d.js';
import { mountControls } from './ui/controls.js';
import { mountStats } from './ui/stats.js';
import * as trainingStore from './training-store.js';

import { generateMaze } from '../../core/maze.mjs';
import { sense } from '../../core/sensors.mjs';
import { makeNetwork, resetNet, step } from '../../core/network.mjs';
import { STEP_TICKS } from '../../core/evolution.mjs';
import { OP_NAMES } from '../../core/ops.mjs';

const COLOR_A = '#F5B04A';
const COLOR_B = '#8FB8DA';

/* ─────────────────────────── views 3D ─────────────────────────── */

const neuralView = createNeuralView(document.getElementById('viz-neural'));
const mazeView = createMazeView(document.getElementById('viz-maze'));
document.getElementById('viz-neural-placeholder')?.remove();
document.getElementById('viz-maze-placeholder')?.remove();

/* ─────────────────────── worker de treino ─────────────────────── */

const worker = new Worker(new URL('./worker/trainer.worker.js', import.meta.url), { type: 'module' });
let workerReady = false;
let epoch = 0; // corrida: mensagens com epoch divergente são descartadas
let championNet = null; // melhor rede do worker (structured clone)

function bankStatsFrom(msg) {
  const raw = msg.bankStats ?? msg.bankProbs;
  if (!raw) return {};
  if (Array.isArray(raw) || ArrayBuffer.isView(raw)) {
    const out = {};
    OP_NAMES.forEach((op, i) => { out[op] = { p: Number(raw[i] ?? 0), q: 0, count: 0 }; });
    return out;
  }
  return raw;
}

worker.addEventListener('message', (ev) => {
  const msg = ev.data;
  if (msg.epoch != null && msg.epoch !== epoch) return;
  if (msg.type === 'generation') {
    const s = msg.stats ?? msg;
    const history = [...(store.get().history ?? []), { gen: s.gen, best: s.best, mean: s.mean }];
    store.set({
      generation: s.gen, bestFitness: s.best, meanFitness: s.mean,
      nNeurons: s.nNeurons, nConns: s.nConns,
      bankStats: bankStatsFrom(s), history,
      solvedCount: s.solvedCount ?? 0, mazeCount: s.mazeCount ?? 0,
    });
  } else if (msg.type === 'best') {
    championNet = msg.net;
    rebuildPlayers();
  } else if (msg.type === 'done') {
    const solved = !!(msg.summary && msg.summary.solved);
    store.set({ training: 'idle', solved, stopReason: solved ? 'solved' : 'limit' });
  }
});

worker.addEventListener('error', (err) => {
  console.error('[worker] falhou:', err.message ?? err);
  store.set({ training: 'idle' });
});

/* ──────────────────────── playback (1-2 agentes) ──────────────────────── */

let playMaze = null;
let players = []; // [{ net, visited, ep, color, holdUntil, lastY }]
let lastPublish = 0;

// E13/E14: cada rede diz o que come — nIn 12 ⇒ sem mapa; nIn > 12 ⇒ com mapa
const netInputsFor = (maze) => 12 + maze.cols * maze.rows;
const netFitsMaze = (net, maze) => !!net && (net.nIn === 12 || net.nIn === netInputsFor(maze));
const senseFor = (net, maze, x, y, visited) => sense(maze, x, y, visited, { withMap: net.nIn > 12 });

function makePlayer(net, color) {
  return { net, color, visited: null, ep: null, holdUntil: 0, lastY: new Float32Array(4) };
}

function trainingToNet(rec) {
  try { return trainingStore.deserializeNet(rec.net); } catch { return null; }
}

function rebuildPlayers() {
  const st = store.get();
  const sel = (st.selectedTrainingIds ?? []).slice(0, 2)
    .map((id) => trainingStore.load(id))
    .filter(Boolean);
  const playersNew = [];
  if (sel.length === 2) {
    // reprodução dupla: dois treinos guardados, no mesmo labirinto
    sel.forEach((rec, i) => {
      const net = trainingToNet(rec);
      if (netFitsMaze(net, playMaze)) playersNew.push(makePlayer(net, i === 0 ? COLOR_A : COLOR_B));
    });
  }
  if (!playersNew.length) {
    const src = st.playbackSource;
    if (src && src.kind === 'training') {
      const rec = trainingStore.load(src.id);
      const net = rec && trainingToNet(rec);
      if (netFitsMaze(net, playMaze)) playersNew.push(makePlayer(net, COLOR_A));
    }
  }
  if (!playersNew.length) {
    if (netFitsMaze(championNet, playMaze)) playersNew.push(makePlayer(championNet, COLOR_A));
    else playersNew.push(makePlayer(makeNetwork({ nInputs: netInputsFor(playMaze), seed: st.seed }), COLOR_A));
  }
  players = playersNew;
  restartEpisodes();
}

function restartEpisodes() {
  if (!playMaze) return;
  for (const p of players) {
    resetNet(p.net);
    p.visited = new Uint8Array(playMaze.cols * playMaze.rows);
    p.visited[playMaze.idx(playMaze.start.x, playMaze.start.y)] = 1;
    p.ep = {
      x: playMaze.start.x, y: playMaze.start.y,
      path: [{ x: playMaze.start.x, y: playMaze.start.y }],
      sensors: senseFor(p.net, playMaze, playMaze.start.x, playMaze.start.y, p.visited),
      outputs: new Float32Array(4), solved: false, steps: 0,
    };
    p.holdUntil = 0;
  }
  pushAgents();
}

function pushAgents() {
  mazeView.updateAgents(players.map((p) => ({
    x: p.ep.x, y: p.ep.y, path: p.ep.path, sensors: p.ep.sensors, visited: p.visited, color: p.color,
  })));
}

function stepPlayer(p) {
  const ep = p.ep;
  if (!ep || !playMaze) return;
  if (ep.solved) {
    if (p.holdUntil && performance.now() < p.holdUntil) return;
    p.holdUntil = 0;
    // volta de vitória: recomeça este agente
    p.visited = new Uint8Array(playMaze.cols * playMaze.rows);
    p.visited[playMaze.idx(playMaze.start.x, playMaze.start.y)] = 1;
    ep.x = playMaze.start.x; ep.y = playMaze.start.y;
    ep.path = [{ x: ep.x, y: ep.y }];
    ep.solved = false; ep.steps = 0;
    ep.sensors = senseFor(p.net, playMaze, ep.x, ep.y, p.visited);
    return;
  }
  ep.sensors = senseFor(p.net, playMaze, ep.x, ep.y, p.visited);
  let y;
  for (let t = 0; t < STEP_TICKS; t++) y = step(p.net, ep.sensors);
  if (y) p.lastY = y;
  ep.outputs = p.lastY;
  let dir = 0;
  for (let i = 1; i < p.lastY.length; i++) if (p.lastY[i] > p.lastY[dir]) dir = i;
  const [dx, dy] = [[0, -1], [0, 1], [-1, 0], [1, 0]][dir];
  const nx = ep.x + dx, ny = ep.y + dy;
  if (!playMaze.isWall(nx, ny)) {
    ep.x = nx; ep.y = ny;
    ep.path.push({ x: nx, y: ny });
    p.visited[playMaze.idx(nx, ny)] = 1;
  }
  ep.steps++;
  if (ep.x === playMaze.exit.x && ep.y === playMaze.exit.y) {
    ep.solved = true;
    p.holdUntil = performance.now() + 2500; // volta de vitória visível
  }
}

function frame(now) {
  const n = SPEED_STEPS[store.get().speed] ?? 1;
  for (let i = 0; i < n; i++) for (const p of players) stepPlayer(p);
  pushAgents();
  const p0 = players[0];
  if (p0) {
    neuralView.update(p0.net, {
      h: p0.net.h, y: p0.lastY, inputs: p0.ep.sensors, solved: p0.ep.solved,
      maze: { cols: playMaze.cols, rows: playMaze.rows },
    });
  }
  if (now - lastPublish >= 125 && p0) {
    lastPublish = now;
    store.set({
      episode: {
        x: p0.ep.x, y: p0.ep.y, path: p0.ep.path,
        sensors: p0.ep.sensors, outputs: p0.ep.outputs, solved: p0.ep.solved,
      },
    });
  }
  requestAnimationFrame(frame);
}

/* Passos de episódio por frame: limitados de propósito (a velocidade do TREINO
   controla as épocas por lote; a animação do agente tem de ficar observável). */
const SPEED_STEPS = { 1: 1, 4: 2, 16: 3, max: 4 };

function regenerateMaze() {
  const { mazeSize, seed } = store.get();
  playMaze = generateMaze(mazeSize, mazeSize, seed);
  mazeView.setMaze(playMaze);
  rebuildPlayers();
}

/* ─────────────────────────── ações da UI ─────────────────────────── */

function readConfig() {
  const num = (id, fallback) => {
    const v = Number.parseInt(document.querySelector(id)?.value ?? '', 10);
    return Number.isFinite(v) ? v : fallback;
  };
  return {
    population: Math.max(2, num('#ctrl-population', 60)),
    generations: Math.max(0, num('#ctrl-generations', 0)), // 0 = até resolver
    mazeSize: Math.max(5, num('#ctrl-maze-size', 11) | 1),
    seed: Math.max(0, num('#ctrl-seed', 1)),
    elite: 6,
    mutationRate: 0.9,
    memoryMode: store.get().memoryMode ?? 'sinapses',
  };
}

const actions = {
  train() {
    const cfg = readConfig();
    if (!workerReady) {
      worker.postMessage({ type: 'init', config: cfg, epoch });
      workerReady = true;
    } else {
      worker.postMessage({ type: 'resume' });
    }
    worker.postMessage({ type: 'run', generations: cfg.generations });
    store.set({ training: 'running', solved: false, stopReason: null });
  },
  pause() {
    worker.postMessage({ type: 'pause' });
    store.set({ training: 'paused' });
  },
  reset() {
    const cfg = readConfig();
    epoch++;
    worker.postMessage({ type: 'reset', config: cfg, epoch });
    workerReady = true;
    championNet = null;
    store.set({
      training: 'idle', generation: 0, bestFitness: 0, meanFitness: 0,
      nNeurons: 0, nConns: 0, bankStats: {}, history: [],
      solved: false, solvedCount: 0, mazeCount: 0, stopReason: null,
    });
    regenerateMaze();
  },
  setSpeed(n) {
    const canonical = (n === 'max' || n === 50) ? 'max' : (Number(n) || 1);
    store.set({ speed: canonical });
    worker.postMessage({ type: 'setSpeed', gensPerBatch: canonical === 'max' ? 50 : Math.max(1, Number(canonical) || 1) });
  },
  setAutoRotate(on) {
    const enabled = !!on;
    store.set({ autoRotate: enabled });
    neuralView.setAutoRotate(enabled);
    mazeView.setAutoRotate(enabled);
  },
  setMazeSize(n) { store.set({ mazeSize: n }); regenerateMaze(); },
  setSeed(n) { store.set({ seed: n }); regenerateMaze(); },

  /* — treinos guardados (E14) — */
  saveTraining(name) {
    const net = championNet ?? players[0]?.net;
    if (!net) return;
    const st = store.get();
    const rec = trainingStore.save({
      name: String(name || 'treino').slice(0, 60),
      meta: {
        mazeSize: st.mazeSize, seed: st.seed,
        epochs: st.generation, fitness: st.bestFitness,
        memoryMode: st.memoryMode ?? 'sinapses', nIn: net.nIn,
        createdAt: Date.now(),
      },
      net: trainingStore.serializeNet(net),
    });
    if (rec) store.set({ savedTrainings: trainingStore.list() });
  },
  playTraining(id) {
    store.set({ playbackSource: { kind: 'training', id }, selectedTrainingIds: [] });
    rebuildPlayers();
  },
  toggleCompareTraining(id) {
    const st = store.get();
    let sel = [...(st.selectedTrainingIds ?? [])];
    if (sel.includes(id)) sel = sel.filter((x) => x !== id);
    else sel = [...sel, id].slice(-2); // máx. 2: os dois mais recentes
    store.set({ selectedTrainingIds: sel, playbackSource: { kind: 'champion' } });
    rebuildPlayers();
  },
  deleteTraining(id) {
    trainingStore.remove(id);
    const sel = (store.get().selectedTrainingIds ?? []).filter((x) => x !== id);
    store.set({ savedTrainings: trainingStore.list(), selectedTrainingIds: sel });
    rebuildPlayers();
  },
  setMemoryMode(mode) {
    const ok = ['sinapses', 'mapa', 'ambos'].includes(mode) ? mode : 'sinapses';
    store.set({ memoryMode: ok });
    // o modo define o layout de entradas do treino: um desafio novo é a contagem certa
    if (workerReady) actions.reset();
    else regenerateMaze();
  },
};

/* ─────────────────────────── arranque ─────────────────────────── */

store.set({ savedTrainings: trainingStore.list() });
mountControls(store, actions);
mountStats(store);
regenerateMaze();
requestAnimationFrame(frame);

window.__demo = { store, actions, neuralView, mazeView, worker, trainingStore };
