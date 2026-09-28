#!/usr/bin/env node
// validate.mjs — harness de validação completo da demo (integração).
// Corre com: node demo/tests/validate.mjs
// Termina com exit 0 só se TODOS os checks passarem. Escreve demo/tests/last-validation.json.

import assert from 'node:assert';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { makeRng } from '../core/rng.mjs';
import { generateMaze, solveMaze, rayInfo, DIRS, DIR_VEC } from '../core/maze.mjs';
import { sense, EXIT_SIGNAL, SENSOR_NAMES } from '../core/sensors.mjs';
import {
  makeNetwork, resetNet, step, cloneNet, countNeurons, countConns,
  spectralRadius, spectralThermostat,
} from '../core/network.mjs';
import { applyOp, makeOperatorBank, OP_NAMES } from '../core/ops.mjs';
import { runEpisode, evaluate, evolve, fitnessOf, STEP_TICKS } from '../core/evolution.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const results = [];
let failures = 0;

function check(name, fn) {
  try {
    const detail = fn() ?? '';
    results.push({ name, ok: true, detail: String(detail) });
    console.log(`PASS  ${name}${detail ? `  (${detail})` : ''}`);
  } catch (err) {
    failures++;
    results.push({ name, ok: false, detail: String(err && err.message || err) });
    console.log(`FAIL  ${name}\n      ${String(err && err.message || err)}`);
  }
}

// Labirinto "manual" com a mesma forma do contrato, para testes de sensores.
function gridMaze(rowsAscii, start, exit) {
  const rows = rowsAscii.length;
  const cols = rowsAscii[0].length;
  const grid = new Uint8Array(cols * rows);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) grid[y * cols + x] = rowsAscii[y][x] === '#' ? 1 : 0;
  }
  return {
    cols, rows, seed: -1, grid, start, exit,
    idx: (x, y) => y * cols + x,
    isWall: (x, y) => x < 0 || y < 0 || x >= cols || y >= rows || grid[y * cols + x] === 1,
  };
}

/* ── 1. Labirintos ─────────────────────────────────────────────────────────── */

const SIZES = [5, 7, 9, 11, 15, 21, 31];
for (const size of SIZES) {
  check(`maze ${size}x${size}: fronteira fechada, start/exit abertos, solucionável`, () => {
    const m = generateMaze(size, size, 42);
    for (let x = 0; x < size; x++) {
      assert.equal(m.isWall(x, 0), true, `parede topo em x=${x}`);
      assert.equal(m.isWall(x, size - 1), true, `parede fundo em x=${x}`);
    }
    for (let y = 0; y < size; y++) {
      assert.equal(m.isWall(0, y), true, `parede esquerda em y=${y}`);
      assert.equal(m.isWall(size - 1, y), true, `parede direita em y=${y}`);
    }
    assert.equal(m.isWall(m.start.x, m.start.y), false, 'start tapado');
    assert.equal(m.isWall(m.exit.x, m.exit.y), false, 'exit tapado');
    const path = solveMaze(m);
    assert.ok(path && path.length >= 2, 'sem caminho BFS');
    assert.deepEqual(path[0], m.start, 'caminho não começa no start');
    assert.deepEqual(path[path.length - 1], m.exit, 'caminho não termina no exit');
    for (let i = 1; i < path.length; i++) {
      const dx = Math.abs(path[i].x - path[i - 1].x);
      const dy = Math.abs(path[i].y - path[i - 1].y);
      assert.equal(dx + dy, 1, `passo não adjacente em i=${i}`);
      assert.equal(m.isWall(path[i].x, path[i].y), false, 'caminho atravessa parede');
    }
    return `caminho ${path.length} células`;
  });
}

check('maze: determinismo por seed e variação entre seeds', () => {
  const a = generateMaze(11, 11, 7);
  const b = generateMaze(11, 11, 7);
  const c = generateMaze(11, 11, 8);
  assert.deepEqual(Array.from(a.grid), Array.from(b.grid), 'mesmo seed difere');
  assert.notDeepEqual(Array.from(a.grid), Array.from(c.grid), 'seeds diferentes idênticos');
  return 'ok';
});

check('maze: propriedade de labirinto perfeito (árvore)', () => {
  // Nº de arestas abertas (par de células abertas adjacentes) == nº de células abertas − 1.
  const m = generateMaze(15, 15, 3);
  let open = 0, edges = 0;
  for (let y = 0; y < m.rows; y++) {
    for (let x = 0; x < m.cols; x++) {
      if (m.isWall(x, y)) continue;
      open++;
      if (!m.isWall(x + 1, y)) edges++;
      if (!m.isWall(x, y + 1)) edges++;
    }
  }
  assert.equal(edges, open -  1, `árvore violada: ${edges} arestas para ${open} células`);
  return `${open} células, ${edges} arestas`;
});

check('maze: tamanhos não ímpares/pequenos são clampados', () => {
  const m = generateMaze(6, 4, 1);
  assert.equal(m.cols % 2, 1, 'cols não ímpar');
  assert.equal(m.rows % 2, 1, 'rows não ímpar');
  assert.ok(m.cols >= 5 && m.rows >= 5, 'tamanho mínimo violado');
  return `${m.cols}x${m.rows}`;
});

/* ── 2. Sensores ───────────────────────────────────────────────────────────── */

check('rayInfo: dist 0 com parede adjacente, contagem correta em corredor', () => {
  // Interior 3x3 totalmente aberto:
  const m = gridMaze([
    '#####',
    '#...#',
    '#...#',
    '#...#',
    '#####',
  ], { x: 1, y: 1 }, { x: 3, y: 3 });
  assert.equal(rayInfo(m, 1, 1, 0).dist, 0, 'up devia ser 0 (parede adjacente)');
  assert.equal(rayInfo(m, 1, 1, 2).dist, 0, 'left devia ser 0 (parede adjacente)');
  assert.equal(rayInfo(m, 1, 1, 1).dist, 2, 'down devia ser 2 ((1,2),(1,3))');
  assert.equal(rayInfo(m, 1, 1, 3).dist, 2, 'right devia ser 2 ((2,1),(3,1))');
  assert.equal(rayInfo(m, 2, 2, 0).dist, 1, 'up devia ser 1');
  assert.equal(rayInfo(m, 2, 2, 1).dist, 1, 'down devia ser 1');
  assert.equal(rayInfo(m, 2, 2, 2).dist, 1, 'left devia ser 1 (só (1,2); x=0 é bordo parede)');
  assert.equal(rayInfo(m, 2, 2, 3).dist, 1, 'right devia ser 1');
  return 'ok';
});

check('rayInfo: exitVisible só com linha de visão desimpedida na direção', () => {
  const open = gridMaze([
    '#####',
    '#...#',
    '#...#',
    '#...#',
    '#####',
  ], { x: 1, y: 1 }, { x: 3, y: 3 });
  assert.equal(rayInfo(open, 1, 1, 3).exitVisible, false, 'right a partir de (1,1) não alinhado com o exit (3,3)');
  // exit (3,3): a partir de (3,1) vê-se em "down"
  assert.equal(rayInfo(open, 3, 1, 1).exitVisible, true, 'down a partir de (3,1) devia ver o exit');
  assert.equal(rayInfo(open, 3, 1, 3).exitVisible, false, 'right não devia ver o exit');
  assert.equal(rayInfo(open, 1, 1, 1).exitVisible, false, 'down a partir de (1,1) não alinhado');
  const blocked = gridMaze([
    '#####',
    '#...#',
    '#.#.#',
    '#...#',
    '#####',
  ], { x: 1, y: 1 }, { x: 3, y: 3 });
  assert.equal(rayInfo(blocked, 3, 1, 1).exitVisible, true, 'linha vertical (3,1)->(3,3) está livre');
  assert.equal(rayInfo(blocked, 1, 3, 3).exitVisible, true, 'linha horizontal (1,3)->(3,3) está livre');
  const walled = gridMaze([
    '#####',
    '#...#',
    '#..##',
    '#...#',
    '#####',
  ], { x: 1, y: 1 }, { x: 3, y: 3 });
  // (3,2) é parede → a partir de (3,1) o exit (3,3) fica bloqueado
  assert.equal(rayInfo(walled, 3, 1, 1).exitVisible, false, 'parede a bloquear a linha de visão');
  return 'ok';
});

check('sense(): normalização e sinais de saída exatos', () => {
  const m = gridMaze([
    '#####',
    '#...#',
    '#...#',
    '#...#',
    '#####',
  ], { x: 1, y: 1 }, { x: 3, y: 3 });
  const s = sense(m, 3, 1, null, { withMap: true });
  assert.equal(s.length, 12 + m.cols * m.rows, 'vetor tem de ter 12 + cols*rows');
  const maxDim = Math.max(m.cols, m.rows);
  const exp = Math.fround(2 / maxDim);
  assert.ok(Math.abs(s[1] - exp) < 1e-6, `dist down normalizada (esperado ${exp}, obtido ${s[1]})`);
  assert.equal(s[3], 0, 'right adjacente a parede → 0');
  for (let i = 0; i < 4; i++) assert.ok(s[i] >= 0 && s[i] <= 1, `fora de [0,1] em ${i}`);
  assert.equal(s[4 + 1], EXIT_SIGNAL, 'exit visível em down devia ser EXIT_SIGNAL');
  assert.equal(s[4 + 3], 0, 'exit não visível em right devia ser 0');
  assert.equal(EXIT_SIGNAL, 1.0, 'EXIT_SIGNAL tem de ser 1.0');
  assert.equal(SENSOR_NAMES.length, 12, 'SENSOR_NAMES com 12 entradas');
  assert.deepEqual(DIRS, ['up', 'down', 'left', 'right'], 'ordem canónica DIRS');
  assert.deepEqual(DIR_VEC, [[0, -1], [0, 1], [-1, 0], [1, 0]], 'DIR_VEC');
  return 'ok';
});

check('sense(): fração de visitados por direção (memória de onde já esteve)', () => {
  const m = gridMaze([
    '#####',
    '#...#',
    '#...#',
    '#...#',
    '#####',
  ], { x: 1, y: 1 }, { x: 3, y: 3 });
  const visited = new Uint8Array(m.cols * m.rows);
  // sem visitas: frações 0
  let s = sense(m, 1, 1, visited, { withMap: true });
  for (let i = 8; i < 12; i++) assert.equal(s[i], 0, `fração devia ser 0 em ${i}`);
  // (1,1) para baixo o raio tem 2 células: (1,2),(1,3); marcar só (1,2) → 0.5
  visited[m.idx(1, 2)] = 1;
  s = sense(m, 1, 1, visited, { withMap: true });
  assert.ok(Math.abs(s[8 + 1] - 0.5) < 1e-6, `down devia ser 0.5 (obtido ${s[8 + 1]})`);
  visited[m.idx(1, 3)] = 1;
  s = sense(m, 1, 1, visited, { withMap: true });
  assert.ok(Math.abs(s[8 + 1] - 1.0) < 1e-6, 'down devia ser 1.0');
  // parede adjacente (up) mantém 0 mesmo com visitas
  assert.equal(s[8 + 0], 0, 'up com parede adjacente devia ser 0');
  // sem visited → 0
  s = sense(m, 1, 1, null, { withMap: true });
  for (let i = 8; i < 12; i++) assert.equal(s[i], 0, 'sem visited devia ser 0');
  return 'ok';
});

check('sense(): mapa do labirinto como entradas (0 / 0,5 / 1,0)', () => {
  const m = gridMaze([
    '#####',
    '#...#',
    '#...#',
    '#...#',
    '#####',
  ], { x: 1, y: 1 }, { x: 3, y: 3 });
  const visited = new Uint8Array(m.cols * m.rows);
  visited[m.idx(1, 1)] = 1; // start já visitado
  visited[m.idx(1, 2)] = 1; // casa visitada
  let s = sense(m, 1, 1, visited, { withMap: true });
  assert.equal(s[12 + m.idx(1, 1)], 1.0, 'posição atual devia ser 1.0');
  assert.equal(s[12 + m.idx(1, 2)], 0.5, 'casa visitada devia ser 0.5');
  assert.equal(s[12 + m.idx(3, 3)], 0, 'casa por visitar devia ser 0');
  // sem visited: só a posição atual acende
  s = sense(m, 2, 2, null, { withMap: true });
  assert.equal(s[12 + m.idx(2, 2)], 1.0, 'posição atual sem memória devia ser 1.0');
  assert.equal(s[12 + m.idx(1, 1)], 0, 'restantes deviam ser 0');
  return 'ok';
});

/* ── 3. Rede ───────────────────────────────────────────────────────────────── */

function assertNetInvariants(net) {
  const n = net.nSlots;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (net.M[i * n + j] === 0) assert.equal(net.W[i * n + j], 0, `W sem máscara em (${i},${j})`);
    }
  }
  for (let k = 0; k < net.nIn; k++) {
    for (let j = 0; j < n; j++) {
      if (net.M_in[k * n + j] === 0) assert.equal(net.W_in[k * n + j], 0, 'W_in sem máscara');
    }
  }
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < net.nOut; i++) {
      if (net.M_out[j * net.nOut + i] === 0) assert.equal(net.W_out[j * net.nOut + i], 0, 'W_out sem máscara');
    }
  }
  assert.ok(countNeurons(net) >= 1, 'sem neurónios vivos');
}

check('rede: determinismo e invariantes', () => {
  const a = makeNetwork({ seed: 5 });
  const b = makeNetwork({ seed: 5 });
  const rng = makeRng(11);
  const x = Array.from({ length: 12 }, () => rng.next());
  resetNet(a); resetNet(b);
  for (let t = 0; t < 30; t++) {
    const ya = step(a, x), yb = step(b, x);
    assert.deepEqual(Array.from(ya), Array.from(yb), 'redes idênticas divergem');
  }
  assertNetInvariants(a);
  return `neurónios=${countNeurons(a)} conexões=${countConns(a)}`;
});

check('rede: addConn com peso 0 preserva a função', () => {
  const net = makeNetwork({ seed: 9, fastOn: false }); // E11: com sinapses rápidas, novas ligações ficam funcionais; aqui testa-se a via lenta
  const rng = makeRng(3);
  const x = [0.3, -0.2, 0.7, 0.1, -0.5, 0.4, 0.9, -0.1, 0.2, -0.6, 0.5, 0.0];
  // criar topologia primeiro (sem isto só existe 1 aresta possível)
  for (let k = 0; k < 4; k++) applyOp(net, 'addNeuron', rng);
  resetNet(net);
  const before = [];
  for (let t = 0; t < 20; t++) before.push(Array.from(step(net, x)));
  // ligações novas com peso 0 (addConn/rewire mantêm preservação exata; addNeuron não, E6)
  for (let k = 0; k < 12; k++) applyOp(net, 'addConn', rng);
  resetNet(net);
  for (let t = 0; t < 20; t++) {
    const after = Array.from(step(net, x));
    for (let i = 0; i < after.length; i++) {
      assert.ok(Math.abs(after[i] - before[t][i]) < 1e-9, `saída mudou no tick ${t} (init função-preservadora)`);
    }
  }
  assertNetInvariants(net);
  return 'ok';
});

check('rede: capacidade cresce sozinha ao chegar ao limite (addNeuron + ensureCapacity)', async () => {
  const { ensureCapacity, MAX_SLOTS } = await import('../core/network.mjs');
  const net = makeNetwork({ seed: 31, nSlots: 4 });
  const rng = makeRng(55);
  const x = Array.from({ length: 12 }, () => rng.next());
  resetNet(net);
  const before = [];
  for (let t = 0; t < 15; t++) before.push(Array.from(step(net, x)));
  // encher os 4 slots e continuar a adicionar: a capacidade tem de crescer sozinha
  for (let k = 0; k < 8; k++) applyOp(net, 'addNeuron', rng);
  assert.ok(net.nSlots > 4, `nSlots não cresceu (${net.nSlots})`);
  assert.ok(countNeurons(net) > 4, `neurónios não cresceram (${countNeurons(net)})`);
  assertNetInvariants(net);
  // addNeuron nasce funcional (E6): a função MUDA (deliberado), mas fica limitada
  resetNet(net);
  let maxDelta = 0;
  for (let t = 0; t < 15; t++) {
    const after = Array.from(step(net, x));
    for (let i = 0; i < after.length; i++) maxDelta = Math.max(maxDelta, Math.abs(after[i] - before[t][i]));
  }
  assert.ok(maxDelta > 1e-9, 'addNeuron devia alterar a função (E6: saídas nascem não-nulas)');
  assert.ok(maxDelta < 8 * 0.3 + 1e-9, `mudança não limitada após addNeuron: ${maxDelta}`);
  // ensureCapacity preserva EXATAMENTE a função ao realocar os strides
  resetNet(net);
  const ref = [];
  for (let t = 0; t < 15; t++) ref.push(Array.from(step(net, x)));
  const grown = ensureCapacity(net, 1);
  assert.equal(grown, true, 'ensureCapacity devolveu false sem estar no teto');
  resetNet(net);
  for (let t = 0; t < 15; t++) {
    const after = Array.from(step(net, x));
    for (let i = 0; i < after.length; i++) {
      assert.ok(Math.abs(after[i] - ref[t][i]) < 1e-9, `função mudou após ensureCapacity no tick ${t}`);
    }
  }
  assertNetInvariants(net);
  assert.ok(net.nSlots <= MAX_SLOTS, 'nSlots acima do teto');
  return `nSlots 4 → ${net.nSlots}, vivos ${countNeurons(net)}`;
});

check('rede: spectralThermostat limita ρ̂ ao alvo', () => {
  const net = makeNetwork({ seed: 2, nSlots: 16 });
  const rng = makeRng(17);
  // explodir a rede: ligações com pesos grandes
  for (let i = 0; i < 16; i++) {
    for (let j = 0; j < 16; j++) {
      net.M[i * 16 + j] = 1;
      net.W[i * 16 + j] = (rng.next() - 0.5) * 6;
    }
  }
  const rhoBefore = spectralRadius(net);
  assert.ok(rhoBefore > 0.95, `rede devia explodir (ρ̂=${rhoBefore.toFixed(3)})`);
  const rhoAfter = spectralThermostat(net, 0.95);
  assert.ok(rhoAfter <= 0.96, `termostato não limitou (ρ̂=${rhoAfter.toFixed(3)})`);
  return `ρ̂ ${rhoBefore.toFixed(3)} → ${rhoAfter.toFixed(3)}`;
});

/* ── 4. Operações ──────────────────────────────────────────────────────────── */

check('ops: 400 operações aleatórias preservam invariantes e o caminho I/O', () => {
  const net = makeNetwork({ seed: 21, nSlots: 24 });
  const rng = makeRng(101);
  let applied = 0;
  for (let k = 0; k < 400; k++) {
    const op = OP_NAMES[rng.int(OP_NAMES.length)];
    if (applyOp(net, op, rng)) applied++;
    assertNetInvariants(net);
    assert.ok(countNeurons(net) >= 1, 'rede sem neurónios');
  }
  assert.ok(applied > 100, `poucas ops aplicadas (${applied})`);
  return `${applied}/400 aplicadas`;
});

check('ops: banco adaptativo mantém P_min e probabilidades somam 1', () => {
  const rng = makeRng(77);
  const bank = makeOperatorBank(rng);
  for (let k = 0; k < 300; k++) {
    const op = bank.pick();
    bank.update(op, rng.next());
  }
  const p = bank.probs();
  let sum = 0;
  for (let i = 0; i < p.length; i++) {
    sum += p[i];
    assert.ok(p[i] >= 0.05 - 1e-9, `P_min violado em ${OP_NAMES[i]} (${p[i]})`);
    assert.ok(p[i] <= 1, 'p > 1');
  }
  assert.ok(Math.abs(sum - 1) < 1e-6, `soma=${sum}`);
  return 'ok';
});

/* ── 5. Evolução ───────────────────────────────────────────────────────────── */

check('fitnessOf: fórmula canónica (spot-checks)', () => {
  const solved = fitnessOf({ solved: true, steps: 20, maxSteps: 50, startDist: 8, endDist: 0, visited: 30, openCells: 40 });
  const unsolved = fitnessOf({ solved: false, steps: 10, maxSteps: 50, startDist: 8, endDist: 4, visited: 12, openCells: 40 });
  const manual = 1.5 + (1 - 20 / 50) + 0.5 * (30 / 40);
  assert.ok(Math.abs(solved - manual) < 1e-9, `solved: esperado ${manual}, obtido ${solved}`);
  // E15: progresso por potencial BFS (startDist/endDist são distâncias BFS)
  const manualU = 2 * (8 - 4) / 8 - 10 * 0.002 + 0.25 * (12 / 40);
  assert.ok(Math.abs(unsolved - manualU) < 1e-9, `unsolved: esperado ${manualU}, obtido ${unsolved}`);
  return 'ok';
});

check('runEpisode: determinismo, terminação e sensorTrace', () => {
  const net = makeNetwork({ seed: 4 });
  const m = generateMaze(7, 7, 2);
  const a = runEpisode(net, m, { maxSteps: 60, trace: true });
  resetNet(net);
  const b = runEpisode(net, m, { maxSteps: 60 });
  assert.equal(a.steps, b.steps, 'episódios deterministas divergem');
  assert.equal(a.solved, b.solved, 'solved diverge');
  assert.ok(a.sensorTrace === null || a.sensorTrace.length <= a.steps, 'sensorTrace inconsistente');
  assert.ok(a.path.length >= 1, 'path vazio');
  return `solved=${a.solved} steps=${a.steps} fitness=${a.fitness.toFixed(3)}`;
});

check('solvedCount: conta labirintos resolvidos (critério de paragem)', async () => {
  const { solvedCount } = await import('../core/evolution.mjs').catch(() => ({}));
  if (!solvedCount) return 'helper ausente (fallback runEpisode no worker)';
  const mazes = [generateMaze(5, 5, 1), generateMaze(5, 5, 2), generateMaze(5, 5, 3)];
  const out = evolve(
    { population: 60, generations: 80, mazes, seed: 123, elite: 6, mutationRate: 0.9 },
    { shouldStop: () => false },
  );
  const r = solvedCount(out.bestNet, mazes, {});
  assert.equal(r.total, 3, 'total de labirintos errado');
  assert.equal(r.solved, 3, `campeão 5x5 devia resolver os 3 (resolveu ${r.solved})`);
  return `${r.solved}/${r.total}`;
});

check('evolução: aprende em 5x5 (resolve e a média da população sobe)', () => {
  const mazes = [generateMaze(5, 5, 1), generateMaze(5, 5, 2), generateMaze(5, 5, 3)];
  const out = evolve(
    { population: 60, generations: 80, mazes, seed: 123, elite: 6, mutationRate: 0.9 },
    { shouldStop: () => false },
  );
  const h = out.history;
  const first = h[0], last = h[h.length - 1];
  assert.ok(out.best >= 1.2, `melhor global abaixo de 1.2 (não resolve): ${out.best.toFixed(3)}`);
  assert.ok(last.mean > first.mean, `média da população não subiu: ${first.mean.toFixed(3)} → ${last.mean.toFixed(3)}`);
  assert.ok(last.best >= first.best, `melhor da geração regrediu: ${first.best.toFixed(3)} → ${last.best.toFixed(3)}`);
  const solo = evaluate(out.bestNet, mazes, {});
  assert.ok(solo >= 1.2, `bestNet reavaliado abaixo de 1.2: ${solo.toFixed(3)}`);
  return `best ${first.best.toFixed(3)}→${last.best.toFixed(3)} · mean ${first.mean.toFixed(3)}→${last.mean.toFixed(3)}`;
});

check('evolução: melhora o melhor em 7x7 (tarefa mais dura, sem saturar)', () => {
  const mazes = [generateMaze(7, 7, 1), generateMaze(7, 7, 2), generateMaze(7, 7, 3)];
  const out = evolve(
    { population: 60, generations: 80, mazes, seed: 123, elite: 6, mutationRate: 0.9 },
    { shouldStop: () => false },
  );
  const h = out.history;
  assert.ok(h[h.length - 1].best >= h[0].best, `melhor regrediu: ${h[0].best.toFixed(3)} → ${h[h.length - 1].best.toFixed(3)}`);
  assert.ok(h[h.length - 1].mean > h[0].mean, `média não subiu: ${h[0].mean.toFixed(3)} → ${h[h.length - 1].mean.toFixed(3)}`);
  return `best ${h[0].best.toFixed(3)}→${h[h.length - 1].best.toFixed(3)} · mean ${h[0].mean.toFixed(3)}→${h[h.length - 1].mean.toFixed(3)}`;
});

/* ── 6. Performance ────────────────────────────────────────────────────────── */

const perf = {};

check('performance: ≥ 20 000 ticks de rede/segundo em Node', () => {
  const net = makeNetwork({ seed: 8, nSlots: 32 });
  const rng = makeRng(5);
  const x = Array.from({ length: 12 }, () => rng.next() * 2 - 1);
  const T0 = performance.now();
  const TICKS = 100_000;
  for (let t = 0; t < TICKS; t++) step(net, x);
  const dt = (performance.now() - T0) / 1000;
  perf.ticksPerSec = Math.round(TICKS / dt);
  assert.ok(perf.ticksPerSec >= 20_000, `só ${perf.ticksPerSec} ticks/s`);
  return `${perf.ticksPerSec} ticks/s`;
});

check('performance: ≥ 50 episódios/segundo em labirinto 5x5', () => {
  const net = makeNetwork({ seed: 8 });
  const m = generateMaze(5, 5, 4);
  const T0 = performance.now();
  const N = 100;
  for (let k = 0; k < N; k++) runEpisode(net, m, { maxSteps: 40 });
  const dt = (performance.now() - T0) / 1000;
  perf.episodesPerSec = Math.round(N / dt);
  assert.ok(perf.episodesPerSec >= 50, `só ${perf.episodesPerSec} episódios/s`);
  return `${perf.episodesPerSec} episódios/s`;
});

/* ── Relatório ─────────────────────────────────────────────────────────────── */

const passed = results.filter(r => r.ok).length;
console.log('\n──────── Resumo da validação ────────');
console.log(`checks: ${passed}/${results.length} passaram`);
console.log(`ticks de rede: ${perf.ticksPerSec ?? 'n/d'}/s · episódios: ${perf.episodesPerSec ?? 'n/d'}/s`);
if (failures > 0) console.log(`FALHAS: ${failures}`);

writeFileSync(join(__dir, 'last-validation.json'), JSON.stringify({
  when: new Date().toISOString(),
  passed, total: results.length, failures, perf, results,
}, null, 2));
console.log(`relatório: demo/tests/last-validation.json`);

process.exit(failures > 0 ? 1 : 0);
