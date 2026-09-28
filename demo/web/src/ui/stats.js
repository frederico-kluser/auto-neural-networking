/**
 * web/src/ui/stats.js [F] · faixa de objetivo + estatísticas + sparkline.
 * Contrato: demo/CONTRACTS.md § "web/src/ui/stats.js [F]" + demo/UX-REBUILD.md §2/§3.
 *
 *   export function mountStats(store) => { destroy() }
 *
 * Responsabilidades:
 *   - faixa de objetivo (#goal-banner): texto fixo + linha de progresso dinâmica
 *     (intro | progresso | vitória | limite) a partir das chaves do store;
 *     escuta o evento 'ann-goal-notice' (de ui/controls.js) para o aviso curto
 *     "desafio novo: a contar do zero";
 *   - EMENDA v6/E17: segunda linha do curriculum (#goal-curriculum), só enquanto
 *     treina: "a treinar em 7×7 · alvo 31×31 · nível 3/14" a partir das chaves
 *     level/levelProgress/targetSize do store (tolera ausência: sem dados ou em
 *     introdução/vitória/limite a linha fica oculta). O índice "nível k/N" sai de
 *     level/targetSize com início em 5 (5, 7, 9, ...); com um só nível mostra
 *     apenas "a treinar em 7×7";
 *   - chip de estado, contador de época do topo, contadores, mutações em ensaio,
 *     "o que a rede vê" (12 sinais agrupados + 4 saídas) e sparkline de evolução;
 *   - EMENDA v5/E14: lista "treinos guardados" (#saved-list) a partir de
 *     store.savedTrainings + store.selectedTrainingIds. Cada linha tem nome,
 *     meta linha ("7×7 · labirinto 3 · resultado 2,71 · 12 out 2026"), etiqueta
 *     "treino A"/"treino B" quando está em comparação (data-comparing a|b) e os
 *     botões button[data-action="play"|"compare"|"delete"] com data-id (os
 *     cliques são ligados por ui/controls.js, por delegação). Quando o nº de
 *     entradas do treino não pode jogar no labirinto atual, os botões "jogar" e
 *     "comparar" ficam desativados e o motivo aparece na linha (.saved-reason).
 *
 * Chaves do store LIDAS: training, generation, bestFitness, meanFitness,
 *   nNeurons, nConns, bankStats ({ [opName]: { p, q, count } }),
 *   episode ({ x, y, path, sensors, outputs, solved } | null),
 *   history (array de { gen, best, mean }; pode faltar ou ser curta),
 *   solved (bool; chip "resolvido" com prioridade sobre training),
 *   solvedCount, mazeCount (contador "resolvidos" em #stat-solved),
 *   stopReason ('solved' | 'limit' | 'time' | null; motivo de paragem, nunca
 *   silencioso; 'time' mostra a mensagem do limite de tempo),
 *   level, levelProgress, targetSize (E17: percurso do curriculum; número,
 *   { solved, total } | null e número; todos toleram ausência),
 *   elapsedMs (tempo de treino decorrido em ms: "a treinar há 12 min" na linha
 *   de progresso; omite sem dados),
 *   savedTrainings, selectedTrainingIds, mazeSize (lista de treinos guardados:
 *   compatibilidade de reprodução depende do tamanho do labirinto atual).
 *
 * Convenções: barras por style.width (0..100%); contadores "-" até haver dados;
 * números visíveis em pt-PT (vírgula decimal); IDs DOM em falta são ignorados em
 * silêncio. Tudo síncrono e sem leituras de layout por frame (só no ResizeObserver)
 * para aguentar atualização por época.
 */

// Operações do banco: ordem canónica de core/ops.mjs (8, inclui 'perturbWeights').
// Usa a lista desse módulo quando está acessível; de contrário os 8 nomes fixos
// do index.html. O render é tolerante: cobre também chaves novas de bankStats.
const OP_FALLBACK = ['addNeuron', 'addConn', 'removeConn', 'rewire', 'pruneNeuron', 'changeLeak', 'splitNeuron', 'perturbWeights'];
const OP_NAMES = await (async () => {
  try {
    const ops = await import('../../../core/ops.mjs');
    if (Array.isArray(ops.OP_NAMES) && ops.OP_NAMES.length) {
      return [...new Set([...ops.OP_NAMES, ...OP_FALLBACK])]; // união: nunca perder nomes fixos
    }
  } catch {
    // core/ops.mjs indisponível neste contexto (ex.: servidor com raiz em web/)
  }
  return OP_FALLBACK;
})();

// Etiquetas do chip (UX-REBUILD §2): parado | a treinar | em pausa | resolvido
const STATUS = { idle: 'parado', running: 'a treinar', paused: 'em pausa' };
const SPARK_COLORS = { best: '#F5B04A', mean: '#9A9AA3' };

// ---- formatação pt-PT (vírgula decimal; sem números fabricados) ----

function makeIntl(min, max) {
  try {
    return new Intl.NumberFormat('pt-PT', { minimumFractionDigits: min, maximumFractionDigits: max });
  } catch {
    return null; // fallback manual abaixo
  }
}
const INT_FMT = makeIntl(0, 0);
const F2_FMT = makeIntl(2, 2);
const F1_FMT = makeIntl(1, 1);
function fmtWith(f, v, decimals) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '-';
  return f ? f.format(n) : n.toFixed(decimals).replace('.', ',');
}
const fmtInt = (v) => fmtWith(INT_FMT, v, 0);
const fmt2 = (v) => fmtWith(F2_FMT, v, 2);
const fmt1 = (v) => fmtWith(F1_FMT, v, 1);

const setText = (el, txt) => {
  if (el && el.textContent !== txt) el.textContent = txt;
};
const setWidth = (el, pct) => {
  if (!el) return;
  const w = `${Math.min(100, Math.max(0, pct)).toFixed(1)}%`;
  if (el.style.width !== w) el.style.width = w;
};
const setFlag = (el, name, value) => {
  if (el && el.getAttribute(name) !== value) el.setAttribute(name, value);
};
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** "resolvidos": "2/3" a partir de solvedCount/mazeCount (ou levelProgress, E17); null sem dados. */
function solvedCounts(s) {
  let sc = Number(s.solvedCount);
  let mc = Number(s.mazeCount);
  if (!(Number.isFinite(sc) && Number.isFinite(mc) && mc > 0)) {
    // sem contagens válidas: levelProgress (E17) alimenta o mesmo contador
    const lp = s.levelProgress && typeof s.levelProgress === 'object' ? s.levelProgress : null;
    sc = Number(lp ? lp.solved : NaN);
    mc = Number(lp ? lp.total : NaN);
  }
  if (Number.isFinite(sc) && Number.isFinite(mc) && mc > 0) {
    return `${Math.max(0, Math.trunc(sc))}/${Math.max(0, Math.trunc(mc))}`;
  }
  return null;
}

// ---- E14: treinos guardados (lista, meta linha, compatibilidade) ----

const MONTHS_PT = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

/** "12 out 2026" (pt-PT curto, sem pontuação no mês); '' se data inválida. */
function fmtDate(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '';
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getDate()} ${MONTHS_PT[d.getMonth()]} ${d.getFullYear()}`;
}

/** Meta linha do registo: "7×7 · labirinto 3 · resultado 2,71 · 12 out 2026". */
function metaLine(meta) {
  const m = meta && typeof meta === 'object' ? meta : {};
  const parts = [];
  const size = Math.trunc(Number(m.mazeSize));
  if (Number.isFinite(size) && size > 0) parts.push(`${size}\u00d7${size}`);
  const seed = Math.trunc(Number(m.seed));
  if (Number.isFinite(seed) && seed >= 0) parts.push(`labirinto ${seed}`);
  const fit = Number(m.fitness);
  if (Number.isFinite(fit)) parts.push(`resultado ${fmt2(fit)}`);
  const date = fmtDate(m.createdAt);
  if (date) parts.push(date);
  return parts.join(' \u00b7 ') || 'sem dados';
}

/**
 * Compatibilidade de um treino guardado com o labirinto atual (E14): a rede
 * tem 12 entradas (sinais: vale para qualquer labirinto) ou 12 + células do
 * labirinto (mapa: só vale para esse tamanho). Devolve o motivo em pt-PT quando
 * NÃO pode jogar; null quando pode. (Gêmea da função em ui/controls.js:
 * mantidas as duas para os módulos não dependerem um do outro.)
 */
function compatReason(rec, s) {
  const nInRaw =
    rec && rec.net && Number.isFinite(Number(rec.net.nIn))
      ? Math.trunc(Number(rec.net.nIn))
      : rec && rec.meta && Number.isFinite(Number(rec.meta.nIn))
        ? Math.trunc(Number(rec.meta.nIn))
        : NaN;
  if (nInRaw === 12) return null; // 12 sinais: qualquer labirinto
  const side = Math.trunc(Number(s.mazeSize));
  const cells = (Number.isFinite(side) && side > 0 ? side : 7) ** 2;
  if (nInRaw === 12 + cells) return null; // mapa do mesmo tamanho
  const mapCells = nInRaw > 12 ? nInRaw - 12 : 0;
  const mapSide = Math.round(Math.sqrt(mapCells));
  if (mapCells > 0 && mapSide * mapSide === mapCells) {
    return `este treino aprendeu com o mapa de ${mapSide}\u00d7${mapSide} e s\u00f3 joga em labirintos desse tamanho`;
  }
  return 'este treino n\u00e3o serve para o labirinto atual';
}

/** Botão de ação de uma linha (data-action/data-id: alvo da delegação em controls.js). */
function makeActionBtn(doc, action, id, label, title, disabled) {
  const b = doc.createElement('button');
  b.type = 'button';
  b.className = 'btn';
  b.setAttribute('data-action', action);
  b.setAttribute('data-id', id);
  b.textContent = label;
  if (title) b.setAttribute('title', title);
  if (disabled) b.disabled = true;
  return b;
}

/**
 * Constrói uma linha da lista de treinos guardados. Sem innerHTML com dados:
 * tudo por textContent (nomes vindos de importações são texto, nunca marcado).
 */
function buildSavedRow(doc, rec, s, tag) {
  const li = doc.createElement('li');
  li.className = 'saved-row';
  li.setAttribute('data-id', String(rec.id));
  li.setAttribute('data-comparing', tag || 'false');
  const reason = compatReason(rec, s);
  li.setAttribute('data-playable', reason ? 'false' : 'true');

  const main = doc.createElement('div');
  main.className = 'saved-main';
  const nameEl = doc.createElement('span');
  nameEl.className = 'saved-name';
  nameEl.textContent = String(rec.name || 'treino');
  const metaEl = doc.createElement('span');
  metaEl.className = 'saved-meta';
  metaEl.textContent = metaLine(rec.meta);
  main.appendChild(nameEl);
  main.appendChild(metaEl);
  li.appendChild(main);

  if (tag) {
    const t = doc.createElement('span');
    t.className = 'saved-tag';
    t.setAttribute('data-tag', tag);
    t.textContent = tag === 'b' ? 'treino B' : 'treino A';
    li.appendChild(t);
  }

  const actions = doc.createElement('div');
  actions.className = 'saved-actions';
  const btnPlay = makeActionBtn(doc, 'play', rec.id, 'jogar', 'jogar este treino no labirinto atual', !!reason);
  const btnCompare = makeActionBtn(
    doc,
    'compare',
    rec.id,
    'comparar',
    'comparar com outro treino, os dois ao mesmo tempo',
    !!reason,
  );
  if (tag) btnCompare.setAttribute('aria-pressed', 'true');
  actions.appendChild(btnPlay);
  actions.appendChild(btnCompare);
  actions.appendChild(makeActionBtn(doc, 'delete', rec.id, 'apagar', 'apagar este treino do computador', false));
  li.appendChild(actions);

  if (reason) {
    const p = doc.createElement('p');
    p.className = 'saved-reason hint';
    p.textContent = reason;
    li.appendChild(p);
  }
  return li;
}

export function mountStats(store) {
  const doc = globalThis.document;
  if (!doc || !store || typeof store.subscribe !== 'function') return { destroy() {} };
  const $ = (id) => doc.getElementById(id);

  const chip = $('status-chip');
  const chipLabel = $('status-chip-label');
  const topGen = $('topbar-generation-value');
  const elSolved = $('episode-solved');
  const goalBanner = $('goal-banner');
  const goalProgress = $('goal-progress');
  const goalCurriculum = $('goal-curriculum'); // E17 (pode não existir: tolerado)
  const elSpark = $('spark-fitness');
  const statGen = $('stat-generation');
  const statBest = $('stat-fitness-best');
  const statMean = $('stat-fitness-mean');
  const statNeu = $('stat-neurons');
  const statCon = $('stat-conns');
  const statSolved = $('stat-solved');
  // elementos do banco por mutação, com cache (linhas em falta ficam a null)
  const opElCache = new Map();
  const opEls = (name) => {
    let e = opElCache.get(name);
    if (!e) {
      e = { fill: $(`op-${name}-fill`), pct: $(`op-${name}-pct`), count: $(`op-${name}-count`) };
      opElCache.set(name, e);
    }
    return e;
  };
  // 12 sinais: 0..3 paredes, 4..7 saída visível, 8..11 onde já esteve
  const sensorEls = Array.from({ length: 12 }, (_, i) => ({ fill: $(`sensor-fill-${i}`), val: $(`sensor-val-${i}`) }));
  const outputEls = Array.from({ length: 4 }, (_, i) => ({ fill: $(`output-fill-${i}`), val: $(`output-val-${i}`) }));
  // E14: lista de treinos guardados
  const savedList = $('saved-list');
  const savedEmpty = $('saved-empty');
  const savedCount = $('saved-count');

  // ---- aviso curto na faixa de objetivo (evento de ui/controls.js) ----

  let noticeText = '';
  let noticeTimer = 0;
  function onGoalNotice(ev) {
    const detail = ev && ev.detail ? ev.detail : {};
    noticeText = typeof detail.text === 'string' ? detail.text : '';
    const ms = Number.isFinite(Number(detail.ms)) ? Number(detail.ms) : 5000;
    if (noticeTimer) clearTimeout(noticeTimer);
    noticeTimer = 0;
    if (noticeText && ms > 0) {
      noticeTimer = setTimeout(() => {
        noticeTimer = 0;
        noticeText = '';
        render(store.get());
      }, ms);
    }
    render(store.get());
  }
  const win = doc.defaultView;
  const hasNoticeBus = !!(win && typeof win.addEventListener === 'function');
  if (hasNoticeBus) win.addEventListener('ann-goal-notice', onGoalNotice);

  // ---- sparkline (canvas 2D próprio, com DPR) ----

  const box = { w: 0, h: 0 };
  let lastHist = null;
  let lastLen = -1;

  function drawSpark(histIn) {
    if (!elSpark || typeof elSpark.getContext !== 'function') return;
    const ctx = elSpark.getContext('2d');
    if (!ctx) return;
    const w = box.w > 0 ? box.w : elSpark.clientWidth;
    const h = box.h > 0 ? box.h : elSpark.clientHeight;
    if (!w || !h) return;
    const dpr = Math.max(1, num(globalThis.devicePixelRatio) || 1);
    const pw = Math.round(w * dpr);
    const ph = Math.round(h * dpr);
    if (elSpark.width !== pw || elSpark.height !== ph) {
      elSpark.width = pw;
      elSpark.height = ph;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const hist = Array.isArray(histIn) ? histIn : [];
    if (!hist.length) return;
    let lo = Infinity;
    let hi = -Infinity;
    for (const pt of hist) {
      for (const key of ['best', 'mean']) {
        const v = Number(pt ? pt[key] : NaN);
        if (Number.isFinite(v)) {
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      }
    }
    if (!Number.isFinite(lo)) return;
    if (hi - lo < 1e-9) {
      lo -= 1;
      hi += 1;
    }
    const pad = (hi - lo) * 0.08;
    lo -= pad;
    hi += pad;
    const n = hist.length;
    const xOf = (i) => (n === 1 ? w / 2 : (i / (n - 1)) * w);
    const yOf = (v) => h - ((v - lo) / (hi - lo)) * h;
    // downsampling: nunca mais do que ~2 pontos por pixel
    const stride = Math.max(1, Math.ceil(n / Math.max(2, Math.round(w * 2))));
    for (const key of ['mean', 'best']) {
      // mean por baixo, best por cima
      ctx.strokeStyle = SPARK_COLORS[key];
      ctx.lineWidth = key === 'best' ? 1.6 : 1.1;
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < n; i += stride) {
        const v = Number(hist[i] ? hist[i][key] : NaN);
        if (!Number.isFinite(v)) continue;
        if (!started) {
          ctx.moveTo(xOf(i), yOf(v));
          started = true;
        } else {
          ctx.lineTo(xOf(i), yOf(v));
        }
      }
      const vLast = Number(hist[n - 1] ? hist[n - 1][key] : NaN);
      if (started && Number.isFinite(vLast)) ctx.lineTo(xOf(n - 1), yOf(vLast));
      ctx.stroke();
      if (n === 1 && Number.isFinite(vLast)) {
        // série de 1 ponto: marcador no lugar da linha
        ctx.fillStyle = SPARK_COLORS[key];
        ctx.fillRect(xOf(0) - 1.5, yOf(vLast) - 1.5, 3, 3);
      }
    }
  }

  function renderSpark(s) {
    const h = Array.isArray(s.history) ? s.history : null;
    if (h === lastHist && (!h || h.length === lastLen)) return;
    lastHist = h;
    lastLen = h ? h.length : -1;
    drawSpark(h);
  }

  function measure() {
    if (!elSpark) return;
    box.w = elSpark.clientWidth;
    box.h = elSpark.clientHeight;
    drawSpark(lastHist);
  }

  let ro = null;
  if (elSpark && typeof globalThis.ResizeObserver === 'function') {
    ro = new ResizeObserver((entries) => {
      const r = entries && entries[0] && entries[0].contentRect;
      if (r) {
        box.w = r.width;
        box.h = r.height;
      }
      drawSpark(lastHist);
    });
    ro.observe(elSpark);
  }
  const hasWin = globalThis.addEventListener && globalThis.removeEventListener;
  if (!ro && hasWin) globalThis.addEventListener('resize', measure);

  // ---- faixa de objetivo ----

  const TXT_INTRO = 'clica em Treinar e observa a rede evoluir até vencer';
  const TXT_LIMIT =
    'limite de épocas atingido: a rede ainda não venceu. Aumente o limite em definições avançadas ou use um labirinto menor.';
  const TXT_TIME = 'limite de tempo atingido: a rede ainda não venceu. Aumente o limite de tempo para continuar.';

  // E17: o treino sobe 5→7→9→…→targetSize; o índice "nível k/N" sai daqui.
  const CURRICULUM_START = 5;

  /**
   * Tempo decorrido em minutos inteiros (mínimo 1 enquanto corre) para
   * "a treinar há 12 min". null sem dados (elapsedMs ausente ou a zero).
   */
  function elapsedMinutes(msRaw) {
    const ms = Number(msRaw);
    if (!Number.isFinite(ms) || ms <= 0) return null;
    return Math.max(1, Math.round(ms / 60000));
  }

  /**
   * Linha do curriculum em pt-PT: "a treinar em 7×7 · alvo 31×31 · nível 3/14".
   * Com um só nível (alvo 5×5) fica "a treinar em 5×5". null quando não há
   * dados (level/targetSize ausentes ou a zero: nunca fabrica números).
   */
  function curriculumLine(s) {
    const level = Math.trunc(num(s.level));
    const target = Math.trunc(num(s.targetSize));
    if (!(level > 0) || !(target > 0)) return null;
    const size = `${fmtInt(level)}\u00d7${fmtInt(level)}`;
    const count = Math.trunc((target - CURRICULUM_START) / 2) + 1;
    if (!(count > 1)) return `a treinar em ${size}`;
    const idx = Math.min(count, Math.max(1, Math.trunc((level - CURRICULUM_START) / 2) + 1));
    return `a treinar em ${size} \u00b7 alvo ${fmtInt(target)}\u00d7${fmtInt(target)} \u00b7 n\u00edvel ${fmtInt(idx)}/${fmtInt(count)}`;
  }

  function renderGoal(s) {
    if (!goalBanner || !goalProgress) return;
    const g = Math.trunc(num(s.generation));
    const hasRun = g > 0 || (Array.isArray(s.history) && s.history.length > 0);
    let st;
    let txt;
    if (s.solved === true && s.stopReason === 'solved' && hasRun) {
      st = 'solved';
      txt = `desafio vencido em ${fmtInt(g)} ${g === 1 ? 'época' : 'épocas'}`;
    } else if ((s.stopReason === 'limit' || s.stopReason === 'time') && s.training === 'idle' && hasRun) {
      st = 'limit';
      txt = s.stopReason === 'time' ? TXT_TIME : TXT_LIMIT;
    } else if (!hasRun && s.training === 'idle') {
      st = 'intro';
      txt = TXT_INTRO;
    } else {
      st = 'progress';
      const counts = solvedCounts(s);
      txt = `época ${fmtInt(g)} · resolvidos ${counts != null ? counts : '-'} · melhor resultado ${g > 0 ? fmt2(s.bestFitness) : '-'}`;
      // tempo decorrido de treino: "a treinar há 12 min" (sem dados: omite)
      const mins = elapsedMinutes(s.elapsedMs);
      if (mins != null) txt += ` · a treinar há ${fmtInt(mins)} min`;
    }
    if (noticeText) txt = noticeText; // aviso curto no texto de progresso
    setFlag(goalBanner, 'data-state', st);
    setFlag(goalBanner, 'data-notice', noticeText ? 'true' : 'false');
    setText(goalProgress, txt);
    // E17: segunda linha com o percurso do curriculum, só enquanto treina e sem
    // aviso ativo (a vitória e a introdução ficam exatamente como eram).
    const cur = st === 'progress' && !noticeText ? curriculumLine(s) : null;
    if (goalCurriculum) {
      goalCurriculum.hidden = cur == null;
      setText(goalCurriculum, cur == null ? '' : cur);
    }
  }

  // ---- lista de treinos guardados (E14) ----

  let lastSavedSig = null;

  function renderSaved(s) {
    if (!savedList) return;
    const records = Array.isArray(s.savedTrainings)
      ? s.savedTrainings.filter((r) => r && r.id != null)
      : [];
    const selected = (Array.isArray(s.selectedTrainingIds) ? s.selectedTrainingIds : []).slice(0, 2);
    // assinatura do que é visível: render() corre a cada época e a lista só é
    // reconstruída quando o seu conteúdo (ou o labirinto atual) muda
    let sig = `${s.mazeSize}|${s.memoryMode}|${selected.join(',')}`;
    for (const r of records) {
      sig += `\u0001${r.id}\u0002${r.name || ''}\u0002${JSON.stringify(r.meta || null)}\u0002${(r.net && r.net.nIn) || ''}`;
    }
    if (sig === lastSavedSig) return;
    lastSavedSig = sig;

    savedList.textContent = ''; // limpa as linhas antigas
    for (const rec of records) {
      const i = selected.indexOf(rec.id);
      savedList.appendChild(buildSavedRow(doc, rec, s, i === 0 ? 'a' : i === 1 ? 'b' : ''));
    }
    const n = records.length;
    setText(savedCount, n === 1 ? '1 guardado' : `${fmtInt(n)} guardados`);
    if (savedEmpty) savedEmpty.style.display = n === 0 ? '' : 'none';
  }

  // ---- render do painel ----

  function render(s) {
    // estado global (chip: solved->resolvido tem prioridade | idle->parado |
    // running->a treinar | paused->em pausa)
    if (s.solved === true) {
      setFlag(chip, 'data-state', 'solved');
      setText(chipLabel, 'resolvido');
    } else {
      const t = STATUS[s.training] ? s.training : 'idle';
      setFlag(chip, 'data-state', t);
      setText(chipLabel, STATUS[t]);
    }

    // faixa de objetivo (sempre atualizada: nunca há paragem silenciosa)
    renderGoal(s);

    // contadores (mono, vírgula decimal; "-" enquanto não houver dados)
    const g = Math.trunc(num(s.generation));
    const hasGen = g > 0;
    const genTxt = hasGen ? fmtInt(g) : '-';
    setText(topGen, genTxt);
    setText(statGen, genTxt);
    setText(statBest, hasGen ? fmt2(s.bestFitness) : '-');
    setText(statMean, hasGen ? fmt2(s.meanFitness) : '-');
    const neu = Math.trunc(num(s.nNeurons));
    const con = Math.trunc(num(s.nConns));
    setText(statNeu, neu > 0 ? fmtInt(neu) : '-');
    setText(statCon, con > 0 ? fmtInt(con) : '-');
    // resolvidos: "solvedCount/mazeCount"; "-" sem dados
    const counts = solvedCounts(s);
    setText(statSolved, counts != null ? counts : '-');

    // mutações em ensaio (tolerante a chaves em falta e a mutações novas)
    const bank = s.bankStats && typeof s.bankStats === 'object' ? s.bankStats : {};
    const opNames = new Set(OP_NAMES);
    for (const key of Object.keys(bank)) opNames.add(key);
    for (const name of opNames) {
      const st = bank[name];
      const p = st && Number.isFinite(Number(st.p)) ? Math.min(1, Math.max(0, Number(st.p))) : 0;
      const e = opEls(name);
      setWidth(e.fill, p * 100);
      setText(e.pct, `${fmt1(p * 100)}%`);
      setText(e.count, String(st && Number.isFinite(Number(st.count)) ? Math.trunc(Number(st.count)) : 0));
    }

    // os 12 sinais (0..3 paredes, 4..7 saída visível, 8..11 onde já esteve):
    // valor normalizado 0..1 -> barra 0..100%
    const sensors = s.episode && s.episode.sensors;
    for (let i = 0; i < 12; i++) {
      const v = Math.min(1, Math.max(0, num(sensors ? sensors[i] : 0)));
      setWidth(sensorEls[i].fill, v * 100);
      setText(sensorEls[i].val, fmt2(v));
    }

    // saída da rede (4, ordem DIRS): saturação por |y|, sinal no texto
    const outs = s.episode && s.episode.outputs;
    for (let i = 0; i < 4; i++) {
      const y = num(outs ? outs[i] : 0);
      setWidth(outputEls[i].fill, Math.min(100, Math.abs(y) * 100));
      setText(outputEls[i].val, `${y < 0 ? '' : '+'}${fmt2(y)}`);
    }

    // episódio resolvido?
    const solved = !!(s.episode && s.episode.solved);
    setFlag(elSolved, 'data-solved', solved ? 'true' : 'false');
    setText(elSolved, solved ? 'resolvido' : 'por resolver');

    renderSaved(s); // lista de treinos guardados (E14; internamente cacheada)
    renderSpark(s);
  }

  measure(); // tamanho inicial do canvas (antes de qualquer histórico)
  render(store.get());
  const unsub = store.subscribe(render);

  let dead = false;
  return {
    destroy() {
      if (dead) return;
      dead = true;
      if (typeof unsub === 'function') unsub();
      if (ro) ro.disconnect();
      if (!ro && hasWin) globalThis.removeEventListener('resize', measure);
      if (hasNoticeBus) win.removeEventListener('ann-goal-notice', onGoalNotice);
      if (noticeTimer) clearTimeout(noticeTimer);
      noticeTimer = 0;
    },
  };
}
