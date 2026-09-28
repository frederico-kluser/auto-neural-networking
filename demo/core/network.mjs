// Rede sem camadas: slots de neurónios com dinâmica leaky-tanh (CONTRACTS.md §core/network.mjs).
// Convenção de índices: W/M usam M[i*nSlots+j] = ligação i→j; W_in[k*nSlots+j] = input k→neurónio j;
// W_out[j*nOut+i] = neurónio j→output i. Invariante: M === 0 ⇒ W === 0 (idem M_in/M_out).
//
// EMENDA v5/E11: sinapses RÁPIDAS Hebbianas (fast weights, Ba et al. 2016). `F` é uma
// matriz nSlots×nSlots com a mesma convenção de índices de W: F[i*nSlots+j] só é relevante
// onde M[i*nSlots+j]===1 (invariante: M===0 ⇒ F===0). Por tick, o drive recorrente usa o
// peso efetivo W+F e, DEPOIS de calcular h, F_ij ← clip(λ·F_ij + η·h_i·h_j, ±2).
// F é estado do EPISÓDIO corrente: resetNet zera-a ("a memória é do episódio corrente").
//
// EMENDA v5/E12: alphaJ (Float64Array(nSlots)) — vazamento POR NEURÓNIO; 0 = usar
// net.alpha (default). O neurónio de memória (ops.addMemoryNeuron) força alphaJ=0.05.
//
// EMENDA v6/E16 (memória com horizonte certo + performance):
//   · makeNetwork aceita `memoryHorizon` (ticks) e deriva fastLambda = exp(−1/H);
//     um `fastLambda` explícito tem SEMPRE prioridade (compatibilidade E11, default 0.92).
//   · O update de F itera APENAS sobre a lista CACHE de índices (i,j) mascarados
//     (reconstruída quando M muda — ops chamam invalidateMaskCache; resetNet e
//     ensureCapacity também; deteta-se ainda realocação de M por identidade).
//     O somatório recorrente usa o MESMO cache (ordem de acumulação por coluna idêntica
//     ao loop ingénuo ⇒ resultados bitwise idênticos).
//
// REORIENTAÇÃO v7 (2026-09-27, do utilizador) — MEMÓRIA QUE SE CONSTRÓI SOZINHA:
//   · Só existem as 12 entradas nomeadas (o modo 'mapa'/'ambos' está extinto na demo);
//     aqui mantém-se apenas a mecânica interna, sem nada que dependa do mapa.
//   · As sinapses registam o HISTÓRICO DE DECISÕES. Unidade de DECISÃO = neurónio vivo
//     que alimenta o readout (alguma M_out[j][i]===1) — "o h que alimenta o readout conta
//     como decisão". Com d_j = dec_j·h_j a regra de F passa a:
//       F_ij ← clip(λ·F_ij + η·(h_i·h_j + h_i·d_j + d_i·h_j), ±2)
//     (= η·h_i·h_j·(1 + dec_i + dec_j): cada sinapse que toca numa unidade de decisão
//     acumula também atividade-decisão; sinapses entre não-decisão mantêm a regra E11).
//   · Cadeia "decisão → sinapse → memória": a decisão (h que alimenta o readout) co-ativa
//     as sinapses (termo h_i·d_j / d_i·h_j em F) e a sinapse guarda essa co-ocorrência
//     durante ~H ticks (λ = exp(−1/H)); addConn/addNeuron/addMemoryNeuron MUDAM a
//     topologia (a sinapse "surge"), perturbWeights ativa pesos nascidos a 0 e o F torna
//     a ligação funcional de imediato — ver ops.mjs.
//   · step() defende entradas em falta (inputArr[k] === undefined ⇒ 0), para que redes
//     guardadas com outra aritmética de entradas nunca infecionem o estado com NaN.

export const MAX_SLOTS = 256;

// PRNG interno (mulberry32) só para a inicialização determinística a partir de `seed`.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * EMENDA v6/E16: `memoryHorizon` (ticks) deriva `fastLambda = exp(−1/memoryHorizon)`.
 * Precedência EXATA: (1) `fastLambda` explícito ganha sempre (compatibilidade);
 * (2) `memoryHorizon` finito > 0 ⇒ λ = exp(−1/H); (3) caso contrário default E11 (0.92).
 */
export function makeNetwork({ nInputs = 12, nOutputs = 4, seed = 1, nSlots = 32, fastOn = true, memoryHorizon, fastLambda } = {}) {
  const nIn = Math.max(1, Math.floor(nInputs));
  const nOut = Math.max(1, Math.floor(nOutputs));
  const cap = Math.min(MAX_SLOTS, Math.max(1, Math.floor(nSlots)));
  let lam = 0.92;
  if (fastLambda !== undefined) lam = fastLambda;
  else if (memoryHorizon !== undefined && Number.isFinite(memoryHorizon) && memoryHorizon > 0) lam = Math.exp(-1 / memoryHorizon);
  const net = {
    nIn,
    nOut,
    nSlots: cap,
    alive: new Uint8Array(cap),
    W: new Float64Array(cap * cap),
    M: new Uint8Array(cap * cap),
    b: new Float64Array(cap),
    alpha: 0.25,
    alphaJ: new Float64Array(cap), // E12: 0 = usar net.alpha; ver cabeçalho
    h: new Float64Array(cap),
    W_in: new Float64Array(nIn * cap),
    M_in: new Uint8Array(nIn * cap),
    W_out: new Float64Array(cap * nOut),
    M_out: new Uint8Array(cap * nOut),
    b_out: new Float64Array(nOut),
    // E11: pesos rápidos (memória estrutural do episódio corrente)
    F: new Float64Array(cap * cap),
    fastLambda: lam,
    fastEta: 0.35,
    fastOn: fastOn !== false, // defeito: LIGADO, salvo opts.fastOn === false
  };
  net.alive[0] = 1;
  const rand = mulberry32(seed);
  // Arranque minimalista: todos os inputs → neurónio 0 → todos os outputs.
  // E10: escala 1/sqrt(nIn) (limite 0.5) para NÃO saturar a tanh quando há muitas entradas
  // (com nIn=61, U(-0.5,0.5) dava drive ~N(0, 2.3) e a rede nascia morta).
  const inScale = Math.min(0.5, 1 / Math.sqrt(nIn));
  for (let k = 0; k < nIn; k++) {
    const p = k * cap; // coluna 0
    net.M_in[p] = 1;
    net.W_in[p] = (rand() - 0.5) * 2 * inScale;
  }
  for (let i = 0; i < nOut; i++) {
    net.M_out[i] = 1; // linha 0
    net.W_out[i] = rand() - 0.5;
  }
  return net;
}

// ── EMENDA v6/E16: cache das máscaras (índices mascarados + máscara de decisão) ──
// O update de F e o somatório recorrente iteram SÓ os índices (i,j) com M=1 guardados
// em `net._masks.rec`; o drive itera só os (k,j) com M_in=1 (`net._masks.inp`); a
// regra v7 de F usa `net._masks.dec` (1 = unidade de decisão, alimenta o readout).
// O cache é invalidado por invalidateMaskCache(net) — chamado por ops.mjs (applyOp),
// resetNet e ensureCapacity — e reconstruído preguiçosamente no próximo step().
// Mutação DIRETA de M/M_in/M_out fora daí exige invalidateMaskCache(net) explícito
// (a identidade dos typed arrays deteta realocação, não escritas no lugar).
function masksOf(net) {
  const m = net._masks;
  if (m && m.M === net.M && m.M_in === net.M_in && m.M_out === net.M_out && m.n === net.nSlots) return m;
  const n = net.nSlots;
  const rec = [];
  for (let p = 0; p < net.M.length; p++) if (net.M[p]) rec.push(p);
  const inp = [];
  for (let p = 0; p < net.M_in.length; p++) if (net.M_in[p]) inp.push(p);
  const dec = new Uint8Array(n); // v7: 1 = alimenta o readout (unidade de DECISÃO)
  for (let j = 0; j < n; j++) {
    const row = j * net.nOut;
    for (let i = 0; i < net.nOut; i++) {
      if (net.M_out[row + i]) { dec[j] = 1; break; }
    }
  }
  const built = { rec: Int32Array.from(rec), inp: Int32Array.from(inp), dec, M: net.M, M_in: net.M_in, M_out: net.M_out, n };
  net._masks = built;
  return built;
}

// Invalida o cache de máscaras (E16). Chamar sempre que M/M_in/M_out mudarem por fora
// de applyOp/ensureCapacity/resetNet. Idempotente e segura em qualquer objeto net.
export function invalidateMaskCache(net) {
  if (net) net._masks = null;
}

// EMENDA v2/E1: garante `need` slots livres, crescendo nSlots sozinho (duplicação, mínimo
// nSlots+16, teto MAX_SLOTS). O crescimento REALOCA com migração de stride — cada elemento
// W[i*old+j] → W'[i*new+j] (idem M e F, E11), W_in[k*old+j] → W_in'[k*new+j]; W_out/M_out têm stride
// nOut (inalterado), por isso as linhas 0..old-1 copiam-se tal e qual. Os slots novos nascem
// zerados (alive=0), logo a invariante M=0 ⇒ W=0 sobrevive. false SÓ quando nSlots===MAX_SLOTS
// e ainda não há `need` livres; caso contrário true.
export function ensureCapacity(net, need = 1) {
  let aliveCount = 0;
  for (let j = 0; j < net.nSlots; j++) if (net.alive[j]) aliveCount++;
  while (net.nSlots - aliveCount < need) {
    if (net.nSlots >= MAX_SLOTS) return false;
    const old = net.nSlots;
    const n = Math.min(MAX_SLOTS, Math.max(old * 2, old + 16));
    const alive = new Uint8Array(n);
    alive.set(net.alive);
    const W = new Float64Array(n * n);
    const M = new Uint8Array(n * n);
    for (let i = 0; i < old; i++) { // linhas i: old colunas → stride novo n
      W.set(net.W.subarray(i * old, i * old + old), i * n);
      M.set(net.M.subarray(i * old, i * old + old), i * n);
    }
    // E11: F migra com EXATAMENTE a mesma regra de stride que W — com F a zeros a
    // migração é bitwise-idêntica (zeros) e com F não-zero preserva os valores exatos.
    const F = new Float64Array(n * n);
    if (net.F) {
      for (let i = 0; i < old; i++) {
        F.set(net.F.subarray(i * old, i * old + old), i * n);
      }
    }
    const h = new Float64Array(n);
    h.set(net.h);
    const b = new Float64Array(n);
    b.set(net.b);
    const alphaJ = new Float64Array(n); // E12: leak por neurónio (0 = net.alpha)
    if (net.alphaJ) alphaJ.set(net.alphaJ);
    const W_in = new Float64Array(net.nIn * n);
    const M_in = new Uint8Array(net.nIn * n);
    for (let k = 0; k < net.nIn; k++) {
      W_in.set(net.W_in.subarray(k * old, k * old + old), k * n);
      M_in.set(net.M_in.subarray(k * old, k * old + old), k * n);
    }
    const W_out = new Float64Array(n * net.nOut); // stride nOut inalterado: prefixo copia-se
    W_out.set(net.W_out);
    const M_out = new Uint8Array(n * net.nOut);
    M_out.set(net.M_out);
    net.nSlots = n;
    net.alive = alive;
    net.W = W;
    net.M = M;
    net.F = F;
    net.h = h;
    net.b = b;
    net.alphaJ = alphaJ;
    net.W_in = W_in;
    net.M_in = M_in;
    net.W_out = W_out;
    net.M_out = M_out;
    invalidateMaskCache(net); // E16: stride novo ⇒ índices em cache inválidos
  }
  return true;
}

export function resetNet(net) {
  net.h.fill(0);
  if (net.F) net.F.fill(0); // E11: a memória rápida é do episódio corrente — zera sempre
  invalidateMaskCache(net); // E16: robustez contra escritas diretas em M entre episódios
  return net;
}

export function step(net, inputArr) {
  const { nIn, nOut, nSlots: n, alive, W, M, b, alpha, alphaJ, h, W_in, M_in, W_out, M_out, b_out, F } = net;
  // E11: sinapses rápidas só quando ligadas (modo 'mapa' legado desligava-as).
  const useFast = net.fastOn !== false && !!F;
  const masks = masksOf(net); // E16/v7: cache de índices mascarados + máscara de decisão
  // Buffers de trabalho persistentes (E18: zero alocação por tick).
  const drive = net._drive && net._drive.length === n ? net._drive : (net._drive = new Float64Array(n));
  const rec0 = net._rec && net._rec.length === n ? net._rec : (net._rec = new Float64Array(n));
  // drive_j = Σ_k in[k]·W_in[k][j]·M_in[k][j] + b_j (só j vivo). A ordem de soma por j
  // (b_j primeiro, k crescente depois) é a do contrato — bitwise idêntica ao loop ingénuo.
  for (let j = 0; j < n; j++) drive[j] = alive[j] ? b[j] : 0;
  const inp = masks.inp;
  for (let c = 0; c < inp.length; c++) {
    const p = inp[c];
    const j = p % n;
    if (!alive[j]) continue;
    const k = (p / n) | 0;
    const v = inputArr[k];
    if (v === undefined) continue; // v7: entradas em falta contam como 0 (sem NaN)
    drive[j] += v * W_in[p];
  }
  // Soma recorrente sobre o h ANTIGO, só entradas mascaradas (W+F quando useFast).
  // Acumulação em ordem de i crescente por coluna ⇒ idêntica ao loop ingénuo.
  const rec = masks.rec;
  for (let j = 0; j < n; j++) rec0[j] = 0;
  for (let c = 0; c < rec.length; c++) {
    const p = rec[c];
    const i = (p / n) | 0;
    const j = p - i * n;
    rec0[j] += h[i] * (useFast ? W[p] + F[p] : W[p]);
  }
  // Atualização síncrona in-place: cada j só lê o SEU h antigo (r e drive já são finais).
  for (let j = 0; j < n; j++) {
    if (!alive[j]) { h[j] = 0; continue; }
    const a = alphaJ && alphaJ[j] > 0 ? alphaJ[j] : alpha; // E12: leak por neurónio (0 = net.alpha)
    h[j] = (1 - a) * h[j] + a * Math.tanh(rec0[j] + drive[j]);
  }
  // E11+v7: atualização Hebbiana das sinapses rápidas DEPOIS de calcular h (usa o h novo),
  // só nas entradas mascaradas. v7: a regra inclui a atividade das unidades de DECISÃO
  // d_k = dec_k·h_k — F_ij ← clip(λ·F_ij + η·(h_i·h_j + h_i·d_j + d_i·h_j), ±2).
  if (useFast) {
    const lam = net.fastLambda;
    const eta = net.fastEta;
    const dec = masks.dec;
    for (let c = 0; c < rec.length; c++) {
      const p = rec[c];
      const i = (p / n) | 0;
      const j = p - i * n;
      const hi = h[i];
      const hj = h[j];
      const di = dec[i] ? hi : 0;
      const dj = dec[j] ? hj : 0;
      const v = lam * F[p] + eta * (hi * hj + hi * dj + di * hj);
      F[p] = v > 2 ? 2 : v < -2 ? -2 : v;
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

export function cloneNet(net) {
  return {
    nIn: net.nIn,
    nOut: net.nOut,
    nSlots: net.nSlots,
    alive: net.alive.slice(),
    W: net.W.slice(),
    M: net.M.slice(),
    F: net.F ? net.F.slice() : new Float64Array(net.nSlots * net.nSlots), // E11: cópia profunda
    b: net.b.slice(),
    alpha: net.alpha,
    alphaJ: net.alphaJ ? net.alphaJ.slice() : new Float64Array(net.nSlots), // E12
    h: net.h.slice(),
    W_in: net.W_in.slice(),
    M_in: net.M_in.slice(),
    W_out: net.W_out.slice(),
    M_out: net.M_out.slice(),
    b_out: net.b_out.slice(),
    fastLambda: net.fastLambda, // E11: parâmetros rápidos copiados
    fastEta: net.fastEta,
    fastOn: net.fastOn,
    // E16: o cache de máscaras NÃO é copiado — reconstrói-se preguiçosamente por clone.
  };
}

export function countNeurons(net) {
  let c = 0;
  for (let j = 0; j < net.nSlots; j++) if (net.alive[j]) c++;
  return c;
}

export function countConns(net) {
  let c = 0;
  for (let k = 0; k < net.M.length; k++) if (net.M[k]) c++;
  return c;
}

// Raio espectral de W⊙M por iteração de potência (40 iterações; 0 para matrizes degeneradas).
// EMENDA v5/E11: opera sobre W APENAS. F (sinapses rápidas) fica deliberadamente de fora:
// é dinâmica rápida do episódio corrente e não um peso estrutural estável — o termostato
// espectral regula a estabilidade dos pesos lentos; clip(±2) limita F no step().
export function spectralRadius(net) {
  const n = net.nSlots;
  const { W, M } = net;
  const v = new Float64Array(n);
  const s = 1 / Math.sqrt(n);
  for (let i = 0; i < n; i++) v[i] = s;
  const w = new Float64Array(n);
  let lambda = 0;
  for (let it = 0; it < 40; it++) {
    w.fill(0);
    for (let i = 0; i < n; i++) {
      const vi = v[i];
      if (vi === 0) continue;
      const row = i * n;
      for (let j = 0; j < n; j++) {
        const p = row + j;
        if (M[p]) w[j] += vi * W[p];
      }
    }
    let norm = 0;
    for (let j = 0; j < n; j++) norm += w[j] * w[j];
    norm = Math.sqrt(norm);
    if (norm === 0 || !Number.isFinite(norm)) return 0;
    for (let j = 0; j < n; j++) v[j] = w[j] / norm;
    lambda = norm;
  }
  return lambda;
}

// Termostato espectral: se ρ̂ > target, escala as ligações W onde M=1 por target/ρ̂.
// Devolve a estimativa FINAL de ρ (reavaliada após o escalamento).
// EMENDA v5/E11: escala SOMENTE W — nunca toca em F (ver nota em spectralRadius).
export function spectralThermostat(net, target = 0.95) {
  let rho = spectralRadius(net);
  if (rho > target) {
    const c = target / rho;
    const { W, M } = net;
    for (let k = 0; k < M.length; k++) if (M[k]) W[k] *= c;
    rho = spectralRadius(net);
  }
  return rho;
}
