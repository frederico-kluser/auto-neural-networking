// Episódios e neuroevolução (CONTRACTS.md §core/evolution.mjs + EMENDA v6 E15-E18
// + REORIENTAÇÃO v7).
// Dependências declaradas: ./network.mjs, ./ops.mjs, ./maze.mjs (DIR_VEC, generateMaze),
// ./sensors.mjs (sense, senseInto).
//
// REORIENTAÇÃO v7 (2026-09-27, do utilizador): os modos de memória com MAPA ('mapa'/
// 'ambos') estão EXTINTOS na demo — runEpisode/evaluate/evolve usam SEMPRE as 12
// entradas nomeadas (memoryMode 'sinapses' fixo; `opts.memoryMode`/`config.memoryMode`
// continuam a ser aceites por compatibilidade mas são ignorados). A memória constrói-se
// sozinha na rede: sinapses estruturais (addConn/addNeuron/addMemoryNeuron) + sinapses
// rápidas F que registam o histórico de decisões (ver network.mjs/ops.mjs v7).

import { makeNetwork, resetNet, step, cloneNet, countNeurons, countConns } from './network.mjs';
import { applyOp, makeOperatorBank } from './ops.mjs';
import { DIR_VEC, generateMaze } from './maze.mjs';
import { sense, senseInto } from './sensors.mjs';

export const STEP_TICKS = 3;

// ── OPÇÃO B (2026-09-28) — deteção + punição + tentar outros caminhos ─────────
// Constantes EXATAS de demo/research/07 (fórmulas), 08 (Trémaux) e 09 (quebra ativa).
// Anti-loop vive SÓ no avaliador: o agente não ganha sensores novos (research 06 §3).
export const REV_C = 0.005;        // p(n) = −REV_C·min(REV_RHO^(n−2), REV_KAPPA), n-ésima visita (n≥2)
export const REV_RHO = 1.6;
export const REV_KAPPA = 8;        // piso por passo −0.04 (saturação)
export const P_MAX = 0.25;         // tecto DURO do acumulador de revisita/bump/reversões
export const PAIR_H = 0.002;       // reincidência de inversão por par ordenado de células
export const PAIR_CAP = 4;         // …saturando em 4× (0.008)
export const CYCLE_P0 = 0.02;      // volta confirmada r: CYCLE_P0·min(2^(r−1), 8)·cycleLen
export const CYCLE_LAP_CAP = 8;
export const CYCLE_EXIT_REPEATS = 4; // repeats ≥ 4 ⇒ fim antecipado como NÃO resolvido
export const BREAK_STEPS = 8;      // quebra ativa: k=8 passos com a 2.ª melhor direção
export const HYST_MARGIN = 0.08;   // histerese anti-período-2: 8% do intervalo (max−min) das saídas
export const NOVELTY_ALPHA = 0.005; // bónus de novidade α/√(n+1) por entrada
export const BONUS_CAP = 0.25;
export const SOLVED_FLOOR = 1.25;  // guarda lexicográfica: solved ≥ 1.25 …
export const UNSOLVED_CAP = 1.2;   // … > qualquer não resolvido ≤ 1.2
export const BUMP_PENALTY = -0.04; // batida em parede: mais cara que QUALQUER revisita (era −0.005)

// Modo LEGADO (opts.antiLoop === false, usado pelo probe A/B): penalidades planas antigas.
const LEGACY_REVISIT_PENALTY = -0.005;
const LEGACY_BUMP_PENALTY = -0.005;

/**
 * `revisitCharge(n)` — penalidade MARGINAL escalonada da n-ésima visita a uma célula
 * (n = contagem DEPOIS da entrada; n ≥ 2). Devolve o valor COM SINAL (≤ 0):
 *   p(n) = −0.005·min(1.6^(n−2), 8)   ⇒ p(2)=−0.005, p(3)=−0.008, …, p(≥10)=−0.04.
 * n < 2 (primeira visita) ⇒ 0. (research 07, mecanismo 2.1.)
 */
export function revisitCharge(n) {
  if (!(n >= 2)) return 0;
  return -REV_C * Math.min(REV_RHO ** (n - 2), REV_KAPPA);
}

// ── EMENDA v5/E13 + REORIENTAÇÃO v7 ───────────────────────────────────────────
// Tabela LEGADA (mantida por compatibilidade de imports); na demo só 'sinapses' corre:
// 12 entradas + sinapses rápidas (W+F) — a memória vive na rede. O episódio é fixo em
// 'sinapses'; as chaves 'mapa'/'ambos' documentam o comportamento antigo e não são usadas.
export const MEMORY_MODES = {
  sinapses: { withMap: false, fastOn: true },
  mapa: { withMap: true, fastOn: false },
  ambos: { withMap: true, fastOn: true },
};

// v7: SEMPRE 'sinapses' (12 entradas + sinapses rápidas). `opts.memoryMode` é ignorado.
function memoryModeOf() {
  return { name: 'sinapses', ...MEMORY_MODES.sinapses };
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

const manhattan = (ax, ay, bx, by) => Math.abs(ax - bx) + Math.abs(ay - by);

function countOpenCells(maze) {
  let c = 0;
  for (let y = 0; y < maze.rows; y++) {
    for (let x = 0; x < maze.cols; x++) if (!maze.isWall(x, y)) c++;
  }
  return c;
}

// ── EMENDA v6/E15: potencial BFS ──────────────────────────────────────────────

/**
 * `distanceField(maze) -> Int32Array(cols*rows)` — distância BFS até ao exit sobre
 * células ABERTAS (exit = 0; cada passo +1). Paredes e células abertas inalcançáveis
 * ficam a **−1**. As paredes BLOQUEIAM: a distância de uma célula é o comprimento do
 * caminho aberto mais curto até ao exit, não a distância de Manhattan.
 */
export function distanceField(maze) {
  const cols = maze.cols;
  const rows = maze.rows;
  const grid = maze.grid;
  const n = cols * rows;
  const dist = new Int32Array(n).fill(-1);
  const ei = maze.exit.y * cols + maze.exit.x;
  if (grid[ei] === 1) return dist; // defesa: exit fechado ⇒ tudo −1
  const q = new Int32Array(n);
  let head = 0;
  let tail = 0;
  dist[ei] = 0;
  q[tail++] = ei;
  while (head < tail) {
    const cur = q[head++];
    const cx = cur % cols;
    const cy = (cur / cols) | 0;
    const d = dist[cur] + 1;
    for (let k = 0; k < 4; k++) {
      const nx = cx + DIR_VEC[k][0];
      const ny = cy + DIR_VEC[k][1];
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      const ni = ny * cols + nx;
      if (grid[ni] === 1 || dist[ni] !== -1) continue;
      dist[ni] = d;
      q[tail++] = ni;
    }
  }
  return dist;
}

// Distâncias BFS + openCells PRÉ-CALCULADOS por labirinto (cache WeakMap: um labirinto
// é imutável, o campo serve todos os episódios que o usam — "per maze, precompute").
const MAZE_INFO = new WeakMap();
function mazeInfo(maze) {
  let info = MAZE_INFO.get(maze);
  if (!info) {
    info = { distField: distanceField(maze), openCells: countOpenCells(maze) };
    MAZE_INFO.set(maze, info);
  }
  return info;
}

/**
 * Fórmula canónica de fitness (EMENDA v6/E15 + OPÇÃO B). ATENÇÃO: `startDist`/`endDist`
 * são DISTÂNCIAS BFS (distanceField do labirinto) — NÃO Manhattan: o potencial BFS
 * não mente atrás de paredes (Ng et al. 1999).
 *   · resolvido: 1.5 + (1 − steps/maxSteps) + cobertura/bónus   …clamp ≥ 1.25 (guarda)
 *   · não resolvido: 2*(startDist − endDist)/startDist − steps*0.002 + cobertura/bónus
 *                                                              …clamp ≤ 1.2  (guarda)
 * OPÇÃO B (research 07 §2.3/D): quando `bonus` é um número FINITO, ele SUBSTITUI o
 * termo linear de cobertura (0.5/0.25·visited/openCells) nos DOIS ramos — é a soma de
 * novidade α/√(n+1) acumulada em runEpisode, clampada a +0.25. Escolha documentada:
 * "same bonus in both branches" (o termo linear 0.5 do solved era farmável por
 * ziguezague; research 07 §1.6c). Quando `bonus` é omitido, mantém-se a fórmula
 * LEGADA de cobertura (compatibilidade: validate.mjs e chamadas externas intactas).
 * GUARDA LEXICOGRÁFICA (07 §2.5): qualquer resolvido ≥ 1.25 > qualquer não resolvido
 * ≤ 1.2 — eliminando a inversão de ranking (o não resolvido chegava a ≈2.0).
 */
export function fitnessOf({ solved, steps, maxSteps, startDist, endDist, visited, openCells, bonus }) {
  const hasBonus = typeof bonus === 'number' && Number.isFinite(bonus);
  const extra = hasBonus
    ? Math.min(Math.max(bonus, 0), BONUS_CAP)
    : (openCells > 0 ? visited / openCells : 0);
  if (solved) {
    const v = 1.5 + (1 - steps / maxSteps) + (hasBonus ? extra : 0.5 * extra);
    return v < SOLVED_FLOOR ? SOLVED_FLOOR : v;
  }
  const progress = startDist > 0 ? 2 * (startDist - endDist) / startDist : 0;
  const v = progress - steps * 0.002 + (hasBonus ? extra : 0.25 * extra);
  return v > UNSOLVED_CAP ? UNSOLVED_CAP : v;
}

// ── OPÇÃO B: auxiliares puros (exportados para testes unitários) ──────────────

/**
 * `quantSig(buf)` — assinatura dos 12 sensores quantizada a 4 bits/valor (research 06-E),
 * hash FNV-1a de 32 bits. Usada pelo detetor anti-aliasing.
 */
export function quantSig(buf) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < 12; i++) {
    let q = (buf[i] * 16) | 0;
    if (q < 0) q = 0; else if (q > 15) q = 15;
    h = Math.imul(h ^ q, 16777619) >>> 0;
  }
  return h | 0;
}

/**
 * `verifyPeriod(trace, t, t0, p)` — confirmação de ciclo (research 06-B): compara os p
 * pares anteriores a `t` com os p anteriores a `t0`. Índices anteriores ao início do
 * traço são ignorados (comparação vazia = vacuamente verdadeira), o que permite
 * confirmar um período-2 já na 3.ª observação (ABAB) — regra literal de 06-B.
 */
export function verifyPeriod(trace, t, t0, p) {
  for (let i = 1; i <= p; i++) {
    const j = t0 - i;
    if (j < 0) continue;
    if (trace[t - i] !== trace[j]) return false;
  }
  return true;
}

/**
 * `pickDir(yOut, prevDir, open4, cell4, forceAlt, forbiddenCell)` — seleção de ação da
 * OPÇÃO B:
 *  · HISTERESE anti-período-2 (research 09-D): para trocar da ação anterior `prevDir`
 *    para a melhor `best`, a saída da melhor tem de superar a da anterior por uma margem
 *    de 8% do intervalo das saídas (max−min); caso contrário mantém-se `prevDir` —
 *    EXCETO se a ação anterior colidir com parede (aí salta-se a histerese).
 *  · QUEBRA ATIVA de ciclo (research 09-B): com `forceAlt`, força-se a 2.ª melhor
 *    direção (senão as restantes por ordem decrescente de saída), ignorando paredes e
 *    a célula `forbiddenCell` (a que iniciou o ciclo).
 * `open4[d]` = 1 se a célula-alvo da direção d é aberta; `cell4[d]` = índice da célula-alvo.
 * Sem alocações: os vetores são do chamador.
 */
export function pickDir(yOut, prevDir, open4, cell4, forceAlt = false, forbiddenCell = -1) {
  const n = yOut.length;
  const d0 = 0, d1 = 1, d2 = 2, d3 = 3; // nOut fixo = 4 (contrato)
  // ordem das direções por saída DESCENDENTE (empate: índice menor primeiro)
  const o = [d0, d1, d2, d3].slice(0, n);
  o.sort((a, b) => (yOut[b] - yOut[a]) || (a - b));
  if (forceAlt) {
    for (let k = 1; k < o.length; k++) {
      const d = o[k];
      if (!open4[d]) continue;
      if (cell4[d] === forbiddenCell) continue;
      return d;
    }
    for (let k = 1; k < o.length; k++) {
      const d = o[k];
      if (open4[d]) return d;
    }
    return o[0];
  }
  const best = o[0];
  if (prevDir == null || prevDir === best || prevDir < 0 || prevDir >= n) return best;
  const range = yOut[o[0]] - yOut[o[n - 1]];
  if (yOut[best] < yOut[prevDir] + HYST_MARGIN * range) {
    if (open4[prevDir]) return prevDir; // mantém a ação anterior (salvo colisão)
  }
  return best;
}

// Região "toda marcada 2×": a célula e todas as vizinhas abertas com visitCount ≥ 2
// (saída de beco totalmente explorado — backtracking legítimo, research 08-F/07-2.4a).
function leavingAllTwice(maze, visitCount, id) {
  const cols = maze.cols;
  const cx = id % cols;
  const cy = (id / cols) | 0;
  if (visitCount[id] < 2) return false;
  for (let k = 0; k < 4; k++) {
    const nx = cx + DIR_VEC[k][0];
    const ny = cy + DIR_VEC[k][1];
    if (nx < 0 || ny < 0 || nx >= maze.cols || ny >= maze.rows) continue;
    const ni = ny * cols + nx;
    if (maze.grid[ni] === 1) continue;
    if (visitCount[ni] < 2) return false;
  }
  return true;
}

export function runEpisode(net, maze, opts = {}) {
  const maxSteps = opts.maxSteps ?? maze.cols * maze.rows * 2;
  const trace = opts.trace === true;
  // OPÇÃO B ativa por defeito; `antiLoop: false` = modo LEGADO (probe A/B de controlo).
  const anti = opts.antiLoop !== false;
  // Gancho de testes/diagnóstico (aditivo): `opts.policy(yOut, ctx) => dir` substitui a
  // seleção de ação (histerese/quebra não se aplicam) — serve trajetórias sintéticas.
  const policy = typeof opts.policy === 'function' ? opts.policy : null;
  const mode = memoryModeOf(); // v7: SEMPRE 'sinapses' (12 entradas + sinapses rápidas)
  resetNet(net);
  net.fastOn = mode.fastOn; // v7: as sinapses rápidas ficam ligadas (modo fixo)
  const info = mazeInfo(maze); // E15: distField + openCells pré-calculados
  let x = maze.start.x;
  let y = maze.start.y;
  const exit = maze.exit;
  // E15: startDist/endDist vêm do campo BFS do labirinto. Defensivo (labirintos feitos
  // à mão com regiões inalcançáveis ⇒ −1): valores negativos caem para Manhattan.
  const sd = info.distField[maze.idx(x, y)];
  const startDist = sd >= 0 ? sd : manhattan(x, y, exit.x, exit.y);
  const nCells = maze.cols * maze.rows;
  // E2 → OPÇÃO B: `visitCount` (contagem Trémaux, research 07-A) substitui o bit
  // `visited`; qualquer valor > 0 conta como visitado em senseInto (Uint16: o episódio
  // tem ≤ maxSteps passos, longe do overflow).
  const visitCount = new Uint16Array(nCells);
  visitCount[maze.idx(x, y)] = 1;
  let visitedCount = 1;
  const path = [{ x, y }];
  const sensorTrace = trace ? [] : null;
  const buf = new Float32Array(12); // E18: senseInto — zero alocação por passo
  // ── OPÇÃO B: detetor de ciclos (research 06 §3-A/E) ─────────────────────────
  // Chave principal = (célula, ação) = idx*4 + dir; anti-aliasing = assinatura
  // quantizada dos 12 sensores + ação. Tabelas + traços por episódio.
  const keyTrace = new Int32Array(maxSteps + 1);
  const lastSeen = new Int32Array(nCells * 4).fill(-1);
  const sigTrace = new Int32Array(maxSteps + 1);
  const sigLast = new Map(); // espaço de hashes: Map evita array de 2^32
  const pairRev = new Map(); // inversões por par ordenado de células (07-2.4b)
  const open4 = new Uint8Array(4); // vetores reutilizados de pickDir
  const cell4 = new Int32Array(4);
  const ctx = { steps: 0, x: 0, y: 0, prevDir: null }; // para opts.policy (sem alloc/passo)
  let steps = 0;
  let solved = false;
  let penalty = 0; // revisita + bump + reversões (tecto duro −P_MAX; 07-2.1/2.5a)
  let penaltyCycle = 0; // voltas confirmadas (SEM tecto; guard lexicográfico no fim)
  let bonus = 0; // novidade α/√(n+1), tecto +BONUS_CAP (07-2.3)
  let revisits = 0;
  let bumps = 0;
  let reversals = 0;
  let cycleLen = 0;
  let repeats = 0;
  let aliased = false;
  let looped = false;
  let cycleDetectStep = 0; // passo (1-based) da 1.ª confirmação; 0 = nunca
  let breakLeft = 0; // quebra ativa: passos restantes (09-B)
  let breakCell = -1; // célula que iniciou o ciclo (proibida durante a quebra)
  let cellCycleSeen = false; // já houve confirmação por (célula, ação)?
  let prevDir = null;
  const actionTrace = new Uint8Array(maxSteps); // telemetria aditiva (métricas A/B)
  while (steps < maxSteps) {
    senseInto(buf, maze, x, y, visitCount); // v7: exatamente os 12 sinais (sem mapa)
    if (trace) sensorTrace.push(buf.slice()); // traço = cópia (o buffer é reutilizado)
    let yOut = null;
    for (let t = 0; t < STEP_TICKS; t++) yOut = step(net, buf);
    let dir;
    if (policy) {
      ctx.steps = steps; ctx.x = x; ctx.y = y; ctx.prevDir = prevDir;
      dir = policy(yOut, ctx) | 0;
    } else if (anti) {
      for (let d = 0; d < 4; d++) {
        const dv = DIR_VEC[d];
        const tx = x + dv[0];
        const ty = y + dv[1];
        const inside = tx >= 0 && ty >= 0 && tx < maze.cols && ty < maze.rows;
        open4[d] = inside && !maze.isWall(tx, ty) ? 1 : 0;
        cell4[d] = inside ? maze.idx(tx, ty) : -1;
      }
      dir = pickDir(yOut, prevDir, open4, cell4, breakLeft > 0, breakCell);
    } else {
      dir = 0;
      for (let i = 1; i < yOut.length; i++) if (yOut[i] > yOut[dir]) dir = i;
    }
    if (dir < 0 || dir >= DIR_VEC.length) dir = ((dir % 4) + 4) % 4;
    const cellFrom = maze.idx(x, y);
    const key = cellFrom * 4 + dir; // (célula, ação) — research 06-A
    actionTrace[steps] = dir;
    const t = steps; // índice 0-based do passo no traço
    steps++;
    const d = DIR_VEC[dir];
    const nx = x + d[0];
    const ny = y + d[1];
    if (maze.isWall(nx, ny)) {
      bumps++;
      penalty += anti ? BUMP_PENALTY : LEGACY_BUMP_PENALTY;
    } else {
      const isReversal = prevDir !== null && dir === (prevDir ^ 1); // pares opostos (0↔1, 2↔3) — ordem canónica CONTRACTS
      x = nx;
      y = ny;
      const id = maze.idx(x, y);
      const nPrior = visitCount[id];
      if (isReversal) reversals++; // métrica M3 (contada nos DOIS braços do A/B)
      if (anti) {
        // Bónus de novidade por ENTRADA (07-2.3): α/√(n+1) com n = contagem prévia
        // (n ≥ 0; a 1.ª entrada paga α — forma fechada da research 07 §2.3).
        bonus += NOVELTY_ALPHA / Math.sqrt(nPrior + 1);
        if (bonus > BONUS_CAP) bonus = BONUS_CAP;
      }
      if (nPrior > 0) {
        revisits++;
        if (anti) {
          // Revisita marginal escalonada (07-2.1): p(n) para a n-ésima visita (n ≥ 2).
          let charge = revisitCharge(nPrior + 1);
          if (isReversal) {
            const pairKey = cellFrom * nCells + id; // par ORDENADO (origem, destino)
            const m = (pairRev.get(pairKey) ?? 0) + 1;
            pairRev.set(pairKey, m);
            const trEmaux = nPrior === 1 || leavingAllTwice(maze, visitCount, cellFrom);
            if (m === 1 && trEmaux) {
              charge = 0; // Trémaux (07-2.4a/08-F): 1.ª devolução de beco é gratuita
            } else if (m > 1) {
              penalty += PAIR_H * Math.min(m, PAIR_CAP); // reincidência do par (07-2.4b)
            }
          }
          penalty += charge;
        } else {
          penalty += LEGACY_REVISIT_PENALTY;
        }
      }
      visitCount[id] = nPrior + 1;
      if (nPrior === 0) visitedCount++;
      if (x === exit.x && y === exit.y) solved = true;
    }
    if (breakLeft > 0) breakLeft--; // antes da deteção: não consome os passos recém-armados
    prevDir = dir;
    path.push({ x, y }); // antes da deteção: a saída antecipada inclui a posição final
    // ── deteção de ciclos (06-B/E) — corre sobre a chave do passo, mesmo em bump ──
    if (anti) {
      keyTrace[t] = key;
      const sigKey = (Math.imul(quantSig(buf), 4) + dir) | 0;
      sigTrace[t] = sigKey;
      const t0 = lastSeen[key];
      lastSeen[key] = t;
      const st0 = sigLast.has(sigKey) ? sigLast.get(sigKey) : -1;
      sigLast.set(sigKey, t);
      let confirmed = false;
      let aliasedHit = false;
      let p = 0;
      if (t0 >= 0) {
        p = t - t0;
        if (p >= 1 && verifyPeriod(keyTrace, t, t0, p)) {
          confirmed = true;
          cellCycleSeen = true;
        }
      }
      if (!confirmed && !cellCycleSeen && st0 >= 0) {
        // Anti-aliasing (06-E): a assinatura cicla mas o par (célula, ação) não.
        const sp = t - st0;
        if (sp >= 1 && verifyPeriod(sigTrace, t, st0, sp)) {
          confirmed = true;
          aliasedHit = true;
          p = sp;
        }
      }
      if (confirmed) {
        cycleLen = p;
        repeats++;
        if (aliasedHit) aliased = true;
        if (cycleDetectStep === 0) cycleDetectStep = steps; // passo 1-based da 1.ª
        // Volta confirmada r: −P0·min(2^(r−1), 8)·cycleLen (07-2.4c; CUSTO; SEM tecto —
        // a guarda lexicográfica é que garante solved ≥ 1.25).
        penaltyCycle -= CYCLE_P0 * Math.min(2 ** (repeats - 1), CYCLE_LAP_CAP) * cycleLen;
        // Quebra ativa (09-B): 8 passos com a 2.ª melhor direção; proíbe reentrar na
        // célula que iniciou o ciclo.
        breakLeft = BREAK_STEPS;
        breakCell = aliasedHit ? maze.idx(x, y) : ((keyTrace[Math.max(0, t - p)] / 4) | 0);
        if (repeats >= CYCLE_EXIT_REPEATS) {
          looped = true; // 07-2.4c: fim antecipado como NÃO resolvido
          break;
        }
      }
    }
    if (solved) break;
  }
  const ed = info.distField[maze.idx(x, y)];
  const endDist = ed >= 0 ? ed : manhattan(x, y, exit.x, exit.y); // medido na posição de rutura
  if (anti) {
    if (penalty < -P_MAX) penalty = -P_MAX; // tecto DURO da parte de revisita (07-2.5a)
  }
  const base = anti
    ? fitnessOf({ solved, steps, maxSteps, startDist, endDist, visited: visitedCount, openCells: info.openCells, bonus })
    : fitnessOf({ solved, steps, maxSteps, startDist, endDist, visited: visitedCount, openCells: info.openCells });
  let fitness = base + penalty + penaltyCycle;
  // GUARDA LEXICOGRÁFICA (07-2.5b): mesmo com penalidades de ciclo acima do tecto,
  // solved ≥ 1.25 > qualquer não resolvido ≤ 1.2 — SEMPRE.
  if (solved) {
    if (fitness < SOLVED_FLOOR) fitness = SOLVED_FLOOR;
  } else if (fitness > UNSOLVED_CAP) {
    fitness = UNSOLVED_CAP;
  }
  return {
    solved, steps, path, fitness, sensorTrace,
    // ── OPÇÃO B: telemetria aditiva (research 06-G/11) ────────────────────────
    looped, cycleLen, repeats, aliased, cycleDetectStep,
    penalty, penaltyCycle, bonus, revisits, bumps, reversals,
    visitedCells: visitedCount,
    actionTrace: actionTrace.subarray(0, steps),
  };
}

/**
 * `evaluate(net, mazes, opts)` — média de runEpisode(...).fitness sobre `mazes`.
 *
 * EMENDA v6/E18: `opts.mazePerGen === true` avalia cada indivíduo em UM SÓ labirinto
 * por chamada (≈3× mais rápido). A escolha é determinística e ROTATIVA: um cursor por
 * objeto `opts` (avaliações consecutivas da população avançam-no) percorre `mazes` em
 * round-robin, com offset inicial desenhado de `opts.rng` quando presente — todos os
 * mazes recebem cobertura garantida pela população e a sequência é igual para o mesmo
 * seed/ordem de chamadas. COM mazePerGen o fitness reportado é uma AMOSTRA por-labirinto
 * (a média da amostra de 1), usada SÓ para seleção; a verificação do campeão
 * (`solvedCount` sobre TODOS os mazes) mantém-se exata.
 */
export function evaluate(net, mazes, opts = {}) {
  if (opts.mazePerGen === true && mazes.length > 0) {
    if (opts._mpgCursor === undefined) {
      opts._mpgCursor = opts.rng && typeof opts.rng.next === 'function'
        ? Math.floor(opts.rng.next() * mazes.length) % mazes.length
        : 0;
    }
    const idx = opts._mpgCursor % mazes.length;
    opts._mpgCursor = (opts._mpgCursor + 1) % mazes.length;
    return runEpisode(net, mazes[idx], opts).fitness;
  }
  let sum = 0;
  for (const maze of mazes) sum += runEpisode(net, maze, opts).fitness;
  return sum / mazes.length;
}

// EMENDA v2/E4 (núcleo): quantos mazes o net resolve numa avaliação (o worker usa isto
// como critério de paragem "resolve TODOS os labirintos de treino"). SEMPRE exato:
// ignora opts.mazePerGen (é a verificação de campeão/nível de E17/E18).
export function solvedCount(net, mazes, opts = {}) {
  let solved = 0;
  for (const maze of mazes) if (runEpisode(net, maze, opts).solved) solved++;
  return { solved, total: mazes.length };
}

// ── EMENDA v6/E16: horizonte de memória por labirinto ─────────────────────────
/**
 * `memoryHorizonFor(maze)` — horizonte (ticks) por defeito para as sinapses rápidas:
 * H = min(800, max(60, 2*openCells)) (contrato E16). evolve/worker derivam daqui
 * `fastLambda = exp(−1/H)` por nível de curriculum (makeNetwork aceita `memoryHorizon`).
 */
export function memoryHorizonFor(maze) {
  return Math.min(800, Math.max(60, 2 * countOpenCells(maze)));
}

// ── EMENDA v6/E17: curriculum automático ──────────────────────────────────────

/**
 * `curriculumMazes(size, seeds = [1, 2, 3])` — labirintos de UM nível do curriculum,
 * determinísticos por seed (por defeito seeds 1..3, como no contrato E17: "os 3 do
 * nível atual"). Usado por evolve e reutilizável pelo worker.
 *
 * CORREÇÃO (2026-09-27, diagnóstico do agente de integração): seeds vizinhas geravam
 * layouts DUPLICADOS (ex.: 5×5 com seeds 1 e 2 = labirinto idêntico) e o(s) restante(s)
 * exigiam movimento oposto numa observação idêntica — a evolução seguia a maioria e
 * ficava presa a 2/3 para sempre. Aqui GARANTEM-SE LAYOUTS DISTINTOS por nível: cada
 * seed que repete layout é substituída por uma seed derivada determinística (LCG) até
 * o layout ser novo ou o espaço se esgotar (5×5 tem só 4 layouts possíveis — pedindo 3
 * há sempre 3 distintos). `seeds` é portanto uma SEMENTE de partida; os labirintos
 * devolvidos são determinísticos para as mesmas seeds de entrada.
 */
export function curriculumMazes(size, seeds = [1, 2, 3]) {
  const out = [];
  const seen = new Set();
  const layoutKey = (m) => m.grid.join(','); // identidade exata do layout (grelha)
  for (const base of seeds) {
    let s = base >>> 0;
    let maze = generateMaze(size, size, s);
    let key = layoutKey(maze);
    let retries = 0;
    while (seen.has(key) && retries < 256) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0; // derivada determinística (LCG)
      maze = generateMaze(size, size, s);
      key = layoutKey(maze);
      retries++;
    }
    // espaço de layouts esgotado (< pedidos): aceita duplicado (documentado)
    seen.add(key);
    out.push(maze);
  }
  return out;
}

function normalizeCurriculum(c) {
  const odd = (v, min) => {
    const n = Math.max(min, Math.floor(v));
    return n % 2 ? n : n + 1;
  };
  const startSize = odd(c.startSize ?? 5, 5);
  const targetSize = odd(c.targetSize, 5);
  if (!(targetSize >= startSize)) throw new RangeError('curriculum: targetSize >= startSize obrigatório');
  const mazeSeeds = Array.isArray(c.mazeSeeds) && c.mazeSeeds.length ? c.mazeSeeds.slice() : [1, 2, 3];
  return { startSize, targetSize, mazeSeeds };
}

// evolve({ population=60, generations=50, mazes, seed=1, elite=6, mutationRate=0.9,
//          memoryMode='sinapses' (IGNORADO — v7 fixa 'sinapses'),
//          curriculum={ targetSize, startSize=5, mazeSeeds? }, mazePerGen?, memoryHorizon?,
//          fastLambda?, burstBias?, burstGens? })
// Por geração: avaliar todos (E18: com curriculum usa-se `mazePerGen` por defeito, um
// labirinto rotativo por indivíduo), elitismo dos `elite` melhores, resto = cópias de
// elite + 1 a 3 ops de applyOp (banco adaptativo, uma op por sorteio) quando
// rng.next() < mutationRate. Recompensa do banco = max(0, fitness_filho − fitness_pai),
// creditada a cada op do filho.
// E12: estagnação do melhor global por 25 gerações ⇒ burst de neurogénese (setBias
// {addNeuron:2.5, addMemoryNeuron:3} por 50 gerações; configurável via
// config.burstBias/config.burstGens) e o resultado inclui `neurogenesisBursts`.
// E15/E17: cada geração verifica o campeão com solvedCount EXATO sobre todos os mazes
// do nível (stats.levelProgress) e o campeão global passa a ser escolhido com
// SEMÂNTICA solvedCount — E17: "when the global best net solves ALL mazes of the current
// level (use solvedCount semantics)" — ordenado por (mazes resolvidos, fitness); `best`
// mantém a semântica legacy (maior fitness amostrado, para curvas/estagnação). Em
// curriculum, campeão 100% ⇒ SUBIDA DE NÍVEL: mazes reconstruídos com LAYOUTS
// DISTINTOS no tamanho ímpar seguinte (até targetSize), POPULAÇÃO e BANCO mantidos
// (transferência) e burst de neurogénese. stats ganham `level` (tamanho do nível
// treinado), `levelProgress` ({solved,total}), `levelCount`, `promoted` ({from,to,gen}
// | null) e `population` (introspeção); o resultado ganha `finalLevel`.
// Sem curriculum o comportamento é o de sempre (mazes do chamador, sem promoções).
// Determinístico para o mesmo `seed`.
export function evolve(config = {}, hooks = {}) {
  const population = Math.max(2, Math.floor(config.population ?? 60));
  const generations = Math.max(1, Math.floor(config.generations ?? 50));
  const curriculum = config.curriculum ? normalizeCurriculum(config.curriculum) : null;
  const mazes0 = curriculum ? curriculumMazes(curriculum.startSize, curriculum.mazeSeeds) : config.mazes;
  if (!Array.isArray(mazes0) || !mazes0.length) throw new Error('evolve: config.mazes vazio');
  let mazes = mazes0;
  let levelSize = curriculum ? curriculum.startSize : mazes[0].cols; // v7/E17: nível = tamanho
  let levelCount = 1;
  const seed = config.seed ?? 1;
  const elite = Math.min(population, Math.max(1, Math.floor(config.elite ?? 6)));
  const mutationRate = config.mutationRate ?? 0.9;
  const nSlots = config.nSlots ?? 32;
  // v7: modo de memória FIXO 'sinapses' (config.memoryMode ignorado por reorientação).
  const mode = memoryModeOf();
  const epOpts = { memoryMode: mode.name };
  // E18: avaliação por amostra rotativa por defeito quando há curriculum ("per-generation
  // evaluation must use E18's rotating-maze option to stay fast"); config.mazePerGen
  // explícito tem prioridade. O cursor vive em evalOpts (determinístico por run).
  const evalOpts = { ...epOpts, mazePerGen: config.mazePerGen ?? !!curriculum };

  const rng = { next: mulberry32(seed) };
  evalOpts.rng = rng;
  const bank = makeOperatorBank(rng);
  let nextIdx = population;

  // EMENDA v4/E7 + v5/E13 + v7: nIn dinâmico DETETADO a partir do labirinto — sempre
  // os 12 sinais nomeados (comportamento antigo de acrescentar o mapa está extinto).
  const nInputs = sense(mazes[0], mazes[0].start.x, mazes[0].start.y, null, {}).length;

  // E16: horizonte de memória por nível; fastLambda explícito (config.fastLambda) ganha.
  const fastLambdaFor = (maze) => {
    if (config.fastLambda !== undefined) return config.fastLambda;
    return Math.exp(-1 / (config.memoryHorizon ?? memoryHorizonFor(maze)));
  };

  const pop = [];
  for (let i = 0; i < population; i++) {
    pop.push({
      idx: i,
      net: makeNetwork({
        nInputs,
        nOutputs: 4,
        seed: (seed * 1000003 + i * 7919 + 1) >>> 0,
        nSlots,
        fastOn: mode.fastOn,
        fastLambda: config.fastLambda,
        memoryHorizon: config.memoryHorizon ?? memoryHorizonFor(mazes[0]),
      }),
      fitness: NaN,
      mutOps: null,
      parentFitness: 0,
    });
  }

  const history = [];
  let best = -Infinity; // melhor fitness AMOSTRADO (semântica legacy das curvas)
  let bestNet = null; // CAMPEÃO por solvedCount-then-fitness (E17; refeito por nível)
  let champSolved = -1; // mazes do nível resolvidos pelo campeão atual (exato)
  let champFitness = -Infinity; // fitness do campeão atual (para desempate)
  let generationsRun = 0;

  // ── EMENDA v5/E12: neurogénese por estagnação (Cascade-Correlation, Fahlman &
  // Lebiere 1990; "novos neurónios para memórias novas", Deng 2010) ──────────────
  // Quando o MELHOR GLOBAL não melhora durante K gerações consecutivas, ativa-se um
  // burst de neurogénese: setBias por BURST_GENS gerações e depois limpa. Repetível
  // após OUTRA estagnação de K gerações. E17: uma subida de nível dispara o MESMO
  // tipo de burst (mais parâmetros configuráveis para probes: burstBias/burstGens).
  const STALL_K = 25;
  const BURST_GENS = Math.max(1, Math.floor(config.burstGens ?? 50));
  const NEUROGENESIS_BIAS = config.burstBias ?? { addNeuron: 2.5, addMemoryNeuron: 3 };
  let stallCount = 0; // gerações consecutivas sem melhoria do melhor global
  let stallAnchor = 0; // stallCount da última âncora (burst terminado/melhoria)
  let burstLeft = 0; // gerações de burst ainda ativas
  let neurogenesisBursts = 0;

  for (let gen = 1; gen <= generations; gen++) {
    const trainedLevel = levelSize;
    const trainedLevelCount = levelCount;
    let mean = 0;
    for (const ind of pop) {
      ind.fitness = evaluate(ind.net, mazes, evalOpts); // E18: com curriculum, 1 maze/chamada
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
    // (a) `best` = melhor fitness AMOSTRADO de sempre (semântica legacy: curvas e
    //     estagnação E12 — `improved` continua a comparar fitness puro).
    const improved = genBest.fitness > best;
    if (improved) {
      best = genBest.fitness;
    }
    // (b) CAMPEÃO global com SEMÂNTICA solvedCount — E17: "when the global best net
    //     solves ALL mazes of the current level (use solvedCount semantics)". Ordenado
    //     por (mazes resolvidos no nível, fitness) e verificado EXATAMENTE (todos os
    //     mazes). Candidatos por geração: top-3 amostrados + 3 SORTEADOS pelo rng
    //     (determinístico por seed). MEDIDO: (i) ordenar o campeão só por fitness
    //     satura a promoção (o campeão atinge o máximo teórico — ex.: 5×5, 4 passos,
    //     2.777 — resolvendo 1/3 e nenhum 3/3 o ultrapassa em fitness); (ii) verificar
    //     só os top-K amostrados deixa solucionadores 3/3 "escondidos" por baixo da
    //     multidão de solucionadores parciais (pop 100 travava); a amostragem aleatória
    //     de candidatos cobre a população toda em poucas gerações.
    const candIdx = [];
    const nTop = Math.min(3, ranked.length);
    for (let i = 0; i < nTop; i++) candIdx.push(i);
    for (let r = 0; r < Math.min(3, ranked.length - nTop); r++) candIdx.push(rndInt(rng, ranked.length));
    for (const ci of candIdx) {
      const cand = ranked[ci];
      const sc = solvedCount(cand.net, mazes, epOpts);
      if (sc.solved > champSolved || (sc.solved === champSolved && cand.fitness > champFitness)) {
        champSolved = sc.solved;
        champFitness = cand.fitness;
        bestNet = cloneNet(cand.net);
      }
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

    // E15/E17/E18: progresso do nível = verificação EXATA do campeão (solvedCount).
    const levelProgress = { solved: champSolved, total: mazes.length };
    let promoted = null;
    if (curriculum && champSolved >= mazes.length && levelSize < curriculum.targetSize) {
      promoted = { from: levelSize, to: Math.min(curriculum.targetSize, levelSize + 2), gen };
      levelSize = promoted.to;
      levelCount++;
      // E17: novos labirintos do tamanho seguinte; POPULAÇÃO e BANCO mantidos (transferência)
      // e burst de neurogénese como o da estagnação (E12).
      mazes = curriculumMazes(levelSize, curriculum.mazeSeeds);
      const lam = fastLambdaFor(mazes[0]); // E16: horizonte do NOVO nível
      for (const ind of pop) ind.net.fastLambda = lam;
      if (bestNet) bestNet.fastLambda = lam;
      bank.setBias(NEUROGENESIS_BIAS);
      burstLeft = BURST_GENS;
      neurogenesisBursts++;
      stallAnchor = stallCount;
      // Âncoras REFEITAS no novo nível: a paisagem de fitness muda com os mazes novos
      // (interpretação documentada de E17 — medido: sem isto o campeão do nível anterior
      // ficava preso como referência e a promoção nunca voltava a disparar).
      // A 1.ª varrimento de campeão do novo nível substitui bestNet logo de seguida.
      best = -Infinity;
      champSolved = -1;
      champFitness = -Infinity;
    }

    const entry = {
      gen,
      best: genBest.fitness,
      mean,
      nNeurons: countNeurons(genBest.net),
      nConns: countConns(genBest.net),
    };
    history.push(entry);
    generationsRun = gen;

    const stats = {
      ...entry,
      bankStats: bank.stats(),
      bestNet: genBest.net,
      globalBestNet: bestNet,
      stalled,
      // E17: nível treinado nesta geração + progresso exato do campeão no nível
      level: trainedLevel,
      levelProgress,
      levelCount: trainedLevelCount,
      promoted, // { from, to, gen } na geração da subida; null nas restantes
      population: pop.slice(), // introspeção (identidade preservada em promoções)
    };
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

  return {
    best,
    bestNet,
    history,
    bankStats: bank.stats(),
    generations: generationsRun,
    neurogenesisBursts,
    finalLevel: levelSize, // E17: tamanho do nível atingido (targetSize quando completo)
  };
}

function rndInt(rng, m) {
  return Math.floor(rng.next() * m);
}
