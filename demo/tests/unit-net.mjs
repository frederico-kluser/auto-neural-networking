// Testes unitários de network/ops/evolution — correr com: node demo/tests/unit-net.mjs
// Cobre o contrato [B] de CONTRACTS.md. Sai com exit != 0 se algum check falhar.

import assert from 'node:assert/strict';
import {
  makeNetwork, resetNet, step, cloneNet, countNeurons, countConns,
  spectralRadius, spectralThermostat, ensureCapacity, MAX_SLOTS,
} from '../core/network.mjs';
import { OP_NAMES, applyOp, makeOperatorBank } from '../core/ops.mjs';
import { STEP_TICKS, fitnessOf, runEpisode, evaluate, evolve, solvedCount } from '../core/evolution.mjs';
import { generateMaze } from '../core/maze.mjs';
import { sense } from '../core/sensors.mjs';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n        ') : e}`);
  }
}

// rng local no formato do contrato core/rng.mjs (next/int/range/pick/seed).
function makeRng(seed = 1) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    seed,
    next,
    int: (n) => Math.floor(next() * n),
    range: (lo, hi) => lo + next() * (hi - lo),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
  };
}

function checkInvariants(net, tag = '') {
  for (let k = 0; k < net.M.length; k++) {
    if (!net.M[k] && net.W[k] !== 0) throw new Error(`invariante W/M violada em ${k} ${tag}`);
    if (net.F && !net.M[k] && net.F[k] !== 0) throw new Error(`invariante F/M violada em ${k} ${tag}`); // E11
  }
  for (let k = 0; k < net.M_in.length; k++) {
    if (!net.M_in[k] && net.W_in[k] !== 0) throw new Error(`invariante W_in/M_in violada em ${k} ${tag}`);
  }
  for (let k = 0; k < net.M_out.length; k++) {
    if (!net.M_out[k] && net.W_out[k] !== 0) throw new Error(`invariante W_out/M_out violada em ${k} ${tag}`);
  }
  if (!net.alive[0]) throw new Error(`slot 0 morto ${tag}`);
  // caminho input→output por BFS sobre os vivos (o do slot 0 tem de existir)
  const n = net.nSlots;
  const fromInput = new Set();
  for (let j = 0; j < n; j++) {
    for (let k = 0; k < net.nIn; k++) if (net.alive[j] && net.M_in[k * n + j]) fromInput.add(j);
  }
  const seen = new Set(fromInput);
  const stack = [...fromInput];
  while (stack.length) {
    const i = stack.pop();
    for (let j = 0; j < n; j++) {
      if (net.alive[j] && net.M[i * n + j] && !seen.has(j)) { seen.add(j); stack.push(j); }
    }
  }
  let path = false;
  for (let j = 0; j < n; j++) {
    if (!seen.has(j)) continue;
    for (let i = 0; i < net.nOut; i++) if (net.M_out[j * net.nOut + i]) path = true;
  }
  if (!path) throw new Error(`sem caminho input→output ${tag}`);
}

function snapshot(net) {
  return {
    nIn: net.nIn, nOut: net.nOut, nSlots: net.nSlots, alpha: net.alpha,
    alive: Array.from(net.alive), W: Array.from(net.W), M: Array.from(net.M),
    F: Array.from(net.F), alphaJ: Array.from(net.alphaJ), // E11/E12
    fastLambda: net.fastLambda, fastEta: net.fastEta, fastOn: net.fastOn, // E11
    b: Array.from(net.b), h: Array.from(net.h),
    W_in: Array.from(net.W_in), M_in: Array.from(net.M_in),
    W_out: Array.from(net.W_out), M_out: Array.from(net.M_out), b_out: Array.from(net.b_out),
  };
}

function fixedInputs(nIn, count, seed = 99) {
  const rng = makeRng(seed);
  const seq = [];
  for (let t = 0; t < count; t++) {
    const v = new Float32Array(nIn);
    for (let k = 0; k < nIn; k++) v[k] = rng.range(-1, 1);
    seq.push(v);
  }
  return seq;
}

function outputTrace(net, seq) {
  resetNet(net);
  const out = [];
  for (const x of seq) out.push(Array.from(step(net, x)));
  return out;
}

// ---------------------------------------------------------------------------
// network.mjs
// ---------------------------------------------------------------------------
console.log('\n== network.mjs ==');

check('makeNetwork: arranque minimalista (só slot 0 vivo, wiring completo)', () => {
  const net = makeNetwork({ nInputs: 8, nOutputs: 4, seed: 3, nSlots: 8 });
  assert.equal(net.nIn, 8);
  assert.equal(net.nOut, 4);
  assert.equal(net.nSlots, 8);
  assert.equal(net.alpha, 0.25);
  assert.equal(countNeurons(net), 1);
  assert.equal(net.alive[0], 1);
  for (let j = 1; j < 8; j++) assert.equal(net.alive[j], 0);
  for (let k = 0; k < 8; k++) {
    assert.equal(net.M_in[k * 8], 1);
    assert.ok(Math.abs(net.W_in[k * 8]) < 0.5);
  }
  for (let i = 0; i < 4; i++) {
    assert.equal(net.M_out[i], 1);
    assert.ok(Math.abs(net.W_out[i]) < 0.5);
  }
  assert.equal(countConns(net), 0);
  assert.equal(net.h.every((v) => v === 0), true);
  checkInvariants(net);
});

check('makeNetwork: defeitos E1/E2 (nIn 12, nOut 4, nSlots 32)', () => {
  const net = makeNetwork({ seed: 3 });
  assert.equal(net.nIn, 12);
  assert.equal(net.nOut, 4);
  assert.equal(net.nSlots, 32);
  assert.equal(countNeurons(net), 1);
  assert.equal(net.alive.length, 32);
  assert.equal(net.W.length, 32 * 32);
  assert.equal(net.M.length, 32 * 32);
  assert.equal(net.W_in.length, 12 * 32);
  assert.equal(net.W_out.length, 32 * 4);
  for (let k = 0; k < 12; k++) {
    assert.equal(net.M_in[k * 32], 1);
    assert.ok(Math.abs(net.W_in[k * 32]) < 0.5);
  }
  for (let i = 0; i < 4; i++) {
    assert.equal(net.M_out[i], 1);
    assert.ok(Math.abs(net.W_out[i]) < 0.5);
  }
  checkInvariants(net);
});

check('step: aceita entradas de comprimento 12 e mantém saídas finitas', () => {
  const net = makeNetwork({ seed: 21, nSlots: 8 });
  resetNet(net);
  for (const x of fixedInputs(12, 25, 41)) {
    const y = step(net, x);
    assert.equal(y.length, 4);
    for (const v of y) assert.ok(Number.isFinite(v), 'saída não finita');
  }
  assert.ok(net.h.some((v) => v !== 0), 'rede não evoluiu estado');
  checkInvariants(net);
});

check('step: determinismo (mesma seed ⇒ saídas e h idênticos)', () => {
  const seq = fixedInputs(12, 25, 11);
  const a = makeNetwork({ seed: 42, nSlots: 6 });
  const b = makeNetwork({ seed: 42, nSlots: 6 });
  resetNet(a); resetNet(b);
  for (const x of seq) {
    const ya = step(a, x);
    const yb = step(b, x);
    assert.deepEqual(Array.from(ya), Array.from(yb));
    assert.deepEqual(Array.from(a.h), Array.from(b.h));
  }
  const d1 = outputTrace(makeNetwork({ seed: 42, nSlots: 6 }), seq);
  const d2 = outputTrace(makeNetwork({ seed: 43, nSlots: 6 }), seq);
  assert.notDeepEqual(d1, d2, 'redes com seeds diferentes devem diferir');
});

check('resetNet: zera h', () => {
  const net = makeNetwork({ seed: 7 });
  for (const x of fixedInputs(12, 3, 1)) step(net, x);
  assert.ok(net.h.some((v) => v !== 0));
  resetNet(net);
  assert.ok(net.h.every((v) => v === 0));
});

check('invariantes M/W consistentes no arranque e após ticks', () => {
  const net = makeNetwork({ seed: 5, nSlots: 10 });
  checkInvariants(net);
  for (const x of fixedInputs(12, 10, 2)) step(net, x);
  checkInvariants(net);
});

check('spectralRadius: degenerado = 0; autoconexão w dá w', () => {
  const net = makeNetwork({ seed: 1, nSlots: 4 });
  assert.equal(spectralRadius(net), 0); // sem ligações recorrentes
  net.M[0] = 1; net.W[0] = 2.0; // autoconexão 0→0 com peso 2
  assert.ok(Math.abs(spectralRadius(net) - 2.0) < 1e-9);
});

check('spectralThermostat: traz ρ̂ ≤ 0.95 numa rede explosiva', () => {
  const net = makeNetwork({ seed: 2, nSlots: 4 });
  // rede deliberadamente explosiva: autoconexões e ciclo 0→1→0 com pesos grandes
  net.M[0] = 1; net.W[0] = 1.5;
  net.M[1 * 4 + 1] = 1; net.W[1 * 4 + 1] = 1.5;
  net.M[0 * 4 + 1] = 1; net.W[0 * 4 + 1] = 1.2;
  net.M[1 * 4 + 0] = 1; net.W[1 * 4 + 0] = 1.2;
  net.alive[1] = 1;
  const before = spectralRadius(net);
  assert.ok(before > 0.95, `ρ̂ inicial devia ser explosivo (=${before})`);
  const final = spectralThermostat(net, 0.95);
  assert.ok(final <= 0.95 + 1e-9, `ρ̂ final ${final} > 0.95`);
  assert.ok(spectralRadius(net) <= 0.95 + 1e-9);
  assert.ok(Math.abs(final - spectralRadius(net)) < 1e-12);
  checkInvariants(net);
  // sem efeito quando já está sob o alvo
  const calm = makeNetwork({ seed: 4, nSlots: 4 });
  calm.M[0] = 1; calm.W[0] = 0.1;
  const r = spectralThermostat(calm, 0.95);
  assert.ok(Math.abs(r - 0.1) < 1e-9);
  assert.ok(Math.abs(calm.W[0] - 0.1) < 1e-12, 'não deve tocar em W quando ρ̂ ≤ alvo');
});

// ---------------------------------------------------------------------------
// ops.mjs
// ---------------------------------------------------------------------------
console.log('\n== ops.mjs ==');

check('OP_NAMES: as 9 operações exatas (E12 acrescenta addMemoryNeuron no fim)', () => {
  assert.deepEqual(OP_NAMES, ['addNeuron', 'addConn', 'removeConn', 'rewire', 'pruneNeuron', 'changeLeak', 'splitNeuron', 'perturbWeights', 'addMemoryNeuron']);
});

// E6 (ver EMENDA v3): a preservação EXATA por addConn/rewire vale para o caminho lento.
// Com as sinapses rápidas (E11) ligadas, uma ligação mascarada nova é imediatamente
// funcional através de F — é exatamente isso que a memória estrutural pede (ver check E11).
check('addConn com peso 0 não altera saídas (inicialização preservadora, caminho lento)', () => {
  const seq = fixedInputs(12, 30, 21);
  const net = makeNetwork({ seed: 9, nSlots: 10, fastOn: false });
  const rng = makeRng(31);
  // criar topologia primeiro (sem isto só existe 1 aresta possível: a autoconexão)
  for (let t = 0; t < 4; t++) assert.ok(applyOp(net, 'addNeuron', rng), 'addNeuron devia aplicar-se');
  const before = outputTrace(net, seq);
  let applied = 0;
  for (let t = 0; t < 8; t++) {
    if (applyOp(net, 'addConn', rng)) applied++;
  }
  assert.ok(applied >= 3, `addConn devia aplicar-se várias vezes (=${applied})`);
  const after = outputTrace(net, seq);
  assert.deepEqual(after, before);
  checkInvariants(net);
});

check('addNeuron nasce funcional (E6): altera a função de forma limitada', () => {
  const seq = fixedInputs(12, 30, 22);
  const net = makeNetwork({ seed: 10, nSlots: 12 });
  const before = outputTrace(net, seq);
  const rng = makeRng(32);
  for (let t = 0; t < 6; t++) assert.ok(applyOp(net, 'addNeuron', rng));
  assert.equal(countNeurons(net), 7);
  const after = outputTrace(net, seq);
  let maxDelta = 0;
  for (let t = 0; t < after.length; t++) {
    for (let i = 0; i < after[t].length; i++) maxDelta = Math.max(maxDelta, Math.abs(after[t][i] - before[t][i]));
  }
  assert.ok(maxDelta > 1e-9, 'addNeuron devia alterar a função (saídas nascem não-nulas, E6)');
  assert.ok(maxDelta < 6 * 0.3 + 1e-9, `mudança não limitada: ${maxDelta}`);
  checkInvariants(net);
});

check('splitNeuron preserva a função e mantém as invariantes', () => {
  const seq = fixedInputs(12, 30, 23);
  const net = makeNetwork({ seed: 11, nSlots: 12 });
  const rng = makeRng(33);
  for (let t = 0; t < 3; t++) assert.ok(applyOp(net, 'addNeuron', rng));
  const beforeSplit = outputTrace(net, seq);
  assert.ok(applyOp(net, 'splitNeuron', rng), 'splitNeuron devia aplicar-se');
  const after = outputTrace(net, seq);
  assert.deepEqual(after, beforeSplit, 'splitNeuron tem de preservar a função');
  checkInvariants(net);
});

check('changeLeak: alpha *= 0.8/1.25 clipado a [0.02, 1]', () => {
  const net = makeNetwork({ seed: 12, nSlots: 4 });
  const rng = makeRng(34);
  for (let t = 0; t < 400; t++) {
    applyOp(net, 'changeLeak', rng);
    assert.ok(net.alpha >= 0.02 && net.alpha <= 1);
  }
  assert.ok(net.alpha !== 0.25, 'deve ter mudado ao fim de 400 tentativas');
});

check('pruneNeuron: nunca mata o slot 0 e limpa as máscaras', () => {
  const net = makeNetwork({ seed: 13, nSlots: 8 });
  const rng = makeRng(35);
  for (let t = 0; t < 4; t++) applyOp(net, 'addNeuron', rng);
  for (let t = 0; t < 10; t++) {
    applyOp(net, 'pruneNeuron', rng);
    assert.equal(net.alive[0], 1);
    checkInvariants(net);
  }
  assert.ok(countNeurons(net) >= 1);
});

check('perturbWeights: altera a função mas preserva invariantes', () => {
  const seq = fixedInputs(12, 30, 26);
  const net = makeNetwork({ seed: 20, nSlots: 10 });
  const rng = makeRng(39);
  applyOp(net, 'addNeuron', rng);
  applyOp(net, 'addConn', rng); // ligação nascida a 0
  const before = outputTrace(net, seq);
  let changed = false;
  for (let t = 0; t < 20 && !changed; t++) {
    assert.ok(applyOp(net, 'perturbWeights', rng));
    checkInvariants(net, `(perturbWeights #${t})`);
    changed = JSON.stringify(outputTrace(net, seq)) !== JSON.stringify(before);
  }
  assert.ok(changed, 'perturbWeights tem de alterar a função (é a única op que mexe em pesos)');
});

check('200 ops aleatórias preservam invariantes e o caminho input→output', () => {
  const net = makeNetwork({ seed: 14, nSlots: 12 });
  const rng = makeRng(36);
  for (let t = 0; t < 5; t++) applyOp(net, 'addNeuron', rng);
  let applied = 0;
  for (let t = 0; t < 200; t++) {
    const op = OP_NAMES[rng.int(OP_NAMES.length)];
    if (applyOp(net, op, rng)) applied++;
    assert.equal(net.alive[0], 1, `slot 0 morreu após ${op} #${t}`);
    assert.ok(countNeurons(net) >= 1);
    checkInvariants(net, `(${op} #${t})`);
  }
  assert.ok(applied >= 20, `poucas ops aplicadas (${applied})`);
});

check('cloneNet: cópia profunda independente', () => {
  const net = makeNetwork({ seed: 15, nSlots: 10 });
  const rng = makeRng(37);
  for (let t = 0; t < 3; t++) applyOp(net, 'addNeuron', rng);
  for (const x of fixedInputs(12, 5, 24)) step(net, x); // h != 0
  const clone = cloneNet(net);
  const snap = snapshot(clone);
  // mutar o original de todas as formas
  net.alpha = 0.9;
  net.W[0] = 123;
  net.h[0] = 7;
  net.alive[3] = 1;
  net.M_in[1] = 0;
  net.b_out[0] = 5;
  step(net, fixedInputs(12, 1, 25)[0]);
  applyOp(net, 'addNeuron', rng);
  assert.deepEqual(snapshot(clone), snap);
  checkInvariants(clone);
});

check('makeOperatorBank: probs somam 1, p ≥ P_min e recompensas movem a perseguição', () => {
  const bank = makeOperatorBank(makeRng(38));
  assert.equal(bank.probs().length, OP_NAMES.length);
  assert.ok(bank.probs() instanceof Float32Array);
  for (let t = 0; t < 400; t++) {
    const op = bank.pick();
    bank.update(op, op === 'addNeuron' ? 1 : 0); // só addNeuron é recompensada
    const p = bank.probs();
    let sum = 0;
    for (let i = 0; i < p.length; i++) {
      sum += p[i];
      assert.ok(p[i] >= 0.05 - 1e-7, `p[${OP_NAMES[i]}]=${p[i]} abaixo de P_min`);
    }
    assert.ok(Math.abs(sum - 1) < 1e-5, `soma de probs = ${sum}`);
  }
  const s = bank.stats();
  for (const name of OP_NAMES) {
    assert.ok(Number.isFinite(s[name].p) && Number.isFinite(s[name].q));
    assert.ok(s[name].count >= 0);
    assert.equal(s[name].p >= 0.05, true);
  }
  assert.equal(s.addNeuron.p, Math.max(...OP_NAMES.map((n) => s[n].p)), 'op recompensada deve dominar');
  assert.ok(s.addNeuron.p > 1 / OP_NAMES.length, 'perseguição deve concentrar probabilidade');
  assert.ok(s.addNeuron.count > 0);
});

check('applyOp: operação desconhecida/nome inválido devolve false', () => {
  const net = makeNetwork({ seed: 16, nSlots: 4 });
  assert.equal(applyOp(net, 'nope', makeRng(1)), false);
});

// ---------------------------------------------------------------------------
// E1: capacidade auto-crescente (ensureCapacity + addNeuron)
// ---------------------------------------------------------------------------
console.log('\n== E1: capacidade (ensureCapacity) ==');

check('ensureCapacity: preserva a função bitwise, h e invariantes ao crescer', () => {
  const seq = fixedInputs(12, 30, 42);
  const net = makeNetwork({ seed: 22, nSlots: 8 });
  const rng = makeRng(43);
  for (let t = 0; t < 3; t++) assert.ok(applyOp(net, 'addNeuron', rng));
  assert.ok(applyOp(net, 'addConn', rng));
  assert.ok(applyOp(net, 'perturbWeights', rng));
  const before = outputTrace(net, seq);
  step(net, seq[0]); // estado h não nulo para verificar a migração de h
  const hBefore = Array.from(net.h);
  const oldSlots = net.nSlots;
  assert.equal(ensureCapacity(net, net.nSlots), true); // sem livres ⇒ força crescimento
  assert.ok(net.nSlots > oldSlots, 'nSlots não cresceu');
  assert.equal(net.nSlots, Math.min(MAX_SLOTS, Math.max(oldSlots * 2, oldSlots + 16)));
  assert.equal(net.alive.length, net.nSlots);
  assert.equal(net.W.length, net.nSlots * net.nSlots);
  assert.equal(net.M.length, net.nSlots * net.nSlots);
  assert.equal(net.h.length, net.nSlots);
  assert.equal(net.b.length, net.nSlots);
  assert.equal(net.W_in.length, net.nIn * net.nSlots);
  assert.equal(net.M_in.length, net.nIn * net.nSlots);
  assert.equal(net.W_out.length, net.nSlots * net.nOut);
  assert.equal(net.M_out.length, net.nSlots * net.nOut);
  assert.deepEqual(Array.from(net.h.subarray(0, oldSlots)), hBefore, 'h não migrou');
  const after = outputTrace(net, seq);
  assert.deepEqual(after, before, 'migração de stride alterou a função');
  checkInvariants(net);
  const n0 = net.nSlots;
  assert.equal(ensureCapacity(net, 1), true, 'com espaço livre devolve true');
  assert.equal(net.nSlots, n0, 'com espaço livre não cresce');
});

check('addNeuron + ensureCapacity: cresce sozinho até MAX_SLOTS e falha limpo no teto', () => {
  const net = makeNetwork({ seed: 23, nSlots: 8 });
  const rng = makeRng(44);
  let ok = 0;
  let refused = false;
  for (let t = 0; t < 300 && !refused; t++) {
    if (applyOp(net, 'addNeuron', rng)) ok++;
    else refused = true;
    checkInvariants(net, `(addNeuron #${t})`);
  }
  assert.ok(refused, 'addNeuron devia recusar-se no teto');
  assert.equal(net.nSlots, MAX_SLOTS);
  assert.equal(countNeurons(net), MAX_SLOTS);
  assert.equal(ok, MAX_SLOTS - 1); // slot 0 já vivo; cada addNeuron acrescenta exatamente 1
  assert.equal(ensureCapacity(net, 1), false, 'no teto sem livres devolve false');
  assert.equal(ensureCapacity(net, 0), true, 'need 0 nunca falha');
  assert.equal(applyOp(net, 'addNeuron', rng), false, 'continua a falhar no teto');
  assert.equal(net.nSlots, MAX_SLOTS);
  checkInvariants(net);
});

check('determinismo após crescimento: mesma seed + mesmas ops ⇒ mesmo resultado', () => {
  const seq = fixedInputs(12, 20, 45);
  const build = () => {
    const net = makeNetwork({ seed: 24, nSlots: 8 });
    const rng = makeRng(46);
    for (let t = 0; t < 12; t++) assert.ok(applyOp(net, 'addNeuron', rng));
    return net;
  };
  const a = build();
  const b = build();
  assert.ok(a.nSlots > 8, 'a sequência devia forçar crescimento');
  assert.equal(a.nSlots, b.nSlots);
  assert.deepEqual(snapshot(a), snapshot(b));
  assert.deepEqual(outputTrace(a, seq), outputTrace(b, seq));
  checkInvariants(a);
  checkInvariants(b);
});

// ---------------------------------------------------------------------------
// evolution.mjs
// ---------------------------------------------------------------------------
console.log('\n== evolution.mjs ==');

check('STEP_TICKS === 3', () => {
  assert.equal(STEP_TICKS, 3);
});

check('fitnessOf: spot-checks da fórmula canónica', () => {
  const solved = fitnessOf({ solved: true, steps: 10, maxSteps: 50, startDist: 4, endDist: 0, visited: 5, openCells: 7 });
  assert.ok(Math.abs(solved - (1.5 + (1 - 10 / 50) + 0.5 * (5 / 7))) < 1e-12);
  const unsolved = fitnessOf({ solved: false, steps: 10, maxSteps: 50, startDist: 4, endDist: 1, visited: 5, openCells: 7 });
  assert.ok(Math.abs(unsolved - ((1 - 1 / 4) * 1.0 - 10 * 0.002 + 0.25 * (5 / 7))) < 1e-12);
  const stuck = fitnessOf({ solved: false, steps: 0, maxSteps: 100, startDist: 4, endDist: 4, visited: 1, openCells: 7 });
  assert.ok(Math.abs(stuck - ((1 - 4 / 4) * 1.0 - 0 * 0.002 + 0.25 * (1 / 7))) < 1e-12);
});

const maze5 = generateMaze(5, 5, 3);

check('runEpisode: determinismo, terminação e traços', () => {
  const net = makeNetwork({ seed: 17, nSlots: 8 });
  const a = runEpisode(net, maze5);
  const b = runEpisode(cloneNet(net), maze5);
  assert.equal(a.solved, b.solved);
  assert.equal(a.steps, b.steps);
  assert.equal(a.fitness, b.fitness);
  assert.deepEqual(a.path, b.path);
  assert.ok(a.steps <= 5 * 5 * 2);
  assert.equal(a.path.length, a.steps + 1);
  const c = runEpisode(net, maze5, { maxSteps: 3 });
  assert.ok(c.steps <= 3);
  const d = runEpisode(net, maze5, { trace: true, maxSteps: 4 });
  assert.equal(d.sensorTrace.length, d.steps);
  assert.ok(d.sensorTrace[0] instanceof Float32Array && d.sensorTrace[0].length === 12, 'E13: defeito memoryMode=sinapses ⇒ traços de 12');
  const netMap = makeNetwork({ seed: 17, nSlots: 8, nInputs: 12 + maze5.cols * maze5.rows });
  const dMap = runEpisode(netMap, maze5, { trace: true, maxSteps: 4, memoryMode: 'ambos' });
  assert.equal(dMap.sensorTrace[0].length, 12 + maze5.cols * maze5.rows, 'E13: memoryMode=ambos ⇒ traços 12+células');
  const e = runEpisode(net, maze5);
  assert.equal(e.sensorTrace, null);
  // penalidade de revisita: um passeio que fique no sítio acumula penalidades negativas
  assert.ok(Number.isFinite(a.fitness));
});

check('sense() alimenta a rede sem efeitos colaterais no contrato', () => {
  const net = makeNetwork({ seed: 18, nSlots: 8 });
  const s = sense(maze5, maze5.start.x, maze5.start.y);
  assert.equal(s.length, 12, 'E13: defeito sem mapa ⇒ 12');
  const y = step(net, s);
  assert.equal(y.length, 4);
});

check('evaluate: média de fitness sobre os mazes', () => {
  const net = makeNetwork({ seed: 19, nSlots: 8 });
  const m2 = generateMaze(5, 5, 4);
  const f1 = runEpisode(net, maze5).fitness;
  const f2 = runEpisode(net, m2).fitness;
  const mean = evaluate(net, [maze5, m2]);
  assert.ok(Math.abs(mean - (f1 + f2) / 2) < 1e-12);
});

check('runEpisode E2: passa a memória de visitas a sense (start marcado, frações válidas)', () => {
  const net = makeNetwork({ seed: 26, nSlots: 8 });
  const r = runEpisode(net, maze5, { trace: true, maxSteps: 6 });
  // 1.º frame: a memória tem exatamente o start marcado
  const v0 = new Uint8Array(maze5.cols * maze5.rows);
  v0[maze5.idx(maze5.start.x, maze5.start.y)] = 1;
  assert.deepEqual(
    Array.from(r.sensorTrace[0]),
    Array.from(sense(maze5, maze5.start.x, maze5.start.y, v0)),
    '1.º frame devia ver só o start marcado',
  );
  for (const s of r.sensorTrace) {
    assert.equal(s.length, 12, 'E13: defeito sinapses ⇒ traços de 12');
    for (let i = 8; i < 12; i++) assert.ok(s[i] >= 0 && s[i] <= 1, 'fração fora de [0,1]');
  }
});

check('solvedCount: { solved, total } consistente com runEpisode (apoio E4)', () => {
  const net = makeNetwork({ seed: 25, nSlots: 8 });
  const mazes = [maze5, generateMaze(5, 5, 4), generateMaze(5, 5, 9)];
  const r = solvedCount(net, mazes);
  assert.deepEqual(Object.keys(r).sort(), ['solved', 'total']);
  assert.equal(r.total, 3);
  let manual = 0;
  for (const m of mazes) if (runEpisode(net, m).solved) manual++;
  assert.equal(r.solved, manual);
  assert.ok(r.solved >= 0 && r.solved <= r.total);
});

check('evolve: determinismo e hooks', () => {
  const cfg = { population: 12, generations: 6, mazes: [maze5], seed: 77, elite: 3, mutationRate: 0.9 };
  let gens1 = 0;
  const r1 = evolve(cfg, { onGeneration: () => gens1++ });
  const r2 = evolve(cfg, { onGeneration: () => gens1++ });
  assert.equal(gens1, 12);
  assert.deepEqual(r1.history, r2.history);
  assert.equal(r1.best, r2.best);
  assert.equal(r1.generations, 6);
  assert.deepEqual(r1.bankStats, r2.bankStats);
  assert.deepEqual(Object.keys(r1).sort(), ['bankStats', 'best', 'bestNet', 'generations', 'history', 'neurogenesisBursts']); // E12
  assert.equal(typeof r1.neurogenesisBursts, 'number');
  assert.deepEqual(Object.keys(r1.history[0]).sort(), ['best', 'gen', 'mean', 'nConns', 'nNeurons']);
  // shouldStop aborta
  const r3 = evolve(cfg, { shouldStop: (st) => st.gen >= 2 });
  assert.equal(r3.generations, 2);
  assert.equal(r3.history.length, 2);
});

// Critério de aprendizagem TRANCADO com a integração (tests/validate.mjs):
// (a) 5×5 [gen(5,5,1..3)], evolve({population:60, generations:80, seed:123, elite:6, mutationRate:0.9}):
//     best ≥ 1.2 E mean da última > mean da 1ª E best da última ≥ best da 1ª.
// (b) 7×7 [gen(7,7,1..3)], mesma config: best da última > best da 1ª.
check('evolve 5×5 (config integração): resolve (best ≥ 1.2) e aprende (mean sobe)', () => {
  const mazes = [generateMaze(5, 5, 1), generateMaze(5, 5, 2), generateMaze(5, 5, 3)];
  const res = evolve({ population: 60, generations: 80, mazes, seed: 123, elite: 6, mutationRate: 0.9 });
  const h = res.history;
  const first = h[0];
  const last = h[h.length - 1];
  console.log(`        gen1  best=${first.best.toFixed(4)} mean=${first.mean.toFixed(4)} neurons=${first.nNeurons} conns=${first.nConns}`);
  console.log(`        gen${last.gen} best=${last.best.toFixed(4)} mean=${last.mean.toFixed(4)} neurons=${last.nNeurons} conns=${last.nConns}`);
  console.log(`        global best=${res.best.toFixed(4)} generations=${res.generations}`);
  console.log(`        melhor rede: neurons=${countNeurons(res.bestNet)} conns=${countConns(res.bestNet)} alpha=${res.bestNet.alpha}`);
  assert.equal(res.generations, 80);
  assert.ok(res.best >= 1.2, `best ${res.best} < 1.2 (não resolveu)`);
  assert.ok(last.mean > first.mean, `mean não melhorou: ${first.mean} → ${last.mean}`);
  assert.ok(last.best >= first.best, `best da última (${last.best}) < best da 1ª (${first.best})`);
  assert.ok(res.best >= first.best);
  assert.ok(res.bestNet);
  for (const name of OP_NAMES) assert.ok(res.bankStats[name].p >= 0.05 - 1e-7);
});

check('evolve 7×7 (config integração): best da última > best da 1ª', () => {
  const mazes = [generateMaze(7, 7, 1), generateMaze(7, 7, 2), generateMaze(7, 7, 3)];
  const res = evolve({ population: 60, generations: 80, mazes, seed: 123, elite: 6, mutationRate: 0.9 });
  const first = res.history[0];
  const last = res.history[res.history.length - 1];
  console.log(`        gen1  best=${first.best.toFixed(4)} mean=${first.mean.toFixed(4)}`);
  console.log(`        gen${last.gen} best=${last.best.toFixed(4)} mean=${last.mean.toFixed(4)}`);
  console.log(`        melhor rede: neurons=${countNeurons(res.bestNet)} conns=${countConns(res.bestNet)} alpha=${res.bestNet.alpha}`);
  assert.ok(last.best >= first.best && last.mean > first.mean,
    `7×7 sem aprendizagem: best ${first.best} → ${last.best}, mean ${first.mean} → ${last.mean}`);
  assert.ok(res.best >= last.best);
});

// ---------------------------------------------------------------------------
// E11: sinapses rápidas Hebbianas (fast weights, Ba et al. 2016)
// ---------------------------------------------------------------------------
console.log('\n== E11: sinapses rápidas (fast weights) ==');

check('E11: makeNetwork cria F a zeros + parâmetros rápidos; fastOn defeito true', () => {
  const net = makeNetwork({ seed: 30, nSlots: 6 });
  assert.ok(net.F instanceof Float64Array);
  assert.equal(net.F.length, net.nSlots * net.nSlots);
  assert.ok(net.F.every((v) => v === 0), 'F devia nascer a zero');
  assert.equal(net.fastLambda, 0.92);
  assert.equal(net.fastEta, 0.35);
  assert.equal(net.fastOn, true, 'fastOn por defeito true');
  assert.equal(makeNetwork({}).fastOn, true);
  assert.equal(makeNetwork({ fastOn: true }).fastOn, true);
  assert.equal(makeNetwork({ fastOn: false }).fastOn, false);
});

check('E11: após ticks F é não-zero EXATAMENTE nas entradas mascaradas (M=1)', () => {
  const net = makeNetwork({ seed: 31, nSlots: 6 });
  const rng = makeRng(51);
  for (let t = 0; t < 3; t++) assert.ok(applyOp(net, 'addNeuron', rng));
  assert.ok(applyOp(net, 'addConn', rng));
  const x = new Float32Array(12).fill(0.7); // entradas constantes ⇒ h != 0 nos vivos
  for (let t = 0; t < 5; t++) step(net, x);
  let masked = 0;
  for (let k = 0; k < net.M.length; k++) {
    if (net.M[k]) {
      masked++;
      assert.notEqual(net.F[k], 0, `F[${k}] devia acumular onde M=1`);
    } else {
      assert.equal(net.F[k], 0, `F[${k}] devia ser 0 onde M=0`);
    }
  }
  assert.ok(masked > 0, 'o setup precisa de ligações mascaradas');
  checkInvariants(net);
});

check('E11: o tick usa W+F onde M=1 (traços divergem do mesmo net com fastOn=false)', () => {
  const seq = fixedInputs(12, 20, 52);
  const build = (fastOn) => {
    const net = makeNetwork({ seed: 32, nSlots: 6, fastOn });
    const rng = makeRng(53);
    for (let t = 0; t < 3; t++) applyOp(net, 'addNeuron', rng);
    applyOp(net, 'addConn', rng);
    return net;
  };
  const on = build(true);
  const off = build(false);
  const ton = outputTrace(on, seq);
  const toff = outputTrace(off, seq);
  assert.deepEqual(ton[0], toff[0], '1.º tick idêntico (F ainda a zero)');
  let differ = false;
  for (let t = 1; t < ton.length; t++) {
    if (JSON.stringify(ton[t]) !== JSON.stringify(toff[t])) differ = true;
  }
  assert.ok(differ, 'F devia alterar os ticks seguintes');
});

check('E11: ligação nova com W=0 mas F ativo torna-se funcional (memória estrutural)', () => {
  const seq = fixedInputs(12, 30, 54);
  const net = makeNetwork({ seed: 33, nSlots: 10 });
  const rng = makeRng(55);
  for (let t = 0; t < 4; t++) applyOp(net, 'addNeuron', rng);
  const before = outputTrace(net, seq);
  let applied = 0;
  for (let t = 0; t < 8; t++) if (applyOp(net, 'addConn', rng)) applied++;
  assert.ok(applied >= 3, `addConn devia aplicar-se (=${applied})`);
  const after = outputTrace(net, seq);
  assert.notDeepEqual(after, before, 'com sinapses rápidas a ligação nova altera a trajetória');
  checkInvariants(net);
});

check('E11: resetNet zera F (a memória rápida é do episódio corrente) e h', () => {
  const net = makeNetwork({ seed: 34, nSlots: 6 });
  net.M[0] = 1; net.W[0] = 0.1; // autoconexão mascarada
  const x = new Float32Array(12).fill(0.5);
  for (let t = 0; t < 5; t++) step(net, x);
  assert.notEqual(net.F[0], 0, 'F devia acumular na autoconexão');
  assert.ok(net.h.some((v) => v !== 0));
  resetNet(net);
  assert.ok(net.F.every((v) => v === 0), 'resetNet tem de zerar F');
  assert.ok(net.h.every((v) => v === 0));
});

check('E11/E12: cloneNet copia F, alphaJ e parâmetros rápidos; cópias independentes', () => {
  const net = makeNetwork({ seed: 35, nSlots: 6 });
  net.M[0] = 1; net.W[0] = 0.1;
  net.alphaJ[0] = 0.05;
  const x = new Float32Array(12).fill(0.5);
  for (let t = 0; t < 4; t++) step(net, x);
  const f0 = net.F[0];
  assert.notEqual(f0, 0);
  const clone = cloneNet(net);
  assert.notEqual(clone.F, net.F, 'F tem de ser cópia independente');
  assert.notEqual(clone.alphaJ, net.alphaJ, 'alphaJ tem de ser cópia independente');
  assert.deepEqual(Array.from(clone.F), Array.from(net.F));
  assert.deepEqual(Array.from(clone.alphaJ), Array.from(net.alphaJ));
  assert.equal(clone.fastLambda, 0.92);
  assert.equal(clone.fastEta, 0.35);
  assert.equal(clone.fastOn, true);
  // independência: mutar o original não toca no clone
  net.F[0] = 1.234;
  net.alphaJ[0] = 0.9;
  net.fastEta = 0.01;
  net.fastOn = false;
  step(net, x);
  assert.ok(Object.is(clone.F[0], f0), 'clone.F não pode seguir o original');
  assert.equal(clone.alphaJ[0], 0.05);
  assert.equal(clone.fastEta, 0.35);
  assert.equal(clone.fastOn, true);
  checkInvariants(clone);
});

check('E11: ensureCapacity migra F com o mesmo stride (valores exatos preservados)', () => {
  // (a) F a zeros: migração bitwise-idêntica (função preservada, F continua a zeros)
  const seq = fixedInputs(12, 25, 58);
  const z = makeNetwork({ seed: 37, nSlots: 8 });
  const rng = makeRng(59);
  for (let t = 0; t < 2; t++) assert.ok(applyOp(z, 'addNeuron', rng));
  assert.ok(applyOp(z, 'addConn', rng));
  const before = outputTrace(z, seq);
  resetNet(z); // episódio terminou: F volta a zeros — é a migração COM F=0 que testamos
  assert.ok(z.F.every((v) => v === 0));
  assert.equal(ensureCapacity(z, z.nSlots), true);
  assert.ok(z.F.every((v) => v === 0), 'F a zeros tem de continuar a zeros');
  assert.deepEqual(outputTrace(z, seq), before, 'migração alterou a função (F=0)');
  // (b) F não-zero: valores exatos preservados no novo stride
  const net = makeNetwork({ seed: 38, nSlots: 8 });
  net.alive[1] = 1;
  net.M[0] = 1; net.W[0] = 0.1;
  net.M[1 * 8 + 1] = 1; net.W[1 * 8 + 1] = -0.2;
  net.alphaJ[1] = 0.05;
  net.F[0] = 0.75;
  net.F[1 * 8 + 1] = -1.5;
  const old = net.nSlots;
  assert.equal(ensureCapacity(net, net.nSlots), true);
  const nw = net.nSlots;
  assert.ok(nw > old, 'nSlots não cresceu');
  assert.equal(net.F.length, nw * nw);
  for (let i = 0; i < old; i++) {
    for (let j = 0; j < old; j++) {
      const want = i === 0 && j === 0 ? 0.75 : i === 1 && j === 1 ? -1.5 : 0;
      assert.ok(Object.is(net.F[i * nw + j], want), `F[${i},${j}] migrou mal: ${net.F[i * nw + j]} != ${want}`);
    }
  }
  assert.equal(net.alphaJ[1], 0.05);
  checkInvariants(net);
});

check('E11: spectralRadius/spectralThermostat operam sobre W apenas (F ignorado e intocado)', () => {
  const net = makeNetwork({ seed: 39, nSlots: 4 });
  net.M[0] = 1; net.W[0] = 1.5;
  net.F[0] = 1.7; // peso rápido grande NÃO conta para o raio espectral
  const rho = spectralRadius(net);
  assert.ok(Math.abs(rho - 1.5) < 1e-9, `ρ̂ devia ser o de W (=${rho})`);
  const final = spectralThermostat(net, 0.95);
  assert.ok(final <= 0.95 + 1e-9);
  assert.ok(Math.abs(final - 0.95) < 1e-9, 'termostato escala W para o alvo');
  assert.ok(Object.is(net.F[0], 1.7), 'termostato não pode tocar em F');
  checkInvariants(net);
});

// ---------------------------------------------------------------------------
// E12: neurónio de memória + neurogénese por estagnação
// ---------------------------------------------------------------------------
console.log('\n== E12: addMemoryNeuron + neurogénese ==');

check('E12: addMemoryNeuron cria autoconexão forte W≈0.85, alpha≈0.05 e invariantes', () => {
  const net = makeNetwork({ seed: 40, nSlots: 8 });
  const rng = makeRng(60);
  for (let t = 0; t < 3; t++) assert.ok(applyOp(net, 'addNeuron', rng));
  assert.ok(applyOp(net, 'addMemoryNeuron', rng));
  // o neurónio de memória é o único slot vivo com alphaJ = 0.05
  let s = -1;
  for (let j = 0; j < net.nSlots; j++) {
    if (net.alive[j] && net.alphaJ[j] === 0.05) { assert.equal(s, -1, 'mais do que um neurónio de memória'); s = j; }
  }
  assert.ok(s > 0, 'devia existir exatamente um neurónio de memória');
  const n = net.nSlots;
  assert.equal(net.M[s * n + s], 1, 'autoconexão obrigatória');
  assert.ok(Math.abs(net.W[s * n + s] - 0.85) < 1e-12, 'autoconexão devia ser 0.85');
  assert.ok(Math.abs(net.alphaJ[s] - 0.05) < 1e-12, 'alpha do neurónio devia ser 0.05');
  // 1 input U(-s,s) por E10
  const inScale = Math.min(0.5, 1 / Math.sqrt(net.nIn));
  let nIn = 0;
  for (let k = 0; k < net.nIn; k++) {
    if (net.M_in[k * n + s]) {
      nIn++;
      assert.ok(Math.abs(net.W_in[k * n + s]) <= inScale + 1e-12, 'input fora da escala E10');
    }
  }
  assert.equal(nIn, 1, 'exatamente 1 ligação de input');
  // 1 saída pequena U(-0.3, 0.3) por E6 (para o readout ou para 1 neurónio vivo)
  let nOut = 0;
  for (let i = 0; i < net.nOut; i++) {
    if (net.M_out[s * net.nOut + i]) {
      nOut++;
      assert.ok(Math.abs(net.W_out[s * net.nOut + i]) < 0.3 + 1e-12);
    }
  }
  for (let j = 0; j < n; j++) {
    if (j === s || !net.M[s * n + j]) continue;
    nOut++;
    assert.ok(Math.abs(net.W[s * n + j]) < 0.3 + 1e-12, 'saída devia ser U(-0.3,0.3)');
  }
  assert.equal(nOut, 1, 'exatamente 1 ligação de saída (além da autoconexão)');
  checkInvariants(net);
});

check('E12: addMemoryNeuron cresce capacidade sozinho (como addNeuron)', () => {
  const net = makeNetwork({ seed: 41, nSlots: 4 });
  const rng = makeRng(61);
  let ok = 0;
  for (let t = 0; t < 40; t++) {
    if (applyOp(net, 'addMemoryNeuron', rng)) ok++;
    checkInvariants(net, `(addMemoryNeuron #${t})`);
  }
  assert.ok(net.nSlots > 4, 'devia crescer além do arranque');
  assert.ok(ok >= 3, `poucos addMemoryNeuron aplicados (${ok})`);
});

check('E12: bank.setBias concentra probabilidade e preserva P_min; {} repõe', () => {
  const bank = makeOperatorBank(makeRng(62));
  const iP = OP_NAMES.indexOf('addMemoryNeuron');
  const iQ = OP_NAMES.indexOf('removeConn');
  bank.setBias({ addNeuron: 2.5, addMemoryNeuron: 3 });
  let p = bank.probs();
  let sum = 0;
  for (let i = 0; i < p.length; i++) {
    sum += p[i];
    assert.ok(p[i] >= 0.05 - 1e-7, `P_min violado em ${OP_NAMES[i]}: ${p[i]}`);
  }
  assert.ok(Math.abs(sum - 1) < 1e-5, `soma de probs = ${sum}`);
  assert.ok(p[iP] >= 2 * p[iQ], 'bias devia concentrar a amostragem');
  // amostragem real (pick) concentrada
  const counts = new Map();
  for (let t = 0; t < 6000; t++) {
    const o = bank.pick();
    counts.set(o, (counts.get(o) ?? 0) + 1);
  }
  assert.ok((counts.get('addMemoryNeuron') ?? 0) > 2 * (counts.get('removeConn') ?? 0), 'pick() não concentrou');
  // bias extremo: dominante mas P_min mantido
  bank.setBias({ addMemoryNeuron: 100 });
  p = bank.probs();
  sum = 0;
  for (let i = 0; i < p.length; i++) {
    sum += p[i];
    assert.ok(p[i] >= 0.05 - 1e-7, `P_min violado com bias extremo em ${OP_NAMES[i]}`);
  }
  assert.ok(Math.abs(sum - 1) < 1e-5);
  assert.ok(p[iP] > 0.5, 'op enviesada devia dominar');
  // bias 0: a op não desaparece — fica presa ao P_min
  bank.setBias({ removeConn: 0 });
  p = bank.probs();
  assert.ok(p[iQ] >= 0.05 - 1e-7 && p[iQ] <= 0.06, `bias 0 devia prender a P_min (${p[iQ]})`);
  assert.equal(bank.stats().removeConn.bias, 0);
  assert.equal(bank.stats().addNeuron.bias, 1);
  assert.equal(bank.stats().addMemoryNeuron.bias, 1);
  // setBias({}) repõe tudo
  bank.setBias({});
  for (const name of OP_NAMES) assert.equal(bank.stats()[name].bias, 1);
  // multiplicadores inválidos lançam
  assert.throws(() => bank.setBias({ addNeuron: -1 }), RangeError);
  assert.throws(() => bank.setBias({ addNeuron: NaN }), RangeError);
});

check('E12: evolve — estagnação dispara burst (setBias 50 gens, neurogenesisBursts, stalled)', () => {
  const seen = [];
  const res = evolve(
    { population: 6, generations: 100, mazes: [maze5], seed: 63, elite: 2, mutationRate: 0 },
    { onGeneration: (gen, st) => seen.push({ gen, stalled: st.stalled, bias: st.bankStats.addMemoryNeuron.bias }) },
  );
  // mutationRate 0 ⇒ o melhor global nunca melhora após a 1.ª geração ⇒ estagnação garantida
  assert.equal(res.neurogenesisBursts, 1, 'exatamente 1 burst em 100 gerações');
  const bias3 = seen.filter((s) => s.bias === 3).map((s) => s.gen);
  assert.equal(bias3.length, 50, 'bias do burst ativo exatamente 50 gerações');
  assert.equal(bias3[0], 26, 'burst ao fim de K=25 gerações sem melhoria');
  assert.equal(bias3[49], 75);
  assert.equal(seen.find((s) => s.gen === 26).stalled, true, 'stalled=true no disparo');
  assert.equal(seen.find((s) => s.gen === 25).stalled, false);
  assert.equal(seen.find((s) => s.gen === 76).bias, 1, 'bias limpo após o burst');
  assert.equal(seen[seen.length - 1].bias, 1);
  assert.ok(seen.filter((s) => s.stalled).length >= 75);
});

// ---------------------------------------------------------------------------
// E13: modo de memória configurável
// ---------------------------------------------------------------------------
console.log('\n== E13: memoryMode ==');

check('E13: memoryMode sinapses — traços 12, fastOn true, F ativo', () => {
  const net = makeNetwork({ seed: 42, nSlots: 8 });
  net.M[0] = 1; net.W[0] = 0.1; // ligação mascarada para F acumular
  const r = runEpisode(net, maze5, { memoryMode: 'sinapses', trace: true, maxSteps: 6 });
  assert.equal(r.sensorTrace[0].length, 12);
  assert.equal(net.fastOn, true, 'sinapses liga as sinapses rápidas');
  assert.notEqual(net.F[0], 0, 'F devia estar ativo durante o episódio');
});

check('E13: memoryMode mapa — traços 12+células, fastOn false, F inativo', () => {
  const net = makeNetwork({ seed: 43, nSlots: 8, nInputs: 12 + maze5.cols * maze5.rows });
  net.M[0] = 1; net.W[0] = 0.1;
  const r = runEpisode(net, maze5, { memoryMode: 'mapa', trace: true, maxSteps: 6 });
  assert.equal(r.sensorTrace[0].length, 12 + maze5.cols * maze5.rows);
  assert.equal(net.fastOn, false, 'mapa desliga as sinapses rápidas');
  assert.ok(net.F.every((v) => v === 0), 'F devia ficar inativo');
});

check('E13: memoryMode ambos — traços 12+células E sinapses rápidas ativas', () => {
  const net = makeNetwork({ seed: 44, nSlots: 8, nInputs: 12 + maze5.cols * maze5.rows });
  net.M[0] = 1; net.W[0] = 0.1;
  const r = runEpisode(net, maze5, { memoryMode: 'ambos', trace: true, maxSteps: 6 });
  assert.equal(r.sensorTrace[0].length, 12 + maze5.cols * maze5.rows);
  assert.equal(net.fastOn, true);
  assert.notEqual(net.F[0], 0, 'F devia estar ativo');
});

check('E13: evaluate/solvedCount aceitam memoryMode (defeito = sinapses)', () => {
  const net12 = makeNetwork({ seed: 45, nSlots: 8 });
  const net37 = makeNetwork({ seed: 45, nSlots: 8, nInputs: 12 + maze5.cols * maze5.rows });
  const fDef = evaluate(net12, [maze5]);
  assert.equal(evaluate(net12, [maze5], { memoryMode: 'sinapses' }), fDef, 'defeito deve ser sinapses');
  assert.ok(Number.isFinite(evaluate(net37, [maze5], { memoryMode: 'ambos' })));
  assert.ok(Number.isFinite(evaluate(net37, [maze5], { memoryMode: 'mapa' })));
  const sc = solvedCount(net37, [maze5], { memoryMode: 'mapa' });
  assert.deepEqual(Object.keys(sc).sort(), ['solved', 'total']);
  assert.equal(sc.total, 1);
});

check('E13: evolve constrói nets com nIn do modo (12 para sinapses; 12+células para mapa/ambos)', () => {
  const cells = maze5.cols * maze5.rows;
  const base = { population: 6, generations: 2, mazes: [maze5], seed: 64, elite: 2, mutationRate: 0.9 };
  assert.equal(evolve({ ...base, memoryMode: 'sinapses' }).bestNet.nIn, 12);
  assert.equal(evolve(base).bestNet.nIn, 12, 'defeito é sinapses');
  assert.equal(evolve({ ...base, memoryMode: 'mapa' }).bestNet.nIn, 12 + cells);
  assert.equal(evolve({ ...base, memoryMode: 'ambos' }).bestNet.nIn, 12 + cells);
  // sem contagens fixas: 7×7 com mapa detecta 12 + 49
  const m7 = generateMaze(7, 7, 1);
  assert.equal(evolve({ ...base, mazes: [m7], memoryMode: 'mapa' }).bestNet.nIn, 12 + m7.cols * m7.rows);
  assert.equal(evolve({ ...base, mazes: [m7], memoryMode: 'sinapses' }).bestNet.nIn, 12);
});

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
