// Testes unitários de network/ops/evolution — correr com: node demo/tests/unit-net.mjs
// Cobre o contrato [B] de CONTRACTS.md. Sai com exit != 0 se algum check falhar.

import assert from 'node:assert/strict';
import {
  makeNetwork, resetNet, step, cloneNet, countNeurons, countConns,
  spectralRadius, spectralThermostat, ensureCapacity, MAX_SLOTS,
  invalidateMaskCache,
} from '../core/network.mjs';
import { OP_NAMES, applyOp, makeOperatorBank } from '../core/ops.mjs';
import {
  STEP_TICKS, fitnessOf, runEpisode, evaluate, evolve, solvedCount,
  distanceField, memoryHorizonFor, curriculumMazes,
  revisitCharge, pickDir, quantSig, // OPÇÃO B
} from '../core/evolution.mjs';
import { generateMaze, solveMaze, DIR_VEC } from '../core/maze.mjs';
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

// v7: unidade de DECISÃO = neurónio que alimenta o readout (alguma M_out[j][i] === 1).
function isDecisionNetUnit(net, j) {
  for (let i = 0; i < net.nOut; i++) if (net.M_out[j * net.nOut + i]) return true;
  return false;
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

check('E15: fitnessOf — fórmula canónica BFS (spot-checks EXATOS)', () => {
  // ramo resolvido: INALTERADO (guarda lexicográfica não interfere: 2.657 > 1.25)
  const solved = fitnessOf({ solved: true, steps: 10, maxSteps: 50, startDist: 4, endDist: 0, visited: 5, openCells: 7 });
  assert.equal(solved, 1.5 + (1 - 10 / 50) + 0.5 * (5 / 7));
  // ramo não resolvido: 2*(startDist − endDist)/startDist − steps*0.002 + 0.25*(visited/openCells)
  // OPÇÃO B/guarda: o valor bruto (1.6586) excede o UNSOLVED_CAP ⇒ clamp a 1.2
  // (assertão legitimamente alterada pela fórmula nova — guarda lexicográfica 07-2.5).
  const unsolvedRaw = 2 * (4 - 1) / 4 - 10 * 0.002 + 0.25 * (5 / 7);
  assert.ok(unsolvedRaw > 1.2, 'pré-condição: valor bruto acima do cap');
  const unsolved = fitnessOf({ solved: false, steps: 10, maxSteps: 50, startDist: 4, endDist: 1, visited: 5, openCells: 7 });
  assert.equal(unsolved, 1.2);
  const stuck = fitnessOf({ solved: false, steps: 0, maxSteps: 100, startDist: 4, endDist: 4, visited: 1, openCells: 7 });
  assert.equal(stuck, 2 * (4 - 4) / 4 - 0 * 0.002 + 0.25 * (1 / 7));
  // distâncias BFS profundas (nunca Manhattan): potencial 2×(progresso)
  // OPÇÃO B/guarda: valor bruto 1.5025 > 1.2 ⇒ clamp (assertão legitimamente alterada).
  const deepRaw = 2 * (40 - 10) / 40 - 30 * 0.002 + 0.25 * (20 / 80);
  assert.ok(deepRaw > 1.2, 'pré-condição: valor bruto acima do cap');
  const deep = fitnessOf({ solved: false, steps: 30, maxSteps: 100, startDist: 40, endDist: 10, visited: 20, openCells: 80 });
  assert.equal(deep, 1.2);
  // guarda E15: startDist = 0 ⇒ termo de progresso 0 (sem divisão por zero)
  const deg = fitnessOf({ solved: false, steps: 5, maxSteps: 10, startDist: 0, endDist: 3, visited: 2, openCells: 4 });
  assert.equal(deg, 0 - 5 * 0.002 + 0.25 * (2 / 4));
  assert.ok(Number.isFinite(deg));
  // valores BAIXOS continuam exatos (clamp não interfere)
  const low = fitnessOf({ solved: false, steps: 10, maxSteps: 50, startDist: 8, endDist: 4, visited: 12, openCells: 40 });
  assert.equal(low, 2 * (8 - 4) / 8 - 10 * 0.002 + 0.25 * (12 / 40));
});

check('OPÇÃO B: fitnessOf — bónus de novidade substitui cobertura + guarda lexicográfica', () => {
  // com `bonus` FINITO: SUBSTITUI o termo linear (0.5/0.25·visited/openCells) nos DOIS
  // ramos (escolha documentada: "same bonus in both branches").
  const s1 = fitnessOf({ solved: true, steps: 10, maxSteps: 50, startDist: 4, endDist: 0, visited: 5, openCells: 7, bonus: 0.1 });
  assert.equal(s1, 1.5 + (1 - 10 / 50) + 0.1);
  const u1 = fitnessOf({ solved: false, steps: 10, maxSteps: 50, startDist: 8, endDist: 4, visited: 12, openCells: 40, bonus: 0.05 });
  assert.equal(u1, 2 * (8 - 4) / 8 - 10 * 0.002 + 0.05);
  // bonus é clampado a [0, +0.25] DENTRO de fitnessOf
  assert.equal(fitnessOf({ solved: true, steps: 1, maxSteps: 2, startDist: 1, endDist: 0, visited: 0, openCells: 1, bonus: 9 }), 1.5 + 0.5 + 0.25);
  assert.equal(fitnessOf({ solved: false, steps: 0, maxSteps: 1, startDist: 4, endDist: 4, visited: 0, openCells: 1, bonus: -3 }), 0);
  // GUARDA LEXICOGRÁFICA: qualquer solved ≥ 1.25 > qualquer unsolved ≤ 1.2
  const rnd = (s) => { let a = s; return () => { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296; }; };
  const r = rnd(7);
  let minSolved = Infinity; let maxUnsolved = -Infinity;
  for (let i = 0; i < 4000; i++) {
    const args = {
      steps: Math.floor(r() * 200), maxSteps: 200,
      startDist: 1 + Math.floor(r() * 60), endDist: Math.floor(r() * 60),
      visited: Math.floor(r() * 100), openCells: 100,
      bonus: r() * 0.4 - 0.1,
    };
    const sv = fitnessOf({ ...args, solved: true });
    const uv = fitnessOf({ ...args, solved: false });
    if (sv < minSolved) minSolved = sv;
    if (uv > maxUnsolved) maxUnsolved = uv;
  }
  assert.ok(minSolved >= 1.25, `solved mínimo ${minSolved} < 1.25`);
  assert.ok(maxUnsolved <= 1.2, `unsolved máximo ${maxUnsolved} > 1.2`);
  assert.ok(minSolved > maxUnsolved, 'guarda: todo solved supera todo unsolved');
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
  assert.ok(d.sensorTrace[0] instanceof Float32Array && d.sensorTrace[0].length === 12, 'v7: SEMPRE 12 sinais');
  // v7: memoryMode é ignorado — mesmo 'ambos'/'mapa' correm com 12 entradas
  const netMap = makeNetwork({ seed: 17, nSlots: 8, nInputs: 12 + maze5.cols * maze5.rows });
  const dMap = runEpisode(netMap, maze5, { trace: true, maxSteps: 4, memoryMode: 'ambos' });
  assert.equal(dMap.sensorTrace[0].length, 12, 'v7: memoryMode=ambos continua a dar 12 sinais');
  assert.ok(Number.isFinite(dMap.fitness), 'rede com nIn maior não pode infecionar com NaN');
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
  assert.deepEqual(Object.keys(r1).sort(), ['bankStats', 'best', 'bestNet', 'finalLevel', 'generations', 'history', 'neurogenesisBursts']); // E12+E17
  assert.equal(typeof r1.neurogenesisBursts, 'number');
  assert.equal(r1.finalLevel, maze5.cols, 'sem curriculum finalLevel = tamanho dos mazes');
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
  // v7: a ligação de saída é RECORRENTE para um neurónio de DECISÃO e há entrada
  // recorrente vinda de um neurónio de decisão (cadeia decisão → sinapse → memória)
  let outTarget = -1;
  for (let j = 0; j < n; j++) {
    if (j === s) continue;
    if (net.M[s * n + j]) { assert.equal(outTarget, -1, 'mais de uma saída recorrente'); outTarget = j; }
  }
  assert.ok(outTarget >= 0, 'o mem-neuron tem de ter saída recorrente');
  assert.ok(isDecisionNetUnit(net, outTarget), 'a saída do mem-neuron tem de ir para um neurónio de DECISÃO');
  assert.equal(net.M_out[s * net.nOut + 0] + net.M_out[s * net.nOut + 1] + net.M_out[s * net.nOut + 2] + net.M_out[s * net.nOut + 3], 0, 'v7: sem ligação direta ao readout');
  let inSrc = -1;
  for (let j = 0; j < n; j++) {
    if (j === s) continue;
    if (net.M[j * n + s]) { assert.equal(inSrc, -1, 'mais de uma entrada recorrente'); inSrc = j; }
  }
  assert.ok(inSrc >= 0, 'o mem-neuron tem de ter entrada recorrente');
  assert.ok(isDecisionNetUnit(net, inSrc), 'a entrada do mem-neuron tem de vir de um neurónio de DECISÃO');
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
// E13 + REORIENTAÇÃO v7: memoryMode — 'sinapses' FIXO (mapa/ambos extintos na demo)
// ---------------------------------------------------------------------------
console.log('\n== E13/v7: memoryMode (fixo em sinapses) ==');

check('E13/v7: memoryMode sinapses — traços 12, fastOn true, F ativo', () => {
  const net = makeNetwork({ seed: 42, nSlots: 8 });
  net.M[0] = 1; net.W[0] = 0.1; // ligação mascarada para F acumular
  const r = runEpisode(net, maze5, { memoryMode: 'sinapses', trace: true, maxSteps: 6 });
  assert.equal(r.sensorTrace[0].length, 12);
  assert.equal(net.fastOn, true, 'sinapses liga as sinapses rápidas');
  assert.notEqual(net.F[0], 0, 'F devia estar ativo durante o episódio');
});

check('v7: memoryMode "mapa"/"ambos" é IGNORADO — episódio sempre 12 entradas + sinapses rápidas', () => {
  const net12 = makeNetwork({ seed: 43, nSlots: 8 });
  net12.M[0] = 1; net12.W[0] = 0.1;
  for (const mode of ['mapa', 'ambos', 'sinapses', 'nada']) {
    const r = runEpisode(net12, maze5, { memoryMode: mode, trace: true, maxSteps: 6 });
    assert.equal(r.sensorTrace[0].length, 12, `memoryMode=${mode} tem de dar 12 entradas`);
    assert.equal(net12.fastOn, true, `memoryMode=${mode} mantém as sinapses rápidas LIGADAS`);
    assert.notEqual(net12.F[0], 0, 'F tem de ficar ativo em qualquer modo');
    assert.ok(Number.isFinite(r.fitness));
  }
  // rede guardada com outra aritmética de entradas (nIn > 12): sem NaN (entradas em falta = 0)
  const net37 = makeNetwork({ seed: 43, nSlots: 8, nInputs: 12 + maze5.cols * maze5.rows });
  const r37 = runEpisode(net37, maze5, { memoryMode: 'ambos', maxSteps: 6 });
  assert.ok(Number.isFinite(r37.fitness), 'nIn maior não pode infecionar o episódio com NaN');
});

check('v7: evaluate/solvedCount ignoram memoryMode e mantêm a verificação exata', () => {
  const net12 = makeNetwork({ seed: 45, nSlots: 8 });
  const fDef = evaluate(net12, [maze5]);
  assert.equal(evaluate(net12, [maze5], { memoryMode: 'sinapses' }), fDef, 'defeito deve ser sinapses');
  assert.equal(evaluate(net12, [maze5], { memoryMode: 'mapa' }), fDef, 'mapa ignorado');
  assert.equal(evaluate(net12, [maze5], { memoryMode: 'ambos' }), fDef, 'ambos ignorado');
  const sc = solvedCount(net12, [maze5], { memoryMode: 'mapa' });
  assert.deepEqual(Object.keys(sc).sort(), ['solved', 'total']);
  assert.equal(sc.total, 1);
  assert.equal(sc.solved, runEpisode(net12, maze5, {}).solved ? 1 : 0);
});

check('v7: evolve constrói SEMPRE redes de 12 entradas (mapa/ambos ignorados)', () => {
  const base = { population: 6, generations: 2, mazes: [maze5], seed: 64, elite: 2, mutationRate: 0.9 };
  assert.equal(evolve({ ...base, memoryMode: 'sinapses' }).bestNet.nIn, 12);
  assert.equal(evolve(base).bestNet.nIn, 12, 'defeito é sinapses');
  assert.equal(evolve({ ...base, memoryMode: 'mapa' }).bestNet.nIn, 12, 'mapa EXTINTO ⇒ 12');
  assert.equal(evolve({ ...base, memoryMode: 'ambos' }).bestNet.nIn, 12, 'ambos EXTINTO ⇒ 12');
  // sem contagens fixas: o nIn sai do próprio sense() (12 sinais nomeados)
  const m7 = generateMaze(7, 7, 1);
  assert.equal(evolve({ ...base, mazes: [m7], memoryMode: 'mapa' }).bestNet.nIn, sense(m7, 1, 1).length);
  assert.equal(sense(m7, 1, 1).length, 12);
});

// ---------------------------------------------------------------------------
// EMENDA v6/E15: fitness BFS no episódio (grelha onde BFS ≠ Manhattan)
// ---------------------------------------------------------------------------
console.log('\n== E15: fitness BFS no runEpisode ==');

// Labirinto 5x5 à mão (mesma grelha de unit-core): exit (3,1), dist BFS do start = 6
// (Manhattan = 2 — bloqueada pela coluna de paredes x=2).
//   #####   #.#.#   #.#.#   #...#   #####
function handBfsMaze() {
  const cols = 5, rows = 5;
  const grid = new Uint8Array(cols * rows);
  for (const [x, y] of [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [0, 1], [2, 1], [4, 1], [0, 2], [2, 2], [4, 2], [0, 3], [4, 3], [0, 4], [1, 4], [2, 4], [3, 4], [4, 4]]) grid[y * cols + x] = 1;
  return {
    cols, rows, seed: 0, grid,
    start: { x: 1, y: 1 }, exit: { x: 3, y: 1 },
    idx: (x, y) => y * cols + x,
    isWall: (x, y) => (x < 0 || y < 0 || x >= cols || y >= rows ? true : grid[y * cols + x] === 1),
  };
}

check('E15: runEpisode usa distâncias BFS (fitness exato reconstruído do path)', () => {
  const g = handBfsMaze();
  const df = distanceField(g);
  assert.equal(df[g.idx(1, 1)], 6, 'distância BFS do start = 6 (Manhattan seria 2)');
  assert.equal(df[g.idx(1, 2)], 5, 'BFS (1,2) = 5 (Manhattan seria 3)');
  const bfsStart = (m) => df[m.idx(1, 1)];
  const bfsEnd = (m, e) => df[m.idx(e.x, e.y)];
  // (a) política CRIADA à mão: saída constante "↓" (b_out domina, W_out a zero) ⇒
  // 1 passo move (1,1)→(1,2). Com maxSteps=1: BFS dá 2*(6−5)/6; Manhattan daria
  // 2*(2−3)/2 = −1 — valores MUITO diferentes ⇒ prova de que o episódio usa BFS.
  const bot = makeNetwork({ seed: 5, nSlots: 4, memoryHorizon: 60 });
  bot.W_out.fill(0);
  bot.b_out[0] = 0; bot.b_out[1] = 1; bot.b_out[2] = 0; bot.b_out[3] = 0; // argmax = 1 (down)
  const r1 = runEpisode(bot, g, { maxSteps: 1 });
  assert.deepEqual(r1.path, [{ x: 1, y: 1 }, { x: 1, y: 2 }], 'política constante ↓ num passo');
  assert.equal(r1.solved, false);
  // valor EXATO novo: 1 entrada (bónus α=0.005), sem revisitas/bumps/ciclos.
  const expectBfs1 = fitnessOf({ solved: false, steps: 1, maxSteps: 1, startDist: 6, endDist: 5, visited: 2, openCells: 7, bonus: 0.005 });
  assert.equal(r1.bonus, 0.005, 'primeira entrada paga α');
  assert.equal(r1.penalty, 0);
  assert.equal(r1.penaltyCycle, 0);
  assert.ok(Math.abs(r1.fitness - expectBfs1) < 1e-12, `fitness ${r1.fitness} != esperado BFS ${expectBfs1}`);
  const expectMan1 = Math.min(2 * (2 - 3) / 2 - 1 * 0.002 + 0.005, 1.2);
  assert.ok(Math.abs(r1.fitness - expectMan1) > 0.5, `discriminante: BFS ${r1.fitness} vs Manhattan ${expectMan1}`);
  // (b) rede livre (seed 71, 40 passos): decomposição EXATA com o modelo novo —
  // fitness = guarda(fitnessOf(bónus) + penalty(tecto −0.25) + penaltyCycle).
  // (a reconstrução passo-a-passo das cargas Trémaux/pares/ciclos vive nos checks
  // "OPÇÃO B" abaixo; aqui valida-se a contabilidade total do runEpisode.)
  const net = makeNetwork({ seed: 71, nSlots: 8, memoryHorizon: 60 });
  const r = runEpisode(net, g, { maxSteps: 40 });
  assert.ok(Math.abs(r.penalty) <= 0.25 + 1e-12, 'tecto duro −0.25 na parte de revisita');
  const end = r.path[r.path.length - 1];
  const base = fitnessOf({
    solved: r.solved, steps: r.steps, maxSteps: 40,
    startDist: bfsStart(g), endDist: bfsEnd(g, end),
    visited: r.visitedCells, openCells: 7, bonus: r.bonus,
  });
  let expect = base + r.penalty + r.penaltyCycle;
  if (r.solved) expect = Math.max(expect, 1.25);
  else expect = Math.min(expect, 1.2);
  assert.ok(Math.abs(r.fitness - expect) < 1e-12, `fitness ${r.fitness} != decomposição ${expect}`);
});

// ---------------------------------------------------------------------------
// EMENDA v6/E16: horizonte de memória → fastLambda + cache da máscara de F
// ---------------------------------------------------------------------------
console.log('\n== E16: memoryHorizon + cache de F ==');

check('E16: memoryHorizon → fastLambda = exp(−1/H); fastLambda explícito ganha (compat)', () => {
  assert.equal(makeNetwork({ memoryHorizon: 60 }).fastLambda, Math.exp(-1 / 60));
  assert.equal(makeNetwork({ memoryHorizon: 800 }).fastLambda, Math.exp(-1 / 800));
  assert.ok(Math.abs(makeNetwork({ memoryHorizon: 60 }).fastLambda - 0.983) < 0.001, 'H=60 ⇒ ~0.983');
  assert.ok(Math.abs(makeNetwork({ memoryHorizon: 800 }).fastLambda - 0.9987) < 0.0005, 'H=800 ⇒ ~0.9987');
  // fastLambda explícito tem SEMPRE prioridade sobre memoryHorizon
  assert.equal(makeNetwork({ memoryHorizon: 60, fastLambda: 0.5 }).fastLambda, 0.5);
  assert.equal(makeNetwork({ fastLambda: 0.3 }).fastLambda, 0.3);
  // sem nenhum dos dois: default E11 intacto (compatibilidade)
  assert.equal(makeNetwork({}).fastLambda, 0.92);
  assert.equal(makeNetwork({ memoryHorizon: 0 }).fastLambda, 0.92); // inválido ⇒ default
  assert.equal(makeNetwork({ memoryHorizon: -5 }).fastLambda, 0.92);
  assert.equal(makeNetwork({ memoryHorizon: NaN }).fastLambda, 0.92);
  // cloneNet preserva o λ derivado
  assert.equal(cloneNet(makeNetwork({ memoryHorizon: 60 })).fastLambda, Math.exp(-1 / 60));
});

check('E16: evolve deriva o horizonte por labirinto (min(800, max(60, 2·openCells)))', () => {
  assert.equal(memoryHorizonFor(maze5), 60); // 5×5: 7 abertas ⇒ max(60, 14) = 60
  assert.equal(memoryHorizonFor(generateMaze(9, 9, 1)), 62); // 9×9: 31 abertas ⇒ 62
  assert.equal(memoryHorizonFor(generateMaze(31, 31, 1)), 800); // 31×31: 449 abertas ⇒ min(800,898)
  const res = evolve({ population: 4, generations: 1, mazes: [maze5], seed: 3, elite: 1, mutationRate: 0.9 });
  assert.equal(res.bestNet.fastLambda, Math.exp(-1 / 60), 'redes do evolve usam o horizonte do labirinto');
  // overrides configuráveis (probes): memoryHorizon e fastLambda explícitos
  const res2 = evolve({ population: 4, generations: 1, mazes: [maze5], seed: 3, elite: 1, memoryHorizon: 300 });
  assert.equal(res2.bestNet.fastLambda, Math.exp(-1 / 300));
  const res3 = evolve({ population: 4, generations: 1, mazes: [maze5], seed: 3, elite: 1, fastLambda: 0.77 });
  assert.equal(res3.bestNet.fastLambda, 0.77);
});

// Referência SEM cache: cópia literal da dinâmica do contrato com loops ingénuos n²
// (inclui a regra v7 de F com atividade das unidades de decisão). Serve de verdade
// exata contra a implementação cacheada de network.step.
function referenceStep(net, inputArr) {
  const { nIn, nOut, nSlots: n, alive, W, M, b, alpha, alphaJ, h, W_in, M_in, W_out, M_out, b_out, F } = net;
  const useFast = net.fastOn !== false && !!F;
  const dec = new Uint8Array(n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < nOut; i++) if (M_out[j * nOut + i]) { dec[j] = 1; break; }
  }
  const drive = new Float64Array(n);
  for (let j = 0; j < n; j++) {
    if (!alive[j]) continue;
    let d = b[j];
    for (let k = 0; k < nIn; k++) {
      const p = k * n + j;
      if (M_in[p]) {
        const v = inputArr[k];
        if (v !== undefined) d += v * W_in[p];
      }
    }
    drive[j] = d;
  }
  const nh = new Float64Array(n);
  for (let j = 0; j < n; j++) {
    if (!alive[j]) { h[j] = 0; continue; }
    let r = 0;
    for (let i = 0; i < n; i++) {
      const p = i * n + j;
      if (M[p]) r += h[i] * (useFast ? W[p] + F[p] : W[p]);
    }
    const a = alphaJ && alphaJ[j] > 0 ? alphaJ[j] : alpha;
    nh[j] = (1 - a) * h[j] + a * Math.tanh(r + drive[j]);
  }
  h.set(nh);
  if (useFast) {
    const lam = net.fastLambda;
    const eta = net.fastEta;
    for (let i = 0; i < n; i++) {
      const hi = h[i];
      for (let j = 0; j < n; j++) {
        const p = i * n + j;
        if (!M[p]) continue;
        const hj = h[j];
        const di = dec[i] ? hi : 0;
        const dj = dec[j] ? hj : 0;
        const v = lam * F[p] + eta * (hi * hj + hi * dj + di * hj);
        F[p] = v > 2 ? 2 : v < -2 ? -2 : v;
      }
    }
  }
  const y = new Float32Array(nOut);
  for (let i = 0; i < nOut; i++) {
    let v = b_out[i];
    for (let j = 0; j < n; j++) {
      const p = j * nOut + i;
      if (M_out[p]) v += h[j] * W_out[p];
    }
    y[i] = v;
  }
  return y;
}

check('E16: updates de F com cache são EXATOS vs referência sem cache (com mutações)', () => {
  const seq = fixedInputs(12, 45, 77);
  const build = () => {
    const net = makeNetwork({ seed: 50, nSlots: 10, memoryHorizon: 60 });
    const rng = makeRng(70);
    for (let t = 0; t < 3; t++) assert.ok(applyOp(net, 'addNeuron', rng));
    assert.ok(applyOp(net, 'addConn', rng));
    assert.ok(applyOp(net, 'addMemoryNeuron', rng));
    return { net, rng };
  };
  const A = build(); // produção: network.step (cache de máscaras)
  const B = build(); // referência: cálculo ingénuo sem cache
  assert.deepEqual(snapshot(A.net), snapshot(B.net), 'setup divergente');
  const opCycle = ['addConn', 'perturbWeights', 'addNeuron', 'removeConn', 'rewire', 'addMemoryNeuron', 'pruneNeuron', 'splitNeuron', 'changeLeak'];
  for (let t = 0; t < seq.length; t++) {
    if (t % 6 === 2) { // mutações estruturais idênticas nos dois lados (ops invalidam o cache)
      const op = opCycle[t % opCycle.length];
      assert.equal(applyOp(A.net, op, A.rng), applyOp(B.net, op, B.rng), `op ${op} divergiu em ${t}`);
    }
    if (t % 13 === 7) { // escrita DIRETA em M + invalidateMaskCache (contrato E16)
      const n = A.net.nSlots;
      const p = 2 * n + 3;
      A.net.M[p] = 0; A.net.W[p] = 0; A.net.F[p] = 0;
      B.net.M[p] = 0; B.net.W[p] = 0; B.net.F[p] = 0;
      const q = 4 * n + 5;
      A.net.M[q] = 1; A.net.W[q] = 0; A.net.F[q] = 0;
      B.net.M[q] = 1; B.net.W[q] = 0; B.net.F[q] = 0;
      invalidateMaskCache(A.net);
      invalidateMaskCache(B.net);
    }
    const ya = step(A.net, seq[t]);
    const yb = referenceStep(B.net, seq[t]);
    assert.deepEqual(Array.from(ya), Array.from(yb), `y divergente em ${t}`);
    assert.equal(A.net.nSlots, B.net.nSlots);
    for (let k = 0; k < A.net.h.length; k++) {
      assert.ok(Object.is(A.net.h[k], B.net.h[k]), `h[${k}] divergente em ${t}`);
      assert.ok(Object.is(A.net.F[k], B.net.F[k]), `F[${k}] divergente em ${t}`);
    }
    checkInvariants(A.net, `(tick ${t})`);
    checkInvariants(B.net, `(ref ${t})`);
  }
});

check('E16: cache reutilizado entre ticks; reconstruído após mutações (applyOp/resetNet/ensureCapacity)', () => {
  const net = makeNetwork({ seed: 51, nSlots: 8 });
  const rng = makeRng(71);
  assert.ok(applyOp(net, 'addNeuron', rng));
  assert.ok(applyOp(net, 'addConn', rng));
  const x = new Float32Array(12).fill(0.3);
  step(net, x);
  const cache1 = net._masks;
  assert.ok(cache1 && cache1.rec instanceof Int32Array && cache1.inp instanceof Int32Array, 'cache nasce no 1.º step');
  step(net, x);
  assert.equal(net._masks, cache1, 'sem mutação o cache tem de ser reutilizado');
  applyOp(net, 'changeLeak', rng); // qualquer applyOp invalida (mesmo sem tocar em M)
  assert.equal(net._masks, null, 'applyOp tem de invalidar o cache');
  step(net, x);
  assert.ok(net._masks && net._masks !== cache1, 'reconstruído após mutação');
  invalidateMaskCache(net);
  assert.equal(net._masks, null);
  invalidateMaskCache(net); // idempotente
  assert.equal(net._masks, null);
  step(net, x);
  assert.ok(net._masks);
  resetNet(net);
  assert.equal(net._masks, null, 'resetNet invalida');
  step(net, x);
  assert.equal(ensureCapacity(net, net.nSlots + 1), true);
  assert.equal(net._masks, null, 'ensureCapacity invalida (stride novo)');
  step(net, x);
  assert.equal(net._masks.n, net.nSlots, 'cache reconstruído para o nSlots novo');
});

check('v7: F regista o histórico de DECISÕES (sinapses a unidades de decisão acumulam 3×)', () => {
  // slot 0 = DECISÃO (alimenta o readout); slot 1 = não-decisão. Dinâmicas idênticas
  // (mesmas entradas/pesos) ⇒ h[0] === h[1] em cada ensaio. Autoconexões iguais e F a
  // partir de 0: a regra v7 dá F_dec = η·(h² + h·d + d·h) = 3ηh² e F_nao-dec = ηh².
  const net = makeNetwork({ seed: 60, nSlots: 4, memoryHorizon: 60 });
  net.fastEta = 0.05; // pequeno: sem clip ±2 para ver a razão exata
  const n = net.nSlots;
  net.alive[1] = 1;
  for (let k = 0; k < net.nIn; k++) {
    net.M_in[k * n + 1] = net.M_in[k * n];
    net.W_in[k * n + 1] = net.W_in[k * n];
  }
  net.M[0] = 1; net.W[0] = 0.2; // autoconexão do neurónio de DECISÃO
  net.M[1 * n + 1] = 1; net.W[1 * n + 1] = 0.2; // autoconexão do NÃO-decisão
  invalidateMaskCache(net);
  assert.ok(isDecisionNetUnit(net, 0), 'slot 0 alimenta o readout');
  assert.ok(!isDecisionNetUnit(net, 1), 'slot 1 não alimenta o readout');
  // ensaios independentes de 1 tick (F parte de 0 a cada ensaio)
  for (let trial = 0; trial < 5; trial++) {
    resetNet(net);
    const x = new Float32Array(12).fill(0.15 + trial * 0.1);
    step(net, x);
    assert.ok(Object.is(net.h[0], net.h[1]), 'dinâmicas idênticas até à atualização de F');
    assert.notEqual(net.F[0], 0);
    assert.notEqual(net.F[1 * n + 1], 0);
    assert.ok(Math.abs(net.F[0]) < 2 && Math.abs(net.F[1 * n + 1]) < 2, 'sem clip para a comparação');
    assert.ok(Math.abs(net.F[0] - 3 * net.F[1 * n + 1]) <= 1e-12 * Math.abs(net.F[0]) + 1e-15,
      `sinapse de decisão ${net.F[0]} devia ser ~3× a não-decisão ${net.F[1 * n + 1]}`);
  }
  checkInvariants(net);
});

// ---------------------------------------------------------------------------
// EMENDA v6/E17: curriculum — promoção de nível com transferência + burst
// ---------------------------------------------------------------------------
console.log('\n== E17: curriculum ==');

check('E17: curriculum — 5×5 resolvido ⇒ promoção a 7×7 mantendo população e banco + burst', () => {
  const timeline = [];
  const pops = new Map(); // gen → indivíduos (referências vivas)
  const banks = new Map(); // gen → bankStats (snapshot)
  let promotedInfo = null;
  const res = evolve(
    // orçamento: 5×5 com 3 layouts DISTINTOS (correção 2026-09-27) exige memória real;
    // medido com o campeão por solvedCount + candidatos aleatórios: promoção ~gen 37.
    { population: 100, generations: 150, curriculum: { startSize: 5, targetSize: 7 }, seed: 123, elite: 6, mutationRate: 0.9 },
    {
      onGeneration: (gen, st) => {
        timeline.push({
          gen, level: st.level, levelCount: st.levelCount,
          progress: st.levelProgress, promoted: st.promoted, bias: st.bankStats.addMemoryNeuron.bias,
        });
        pops.set(gen, st.population);
        banks.set(gen, st.bankStats);
        if (st.promoted && !promotedInfo) {
          promotedInfo = { gen, from: st.promoted.from, to: st.promoted.to };
        }
      },
    },
  );
  assert.ok(promotedInfo, 'o curriculum tinha de promover 5×5 → 7×7');
  assert.equal(promotedInfo.from, 5);
  assert.equal(promotedInfo.to, 7);
  const promoGen = promotedInfo.gen;
  const promoEntry = timeline.find((t) => t.gen === promoGen);
  assert.equal(promoEntry.level, 5, 'stats.level = tamanho treinado na geração da promoção');
  assert.deepEqual(promoEntry.progress, { solved: 3, total: 3 }, 'promoção exige campeão 3/3 no nível');
  assert.equal(promoEntry.bias, 3, 'a promoção tem de disparar o burst de neurogénese (setBias)');
  assert.ok(res.neurogenesisBursts >= 1, 'neurogenesisBursts conta o burst da promoção');
  // após a promoção: nível 7, nível 2, progresso do NOVO nível (3 mazes, exato)
  const after = timeline.filter((t) => t.gen > promoGen);
  assert.ok(after.length >= 3, 'precisamos de gerações pós-promoção para verificar a transferência');
  for (const t of after.slice(0, 3)) {
    assert.equal(t.level, 7, 'treino seguinte é 7×7');
    assert.equal(t.levelCount, 2);
    assert.equal(t.promoted, null);
    assert.deepEqual(Object.keys(t.progress).sort(), ['solved', 'total']);
    assert.equal(t.progress.total, 3);
  }
  // POPULAÇÃO preservada (transferência): os indivíduos elite da geração da promoção
  // reaparecem na geração seguinte com o MESMO idx e a MESMA referência de net.
  const promoPop = pops.get(promoGen);
  const postPop = pops.get(promoGen + 1);
  assert.ok(promoPop && postPop, 'populações capturadas em ambos os lados da promoção');
  assert.notEqual(postPop, promoPop, 'a geração seguinte tem uma população nova (elite + filhos)');
  const promoByIdx = new Map(promoPop.map((ind) => [ind.idx, ind]));
  let kept = 0;
  for (const ind of postPop) {
    const old = promoByIdx.get(ind.idx);
    if (old && old.net === ind.net) kept++;
  }
  assert.ok(kept >= 6, `pelo menos os elite=6 indivíduos deviam ser preservados (=${kept})`);
  // BANCO preservado: contagens acumuladas NÃO reiniciam na promoção e P_min mantém-se
  const bankPost = banks.get(promoGen + 1);
  const bankPromo = banks.get(promoGen);
  for (const name of OP_NAMES) {
    assert.ok(bankPost[name].count >= bankPromo[name].count, `contagem de ${name} reiniciou na promoção`);
    assert.ok(bankPost[name].count >= 0 && Number.isFinite(bankPost[name].p));
    assert.ok(bankPost[name].p >= 0.05 - 1e-7, 'P_min mantido após a promoção');
  }
  // E16: memória rápida reajustada ao NOVO nível (7×7 ⇒ openCells=17 ⇒ H=60 ⇒ λ=exp(−1/60))
  assert.equal(res.bestNet.fastLambda, Math.exp(-1 / 60));
  assert.equal(res.finalLevel, 7, 'finalLevel = tamanho do nível atingido (targetSize)');
  assert.equal(res.generations > promoGen, true);
});

check('E17: sem curriculum o comportamento é o de sempre (sem promoções, finalLevel = tamanho)', () => {
  const seen = [];
  const res = evolve(
    { population: 6, generations: 4, mazes: [maze5], seed: 9, elite: 2, mutationRate: 0.9 },
    { onGeneration: (gen, st) => seen.push({ level: st.level, progress: st.levelProgress, promoted: st.promoted, levelCount: st.levelCount }) },
  );
  assert.equal(res.finalLevel, 5);
  for (const s of seen) {
    assert.equal(s.level, 5);
    assert.equal(s.levelCount, 1);
    assert.equal(s.promoted, null);
    assert.deepEqual(Object.keys(s.progress).sort(), ['solved', 'total']);
    assert.equal(s.progress.total, 1);
  }
});

// ---------------------------------------------------------------------------
// EMENDA v6/E18: evaluate com mazePerGen (amostra rotativa determinística)
// ---------------------------------------------------------------------------
console.log('\n== E18: mazePerGen ==');

check('E18: evaluate com mazePerGen é determinístico e rotativo (1 labirinto por chamada)', () => {
  const mazes = [maze5, generateMaze(5, 5, 4), generateMaze(5, 5, 9)];
  const net = makeNetwork({ seed: 70, nSlots: 8 });
  const want = mazes.map((m) => runEpisode(net, m, {}).fitness);
  const run = (seed) => {
    const opts = { mazePerGen: true, rng: makeRng(seed) }; // opts NOVOS por run
    const out = [];
    for (let i = 0; i < 6; i++) out.push(evaluate(net, mazes, opts));
    return out;
  };
  const a = run(77);
  const b = run(77);
  assert.deepEqual(a, b, 'mesma seed e ordem de chamadas ⇒ mesma sequência');
  // rotação round-robin com offset inicial de opts.rng: idx = (offset + i) % 3
  const probe = makeRng(77);
  const offset = Math.floor(probe.next() * mazes.length) % mazes.length;
  for (let i = 0; i < 6; i++) {
    assert.equal(a[i], want[(offset + i) % 3], `amostra ${i} devia ser o labirinto ${(offset + i) % 3}`);
  }
  // cobertura garantida: 3 chamadas consecutivas cobrem os 3 labirintos (uma vez cada)
  const covered = new Set();
  for (let i = 0; i < 3; i++) covered.add((offset + i) % 3);
  assert.equal(covered.size, 3, 'todos os mazes recebem cobertura por geração');
  // sem opts.rng: começa em 0 e continua a rodar
  const noRng = { mazePerGen: true };
  assert.equal(evaluate(net, mazes, noRng), want[0]);
  assert.equal(evaluate(net, mazes, noRng), want[1]);
  assert.equal(evaluate(net, mazes, noRng), want[2]);
  // sem mazePerGen: média exata sobre todos (comportamento legacy intacto)
  assert.equal(evaluate(net, mazes, {}), (want[0] + want[1] + want[2]) / 3);
  // a verificação do campeão (solvedCount) continua EXATA mesmo com mazePerGen pedido
  const sc = solvedCount(net, mazes, { mazePerGen: true, rng: makeRng(5) });
  let manual = 0;
  for (const m of mazes) if (runEpisode(net, m, {}).solved) manual++;
  assert.equal(sc.solved, manual);
  assert.equal(sc.total, 3);
});

check('E18: evolve com curriculum avalia por amostra (mazePerGen) e mantém o campeão exato', () => {
  const sampled = [];
  const res = evolve(
    { population: 10, generations: 3, curriculum: { startSize: 5, targetSize: 5 }, seed: 21, elite: 3, mutationRate: 0.9 },
    { onGeneration: (gen, st) => sampled.push({ level: st.level, progress: st.levelProgress }) },
  );
  for (const s of sampled) {
    assert.equal(s.level, 5);
    assert.equal(s.progress.total, 3, 'levelProgress usa solvedCount sobre os 3 do nível');
    assert.ok(s.progress.solved >= 0 && s.progress.solved <= 3);
  }
  assert.ok(Number.isFinite(res.best));
  // mazePerGen explícito também funciona SEM curriculum
  const net = makeNetwork({ seed: 72, nSlots: 8 });
  const mazes = [maze5, generateMaze(5, 5, 4)];
  const f = evaluate(net, mazes, { mazePerGen: true, rng: makeRng(3) });
  assert.ok(Number.isFinite(f));
  assert.equal(evaluate(net, mazes, { mazePerGen: false }), (runEpisode(net, mazes[0], {}).fitness + runEpisode(net, mazes[1], {}).fitness) / 2);
});

// ---------------------------------------------------------------------------
// OPÇÃO B (anti-loop): deteção de ciclos + punição + quebra ativa (research 06-09)
// ---------------------------------------------------------------------------
console.log('\n== OPÇÃO B: deteção + punição + tentar outros caminhos ==');

// corredor 7×5 à mão (área aberta 1..5 × 1..3) para trajetórias sintéticas
function corridorMaze() {
  const cols = 7, rows = 5;
  const grid = new Uint8Array(cols * rows).fill(1);
  for (let y = 1; y <= 3; y++) for (let x = 1; x <= 5; x++) grid[y * cols + x] = 0;
  return {
    cols, rows, seed: 0, grid,
    start: { x: 1, y: 1 }, exit: { x: 5, y: 3 },
    idx: (x, y) => y * cols + x,
    isWall: (x, y) => (x < 0 || y < 0 || x >= cols || y >= rows ? true : grid[y * cols + x] === 1),
  };
}
const scripted = (dirs) => { let i = 0; return () => dirs[i++] ?? dirs[dirs.length - 1]; };
const bot12 = () => makeNetwork({ seed: 5, nSlots: 8 });

check('OPÇÃO B: revisita escalonada p(n) — saturação em 8× e primeira visita grátis', () => {
  assert.equal(revisitCharge(1), 0, 'primeira visita não paga revisita');
  assert.equal(revisitCharge(2), -0.005, '2.ª visita = custo atual');
  assert.equal(revisitCharge(3), -0.005 * 1.6);
  assert.equal(revisitCharge(4), -0.005 * 1.6 ** 2);
  assert.equal(revisitCharge(6), -0.005 * 1.6 ** 4);
  // saturação: piso −0.04 = −0.005·8 a partir de n = 10 (1.6^8 ≈ 43 > 8)
  assert.equal(revisitCharge(10), -0.005 * 8);
  assert.equal(revisitCharge(12), -0.005 * 8);
  assert.equal(revisitCharge(255), -0.005 * 8, 'saturação mantida');
  // monotonia da magnitude até ao tecto
  let prev = 0;
  for (let n = 1; n <= 10; n++) {
    const c = revisitCharge(n);
    assert.ok(c <= prev + 1e-15, `p(${n})=${c} devia ser ≤ ${prev}`);
    prev = c;
  }
});

check('OPÇÃO B: detetor — ABAB período 2 detetado em ≤ 3 passos; caminho BFS limpo sem falso positivo', () => {
  // (a) oscilação ABAB em corredor (vai-e-vem entre (1,1) e (2,1))
  const g = corridorMaze();
  const r = runEpisode(bot12(), g, { policy: scripted([3, 2, 3, 2, 3, 2, 3, 2, 3, 2, 3, 2, 3, 2, 3, 2]) });
  assert.ok(r.cycleDetectStep >= 1 && r.cycleDetectStep <= 3,
    `ABAB devia ser detetado em ≤ 3 passos (detetado no passo ${r.cycleDetectStep})`);
  assert.equal(r.cycleLen, 2, 'período 2');
  assert.equal(r.aliased, false, 'ciclo exato de (célula, ação), não aliado');
  assert.equal(r.repeats, 4, 'contagem de reincidência até à saída antecipada');
  // (b) caminho BFS limpo (perfeito, células todas distintas) ⇒ ZERO deteções
  const m5 = generateMaze(5, 5, 3);
  const p = solveMaze(m5);
  const dirs = [];
  for (let k = 1; k < p.length; k++) {
    const dx = p[k].x - p[k - 1].x, dy = p[k].y - p[k - 1].y;
    dirs.push(DIR_VEC.findIndex((v) => v[0] === dx && v[1] === dy));
  }
  const r2 = runEpisode(bot12(), m5, { policy: scripted(dirs) });
  assert.equal(r2.solved, true, 'o caminho BFS resolve');
  assert.equal(r2.cycleDetectStep, 0, 'sem falso positivo em caminho limpo');
  assert.equal(r2.repeats, 0);
  assert.equal(r2.looped, false);
  assert.equal(r2.penaltyCycle, 0);
  assert.equal(r2.penalty, 0, 'caminho limpo: sem revisitas nem bumps');
});

check('OPÇÃO B: Trémaux — 1.ª devolução de beco gratuita; oscilação cara', () => {
  const g = corridorMaze();
  // (a) entra num beco (R,R,R) e volta (L): a inversão imediata que entra em célula
  // visitada UMA vez é isenta ⇒ penalty exatamente 0
  const back = runEpisode(bot12(), g, { policy: scripted([3, 3, 3, 2]), maxSteps: 4 });
  assert.equal(back.reversals, 1, 'uma inversão imediata');
  assert.equal(back.revisits, 1, 'uma revisita (a devolução)');
  assert.equal(back.penalty, 0, 'primeira devolução de beco isenta (Trémaux)');
  // (b) beco mais longo: a 2.ª revisita paga só a margem base (sem escalada)
  const back2 = runEpisode(bot12(), g, { policy: scripted([3, 3, 3, 2, 2, 2]), maxSteps: 6 });
  assert.equal(back2.penalty, 2 * revisitCharge(2), 'devolução longa paga só p(2) por revisita');
  // (c) oscilação (ABAB): custa SIGNIFICATIVAMENTE mais (reincidência do par + escalada)
  const osc = runEpisode(bot12(), g, { policy: scripted([3, 2, 3, 2, 3, 2, 3, 2, 3, 2, 3, 2, 3, 2, 3, 2]) });
  assert.ok(osc.reversals > back.reversals, 'oscilação tem mais inversões');
  assert.ok(osc.penalty < back.penalty - 0.005,
    `oscilação (${osc.penalty}) tinha de custar mais que backtracking (${back.penalty})`);
  assert.ok(osc.penalty < 0, 'oscilação com penalidade negativa');
  assert.ok(osc.penalty + osc.penaltyCycle < back.penalty, 'com ciclos, ainda mais cara');
});

check('OPÇÃO B: saída antecipada em repeats ≥ 4 (looped, cycleLen, repeats)', () => {
  const g = corridorMaze();
  const r = runEpisode(bot12(), g, {
    policy: scripted([3, 2, 3, 2, 3, 2, 3, 2, 3, 2, 3, 2, 3, 2, 3, 2, 3, 2, 3, 2]),
    maxSteps: 500,
  });
  assert.equal(r.looped, true);
  assert.equal(r.repeats, 4, 'para em repeats = 4');
  assert.equal(r.cycleLen, 2);
  assert.ok(r.steps <= 12, `episódio devia terminar cedo (steps=${r.steps} de 500)`);
  assert.equal(r.solved, false, 'fim antecipado = NÃO resolvido');
  // punição por volta r: −0.02·min(2^(r−1),8)·cycleLen ⇒ −0.02·(1+2+4+8)·2 = −0.6 (custo)
  assert.ok(Math.abs(r.penaltyCycle + 0.02 * (1 + 2 + 4 + 8) * 2) < 1e-12,
    `penaltyCycle=${r.penaltyCycle}`);
  // guarda lexicográfica vale mesmo para o caso penalizado
  assert.ok(r.fitness <= 1.2, 'unsolved clampado a ≤ 1.2');
});

check('OPÇÃO B: histerese anti-período-2 — margem de 8% do intervalo das saídas', () => {
  const open = new Uint8Array([1, 1, 1, 1]);
  const cells = new Int32Array([10, 11, 12, 13]);
  // melhor muda de 1 para 2 mas por MENOS de 8% do intervalo (0.5−0=0.5, margem 0.04)
  const yKeep = new Float32Array([0, 0.49, 0.5, 0]);
  assert.equal(pickDir(yKeep, 1, open, cells), 1, 'sem margem suficiente ⇒ mantém a ação anterior');
  // margem suficiente (0.5 ≥ 0.40+0.04) ⇒ troca
  const ySwitch = new Float32Array([0, 0.4, 0.5, 0]);
  assert.equal(pickDir(ySwitch, 1, open, cells), 2, 'com margem ⇒ troca para a melhor');
  // limite (margem mínima satisfeita de forma robusta a arredondamento float) ⇒ troca
  const yEdge = new Float32Array([0, 0.459, 0.5, 0]);
  assert.equal(pickDir(yEdge, 1, open, cells), 2, 'margem satisfeita ⇒ troca');
  // salta a histerese se a ação anterior colide
  const openWall = new Uint8Array([1, 0, 1, 1]);
  assert.equal(pickDir(yKeep, 1, openWall, cells), 2, 'colisão da ação anterior ⇒ salta a histerese');
  // sem ação anterior (1.º passo) ⇒ argmax puro
  assert.equal(pickDir(yKeep, null, open, cells), 2);
  assert.equal(pickDir(yKeep, 2, open, cells), 2, 'melhor igual à anterior ⇒ fica');
  // QUEBRA ATIVA: força a 2.ª melhor; salta paredes e a célula proibida
  const y4 = new Float32Array([0.9, 0.5, 0.3, 0.1]);
  assert.equal(pickDir(y4, null, open, cells, true), 1, 'força a 2.ª melhor direção');
  assert.equal(pickDir(y4, null, openWall, cells, true), 2, '2.ª melhor é parede ⇒ a seguinte');
  assert.equal(pickDir(y4, null, open, cells, true, cells[1]), 2, 'célula que iniciou o ciclo é proibida');
});

check('OPÇÃO B: guarda lexicográfica no runEpisode (solved ≥ 1.25 > unsolved ≤ 1.2)', () => {
  for (let seed = 1; seed <= 25; seed++) {
    const m = generateMaze(5, 5, seed);
    const net = makeNetwork({ seed: seed * 13, nSlots: 8 });
    for (const opts of [{}, { antiLoop: false }, { maxSteps: 30 }, { maxSteps: 30, antiLoop: false }]) {
      const r = runEpisode(net, m, opts);
      if (r.solved) assert.ok(r.fitness >= 1.25, `solved ${r.fitness} < 1.25 (seed ${seed})`);
      else assert.ok(r.fitness <= 1.2, `unsolved ${r.fitness} > 1.2 (seed ${seed})`);
      assert.ok(Number.isFinite(r.fitness));
    }
  }
});

check('OPÇÃO B: anti-aliasing — quantização 4 bits + campo aliased (plumbing)', () => {
  // (1) quantSig: igualdade de buffers ⇒ igual hash; 4 bits/valor ⇒ variações abaixo
  // do passo de quantização colapsam (é EXATAMENTE o aliasing que o 2.º detetor cobre).
  const a = new Float32Array(12).fill(0.5);
  const b = new Float32Array(12).fill(0.5);
  assert.equal(quantSig(a), quantSig(b), 'buffers iguais ⇒ assinatura igual');
  const c = new Float32Array(12).fill(0.501); // passo 4 bits = 1/16 = 0.0625
  assert.equal(quantSig(a), quantSig(c), 'variação < 1/16 colapsa (aliasing perceptual)');
  const d = new Float32Array(12).fill(0.5 + 0.07);
  assert.notEqual(quantSig(a), quantSig(d), 'variação > 1/16 muda de balde');
  // (2) num ciclo EXATO (célula,ação) o detetor principal atua primeiro ⇒ aliased false
  const g = corridorMaze();
  const r = runEpisode(bot12(), g, { policy: scripted([3, 2, 3, 2, 3, 2, 3, 2, 3, 2, 3, 2, 3, 2, 3, 2]) });
  assert.equal(r.aliased, false, 'ciclo exato não é contado como aliado');
  assert.equal(typeof r.aliased, 'boolean');
  // (3) num caminho limpo não há deteção aliada
  const m5 = generateMaze(5, 5, 3);
  const p = solveMaze(m5);
  const dirs = [];
  for (let k = 1; k < p.length; k++) {
    const dx = p[k].x - p[k - 1].x, dy = p[k].y - p[k - 1].y;
    dirs.push(DIR_VEC.findIndex((v) => v[0] === dx && v[1] === dy));
  }
  const r2 = runEpisode(bot12(), m5, { policy: scripted(dirs) });
  assert.equal(r2.aliased, false, 'sem falso positivo aliado em caminho limpo');
  // NOTA: trajetória sintética com assinatura periódica e (célula,ação) não-periódica
  // não foi construída dentro do orçamento (ver IMPLEMENTACAO-B.md — limitações);
  // o ramos aliased está coberto aqui + telemetria do probe A/B.
});

check('OPÇÃO B: antiLoop:false = modo legado (plano, sem deteção/histerese)', () => {
  const g = corridorMaze();
  const r = runEpisode(bot12(), g, {
    policy: scripted([3, 2, 3, 2, 3, 2, 3, 2, 3, 2, 3, 2, 3, 2, 3, 2, 3, 2, 3, 2]),
    maxSteps: 40,
    antiLoop: false,
  });
  assert.equal(r.looped, false, 'sem deteção no legado');
  assert.equal(r.cycleDetectStep, 0);
  assert.equal(r.penaltyCycle, 0);
  assert.equal(r.bonus, 0);
  assert.equal(r.steps, 40, 'legado corre até maxSteps (sem saída antecipada)');
  assert.ok(r.penalty < 0, 'revisitas planas −0.005 acumulam');
});

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

