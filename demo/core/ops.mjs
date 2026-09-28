// Operadores de mutação estrutural (CONTRACTS.md §core/ops.mjs).
// Toda a inicialização preserva a função: ligações novas nascem com peso 0 e o neurónio novo
// nasce com pesos de SAÍDA 0. Invariante garantida: M === 0 ⇒ W === 0 (idem M_in/M_out),
// slot 0 sempre vivo e com caminho input→output.
//
// REORIENTAÇÃO v7 (2026-09-27): as sinapses "surgem e se ligam" para codificar decisões
// anteriores — addConn/addNeuron/addMemoryNeuron MUDAM a topologia (novas sinapses),
// perturbWeights ativa pesos nascidos a 0 e as sinapses rápidas (F, network.mjs) tornam
// qualquer ligação mascarada funcional de imediato, registando a co-ocorrência
// atividade×decisão. addMemoryNeuron liga-se RECORRENTEMENTE aos neurónios de DECISÃO
// (unidades que alimentam o readout) nos dois sentidos: recebe a atividade de decisão
// (d→s) e devolve-a ao sistema de decisão (s→d).
//
// EMENDA v6/E16: toda a mutação de máscaras (M/M_in/M_out) invalida o cache de índices
// mascarados de network.mjs (applyOp chama invalidateMaskCache no fim; ver também
// clearSlot). O contrato público das ops não muda.
import { ensureCapacity, invalidateMaskCache } from './network.mjs';

export const OP_NAMES = ['addNeuron', 'addConn', 'removeConn', 'rewire', 'pruneNeuron', 'changeLeak', 'splitNeuron', 'perturbWeights', 'addMemoryNeuron'];

function rndInt(rng, m) {
  return Math.floor(rng.next() * m);
}

function aliveList(net, exclude = -1) {
  const out = [];
  for (let j = 0; j < net.nSlots; j++) if (net.alive[j] && j !== exclude) out.push(j);
  return out;
}

function deadList(net) {
  const out = [];
  for (let j = 0; j < net.nSlots; j++) if (!net.alive[j]) out.push(j);
  return out;
}

// v7: unidades de DECISÃO = neurónios vivos que alimentam o readout (alguma
// M_out[j*nOut+i] === 1) — "o h que alimenta o readout conta como decisão".
function decisionList(net, exclude = -1) {
  const out = [];
  for (let j = 0; j < net.nSlots; j++) {
    if (!net.alive[j] || j === exclude) continue;
    const row = j * net.nOut;
    for (let i = 0; i < net.nOut; i++) {
      if (net.M_out[row + i]) { out.push(j); break; }
    }
  }
  return out;
}

// Zera máscaras, pesos, bias e estado do slot s (para reutilização limpa).
// E11: zera também F (invariante M===0 ⇒ F===0); E12: alphaJ volta ao default (net.alpha).
function clearSlot(net, s) {
  const n = net.nSlots;
  for (let k = 0; k < n; k++) {
    net.M[s * n + k] = 0; net.W[s * n + k] = 0; net.F[s * n + k] = 0; // saídas
    net.M[k * n + s] = 0; net.W[k * n + s] = 0; net.F[k * n + s] = 0; // entradas
  }
  for (let k = 0; k < net.nIn; k++) {
    net.M_in[k * n + s] = 0; net.W_in[k * n + s] = 0;
  }
  for (let i = 0; i < net.nOut; i++) {
    net.M_out[s * net.nOut + i] = 0; net.W_out[s * net.nOut + i] = 0;
  }
  net.b[s] = 0;
  net.h[s] = 0;
  net.alphaJ[s] = 0;
}

// addNeuron: 1 input→novo (peso U(-0.5,0.5)) e novo→1 output (ou 1 neurónio vivo) com peso 0.
// EMENDA v2/E1: sem slot morto, cresce a capacidade (ensureCapacity) antes de falhar;
// só devolve false quando o teto MAX_SLOTS impede o crescimento.
function addNeuron(net, rng) {
  let dead = deadList(net);
  if (!dead.length) {
    if (!ensureCapacity(net, 1)) return false;
    dead = deadList(net);
    if (!dead.length) return false; // defesa: ensureCapacity garante ≥1 livre
  }
  const n = net.nSlots;
  const s = dead[rndInt(rng, dead.length)];
  clearSlot(net, s);
  net.alive[s] = 1;
  const k = rndInt(rng, net.nIn);
  net.M_in[k * n + s] = 1;
  net.W_in[k * n + s] = (rng.next() - 0.5) * 2 * Math.min(0.5, 1 / Math.sqrt(net.nIn)); // E10
  // EMENDA v3/E6: saídas nascem pequenas mas NÃO-nulas (U(-0.3, 0.3)). Sem treino por
  // gradientes, peso 0 mantinha o neurónio novo inerte e a evolução não o ativava.
  if (rng.next() < 0.5) {
    const i = rndInt(rng, net.nOut);
    net.M_out[s * net.nOut + i] = 1;
    net.W_out[s * net.nOut + i] = (rng.next() - 0.5) * 0.6;
  } else {
    const al = aliveList(net, s);
    const j = al[rndInt(rng, al.length)];
    net.M[s * n + j] = 1;
    net.W[s * n + j] = (rng.next() - 0.5) * 0.6;
  }
  return true;
}

// addConn: cria i→j inexistente entre neurónios vivos (inclui autoconexão) com peso 0.
function addConn(net, rng) {
  const n = net.nSlots;
  const al = aliveList(net);
  const missing = [];
  for (const i of al) {
    for (const j of al) {
      const p = i * n + j;
      if (!net.M[p]) missing.push(p);
    }
  }
  if (!missing.length) return false;
  const p = missing[rndInt(rng, missing.length)];
  net.M[p] = 1;
  net.W[p] = 0;
  return true;
}

// removeConn: remove a ligação recorrente existente de menor |w| (empate: índice mais baixo).
function removeConn(net) {
  let best = -1;
  let bestAbs = Infinity;
  for (let k = 0; k < net.M.length; k++) {
    if (!net.M[k]) continue;
    const a = Math.abs(net.W[k]);
    if (a < bestAbs) { bestAbs = a; best = k; }
  }
  if (best < 0) return false;
  net.M[best] = 0;
  net.W[best] = 0;
  net.F[best] = 0; // E11: sinapse rápida acompanha a máscara
  return true;
}

// rewire: i→j passa a i→k (k vivo, sem ligação i→k prévia); peso novo = 0.
function rewire(net, rng) {
  const n = net.nSlots;
  const al = aliveList(net);
  const pairs = [];
  for (let k = 0; k < net.M.length; k++) {
    if (!net.M[k]) continue;
    const i = Math.floor(k / n);
    const j = k - i * n;
    for (const t of al) {
      if (t === j || net.M[i * n + t]) continue;
      pairs.push([k, i * n + t]);
    }
  }
  if (!pairs.length) return false;
  const [oldP, newP] = pairs[rndInt(rng, pairs.length)];
  net.M[oldP] = 0;
  net.W[oldP] = 0;
  net.F[oldP] = 0; // E11: sinapse rápida acompanha a máscara
  net.M[newP] = 1;
  net.W[newP] = 0;
  net.F[newP] = 0;
  return true;
}

// pruneNeuron: desliga o neurónio vivo (≠0) de menor contribuição (heurística barata por pesos:
// soma |w| das saídas recorrentes + saídas para o readout). Limpa M/M_in/M_out associadas.
function pruneNeuron(net) {
  const n = net.nSlots;
  const nOut = net.nOut;
  let worst = -1;
  let worstC = Infinity;
  for (let j = 1; j < n; j++) {
    if (!net.alive[j]) continue;
    let c = 0;
    for (let k = 0; k < n; k++) {
      const p = j * n + k;
      if (net.M[p]) c += Math.abs(net.W[p]);
    }
    for (let i = 0; i < nOut; i++) {
      const p = j * nOut + i;
      if (net.M_out[p]) c += Math.abs(net.W_out[p]);
    }
    if (c < worstC) { worstC = c; worst = j; }
  }
  if (worst < 0) return false;
  net.alive[worst] = 0;
  clearSlot(net, worst);
  return true;
}

// changeLeak: alpha *= 0.8 ou 1.25, clipado a [0.02, 1].
function changeLeak(net, rng) {
  const f = rng.next() < 0.5 ? 0.8 : 1.25;
  net.alpha = Math.min(1, Math.max(0.02, net.alpha * f));
  return true;
}

// splitNeuron: duplica o neurónio vivo j para o slot morto s (Net2Net).
// Copia todas as entradas (features, recorrentes, bias e estado) e divide as saídas por 2
// (j e s ficam com metade cada). A autoconexão é copiada, não dividida: assim h_s = h_j
// mantém-se exatamente e a função da rede fica inalterada.
function splitNeuron(net, rng) {
  const al = aliveList(net);
  const dead = deadList(net);
  if (!al.length || !dead.length) return false;
  const n = net.nSlots;
  const nIn = net.nIn;
  const nOut = net.nOut;
  const j = al[rndInt(rng, al.length)];
  const s = dead[rndInt(rng, dead.length)];
  clearSlot(net, s);
  net.alive[s] = 1;
  net.b[s] = net.b[j];
  net.h[s] = net.h[j];
  net.alphaJ[s] = net.alphaJ[j]; // E12: leak idêntico (h_s = h_j exige-o)
  for (let k = 0; k < nIn; k++) { // features → s
    const p = k * n + j;
    net.M_in[k * n + s] = net.M_in[p];
    net.W_in[k * n + s] = net.W_in[p];
  }
  for (let i = 0; i < n; i++) { // entradas recorrentes i→j copiadas para i→s
    if (i === j || i === s) continue;
    const p = i * n + j;
    net.M[i * n + s] = net.M[p];
    net.W[i * n + s] = net.W[p];
    net.F[i * n + s] = net.F[p]; // E11: sinapse rápida copiada simetricamente
  }
  net.M[s * n + s] = net.M[j * n + j]; // autoconexão copiada
  net.W[s * n + s] = net.W[j * n + j];
  net.F[s * n + s] = net.F[j * n + j];
  for (let k = 0; k < n; k++) { // saídas recorrentes divididas por 2
    if (k === j || k === s) continue;
    const p = j * n + k;
    if (!net.M[p]) continue;
    net.W[p] /= 2;
    net.F[p] /= 2; // E11: F divide-se como W (mantém h_j·(W+F) repartido por j e s)
    net.M[s * n + k] = 1;
    net.W[s * n + k] = net.W[p];
    net.F[s * n + k] = net.F[p];
  }
  for (let i = 0; i < nOut; i++) { // saídas para o readout divididas por 2
    const p = j * nOut + i;
    if (!net.M_out[p]) continue;
    net.W_out[p] /= 2;
    net.M_out[s * nOut + i] = 1;
    net.W_out[s * nOut + i] = net.W_out[p];
  }
  return true;
}

// perturbWeights: escolhe 1 a 4 pesos COM MÁSCARA ATIVA (sorteando entre W_in, W, W_out, b, b_out)
// e soma ruído gaussiano N(0, 0.25) (σ = 0.25; Box-Muller a partir de rng.next()).
// É a única op que altera pesos existentes: torna funcionais as ligações nascidas a 0.
// Entradas mascaradas nunca são tocadas (invariante M=0 ⇒ W=0 mantém-se); b segue os vivos.
function perturbWeights(net, rng) {
  const n = net.nSlots;
  const pools = [[], [], [], [], []]; // W_in | W | W_out | b | b_out
  for (let k = 0; k < net.M_in.length; k++) if (net.M_in[k]) pools[0].push(k);
  for (let k = 0; k < net.M.length; k++) if (net.M[k]) pools[1].push(k);
  for (let k = 0; k < net.M_out.length; k++) if (net.M_out[k]) pools[2].push(k);
  for (let j = 0; j < n; j++) if (net.alive[j]) pools[3].push(j);
  for (let i = 0; i < net.nOut; i++) pools[4].push(i);
  const targets = [];
  const nPick = 2 + rndInt(rng, 5); // E10: 2 a 6 pesos por perturbação (espaço maior)
  for (let t = 0; t < nPick; t++) {
    const nonEmpty = [];
    for (let a = 0; a < pools.length; a++) if (pools[a].length) nonEmpty.push(a);
    if (!nonEmpty.length) break;
    const a = nonEmpty[rndInt(rng, nonEmpty.length)];
    const arr = pools[a];
    const pos = rndInt(rng, arr.length);
    targets.push([a, arr[pos]]);
    arr.splice(pos, 1); // sem repetição
  }
  if (!targets.length) return false;
  for (const [a, idx] of targets) {
    let u1 = rng.next();
    if (u1 <= 0) u1 = Number.MIN_VALUE;
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * rng.next());
    const noise = 0.35 * z; // E10: sigma 0.35 (mais exploração)
    if (a === 0) net.W_in[idx] += noise;
    else if (a === 1) net.W[idx] += noise;
    else if (a === 2) net.W_out[idx] += noise;
    else if (a === 3) net.b[idx] += noise;
    else net.b_out[idx] += noise;
  }
  return true;
}

// EMENDA v5/E12: addMemoryNeuron — neurónio de MEMÓRIA de trabalho (célula com atividade
// persistente; "novos neurónios para memórias novas", Deng 2010 / Aimone; Butz & van Ooyen 2009).
// Semântica: 1 input→novo (U(-s,s) com s por E10) + autoconexão forte + leak baixo:
//   · autoconexão forte: M[s][s]=1, W[s][s]=0.85;
//   · leak forçado baixo: alphaJ[s]=0.05 (quase sem vazamento ⇒ atividade persistente).
// v7 (reorientação): a memória de trabalho liga-se RECORRENTEMENTE aos neurónios de
// DECISÃO nos dois sentidos —
//   · saída s→d para uma unidade de decisão (d U(-0.3,0.3), E6): a memória influencia a
//     decisão (mantém-se exatamente 1 ligação de saída além da autoconexão);
//   · entrada d'→s a partir de uma unidade de decisão: a célula de memória recebe a
//     atividade de decisão e a sinapse rápida F sobre ligações a decisões regista o
//     histórico (cadeia decisão → sinapse → memória).
// Fallback (só sem unidades de decisão, caso raro — o slot 0 é sempre uma): a saída vai
// para o readout ou para um neurónio vivo, como na E12 original.
// Cresce capacidade sozinho (ensureCapacity) como addNeuron.
function addMemoryNeuron(net, rng) {
  let dead = deadList(net);
  if (!dead.length) {
    if (!ensureCapacity(net, 1)) return false;
    dead = deadList(net);
    if (!dead.length) return false; // defesa: ensureCapacity garante ≥1 livre
  }
  const n = net.nSlots;
  const s = dead[rndInt(rng, dead.length)];
  clearSlot(net, s);
  net.alive[s] = 1;
  const k = rndInt(rng, net.nIn);
  net.M_in[k * n + s] = 1;
  net.W_in[k * n + s] = (rng.next() - 0.5) * 2 * Math.min(0.5, 1 / Math.sqrt(net.nIn)); // E10
  const dec = decisionList(net, s); // v7: unidades de decisão (alimentam o readout)
  if (dec.length) {
    const j = dec[rndInt(rng, dec.length)];
    net.M[s * n + j] = 1; // saída recorrente para uma unidade de DECISÃO
    net.W[s * n + j] = (rng.next() - 0.5) * 0.6; // E6: U(-0.3, 0.3)
    const src = dec[rndInt(rng, dec.length)];
    net.M[src * n + s] = 1; // entrada recorrente DE uma unidade de DECISÃO
    net.W[src * n + s] = (rng.next() - 0.5) * 0.6; // E6: U(-0.3, 0.3)
  } else if (rng.next() < 0.5) {
    const i = rndInt(rng, net.nOut);
    net.M_out[s * net.nOut + i] = 1;
    net.W_out[s * net.nOut + i] = (rng.next() - 0.5) * 0.6; // E6: U(-0.3, 0.3)
  } else {
    const al = aliveList(net, s);
    const j = al[rndInt(rng, al.length)];
    net.M[s * n + j] = 1;
    net.W[s * n + j] = (rng.next() - 0.5) * 0.6; // E6: U(-0.3, 0.3)
  }
  net.M[s * n + s] = 1; // autoconexão forte + leak baixo = memória de trabalho
  net.W[s * n + s] = 0.85;
  net.alphaJ[s] = 0.05;
  return true;
}

const OPS = {
  addNeuron,
  addConn,
  removeConn,
  rewire,
  pruneNeuron,
  changeLeak,
  splitNeuron,
  perturbWeights,
  addMemoryNeuron,
};

// Aplica uma operação; devolve true se aplicada. Nunca destrói o caminho input→output
// (slot 0 nunca morre nem perde as suas ligações de entrada/saída).
// E16: SEMPRE que uma op corre (aplicada ou não) o cache de máscaras é invalidado — as
// ops podem ter tocado em M/M_in/M_out (clearSlot, addConn, rewire, splitNeuron...) e o
// update de F tem de voltar a iterar exatamente os índices mascarados atuais.
export function applyOp(net, opName, rng) {
  const op = OPS[opName];
  if (!op) return false;
  let ok = false;
  try {
    ok = op(net, rng);
  } finally {
    invalidateMaskCache(net);
  }
  return ok;
}

// Banco adaptativo: adaptive pursuit (Thierens 2005). P_min = 0.05, β = 0.3.
// q_i ← (1−β)·q_i + β·recompensa (só a operação escolhida);
// p persegue os alvos: melhor op → P_max = 1−(K−1)·P_min, restantes → P_min.
// Σp = 1 e p_i ≥ P_min são invariantes do processo.
//
// EMENDA v5/E12: setBias(obj) — obj mapeia opName → multiplicador (≥ 0). pick() amostra
// com probabilidades p_i·bias_i renormalizadas MANTENDO o piso P_min (repartição water-
// filling: a massa em défice é retirada proporcionalmente aos excedentes). Sem bias ativo
// (todos 1) a distribuição é exatamente p (comportamento do adaptive pursuit intacto).
// setBias({}) REPOE (todos os multiplicadores a 1). stats() inclui o bias ativo por op.
export function makeOperatorBank(rng) {
  const n = OP_NAMES.length;
  const P_MIN = 0.05;
  const BETA = 0.3;
  const q = new Float64Array(n);
  const p = new Float64Array(n);
  const count = new Array(n).fill(0);
  const bias = new Float64Array(n).fill(1); // E12: multiplicadores de probabilidade
  const eff = new Float64Array(n); // buffer da distribuição efetiva de amostragem
  for (let i = 0; i < n; i++) p[i] = 1 / n;

  // Distribuição efetiva de amostragem (ver nota acima). Devolve `eff` (buffer interno).
  function effProbs() {
    let sum = 0;
    for (let i = 0; i < n; i++) { eff[i] = p[i] * bias[i]; sum += eff[i]; }
    if (!(sum > 0)) { for (let i = 0; i < n; i++) eff[i] = 1 / n; return eff; }
    for (let i = 0; i < n; i++) eff[i] /= sum; // renormalizado
    for (let iter = 0; iter < 8; iter++) { // piso P_min preservado (water-filling)
      let deficit = 0;
      let surplus = 0;
      for (let i = 0; i < n; i++) {
        if (eff[i] < P_MIN) deficit += P_MIN - eff[i];
        else surplus += eff[i] - P_MIN;
      }
      if (deficit <= 1e-15) break;
      if (!(surplus > 0)) { for (let i = 0; i < n; i++) eff[i] = 1 / n; break; }
      for (let i = 0; i < n; i++) {
        eff[i] = eff[i] < P_MIN ? P_MIN : eff[i] - (eff[i] - P_MIN) * (deficit / surplus);
      }
    }
    return eff;
  }

  return {
    pick() {
      const e = effProbs();
      let r = rng.next();
      for (let i = 0; i < n; i++) {
        r -= e[i];
        if (r <= 0) return OP_NAMES[i];
      }
      return OP_NAMES[n - 1];
    },
    update(opName, reward) {
      const i = OP_NAMES.indexOf(opName);
      if (i < 0) return;
      count[i]++;
      q[i] = (1 - BETA) * q[i] + BETA * Math.max(0, reward);
      let best = 0;
      for (let k = 1; k < n; k++) if (q[k] > q[best]) best = k;
      const pMax = 1 - (n - 1) * P_MIN;
      for (let k = 0; k < n; k++) p[k] += BETA * ((k === best ? pMax : P_MIN) - p[k]);
    },
    // E12: multiplica probabilidades por `obj` (opName → multiplicador ≥ 0) e renormaliza
    // preservando P_min. Chaves desconhecidas são ignoradas; {} repõe tudo a 1.
    setBias(obj) {
      for (let i = 0; i < n; i++) bias[i] = 1;
      for (const name of Object.keys(obj ?? {})) {
        const i = OP_NAMES.indexOf(name);
        if (i < 0) continue;
        const m = Number(obj[name]);
        if (!Number.isFinite(m) || m < 0) throw new RangeError('setBias: multiplicador inválido para ' + name);
        bias[i] = m;
      }
    },
    probs() {
      return Float32Array.from(effProbs());
    },
    stats() {
      const out = {};
      for (let i = 0; i < n; i++) out[OP_NAMES[i]] = { p: p[i], q: q[i], count: count[i], bias: bias[i] };
      return out;
    },
  };
}
