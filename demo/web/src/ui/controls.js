/**
 * web/src/ui/controls.js [F] · painel de controlo de treino (reconstrução UX).
 * Contrato: demo/CONTRACTS.md § "web/src/ui/controls.js [F]" + demo/UX-REBUILD.md §2/§3.
 *
 *   export function mountControls(store, actions) => { destroy() }
 *   actions: { train(), pause(), reset(), setSpeed(n), setMazeSize(n), setSeed(n),
 *              setAutoRotate(bool), setMemoryMode(mode), saveTraining(name),
 *              playTraining(id), toggleCompareTraining(id), deleteTraining(id) }
 *              // TODAS opcionais: chamadas se existirem; ignoradas em silêncio
 *                 quando não existem (nunca lança)
 *
 * EMENDA v5/E14 (treinos guardados):
 *   - "memória da rede" (#ctrl-memory-mode) -> store.memoryMode SEMPRE e
 *     actions.setMemoryMode(mode) quando existe. Modo válido: sinapses | mapa |
 *     ambos (qualquer outro valor cai em 'sinapses').
 *   - "guardar treino atual" (#btn-save-training) -> actions.saveTraining(name)
 *     quando existe. Sem a action, fallback local: guarda em
 *     web/src/training-store.js com a rede que estiver no store (bestNet ||
 *     championNet || net); sem rede no store mostra nota em #saved-status e não
 *     guarda (não fabrica dados). Em qualquer dos casos a lista do store
 *     (savedTrainings) volta a ser lida do training-store, que é a fonte de
 *     verdade, e selectedTrainingIds é podado dos ids que deixaram de existir.
 *   - Linhas da lista (#saved-list, renderizadas por ui/stats.js): cliques
 *     delegados em button[data-action][data-id]:
 *       play    -> store.playbackSource = { kind:'training', id } sempre (é
 *                  estado, escrita idempotente) + actions.playTraining(id);
 *       compare -> actions.toggleCompareTraining(id) quando existe (a MUTAÇÃO de
 *                  selectedTrainingIds é da integração nesse caso); sem a action,
 *                  fallback local que alterna o id na seleção (máximo 2; ao
 *                  escolher um terceiro sai o mais antigo);
 *       delete  -> actions.deleteTraining(id) quando existe; sem a action,
 *                  apaga em training-store.remove(id). Depois: lista
 *                  ressincronizada como em "guardar".
 *   - Compatibilidade: um treino só pode jogar se o nº de entradas da rede for
 *     12 (sinais: vale para qualquer labirinto) ou 12 + células do labirinto
 *     atual (mapa). Incompatível -> botões desativados e motivo em .saved-reason
 *     (render de ui/stats.js; aqui só a guarda de clique).
 *   - Nome do treino: sanitizado (sem caracteres de controlo, máx. 60); o valor
 *     por defeito ("7×7 · labirinto 3 · 2,71") é atualizado enquanto o
 *     utilizador não escreve no campo.
 *
 * Ordem do painel (UX-REBUILD §2): botões (Treinar primário + Pausar/Recomeçar),
 * tamanho do desafio, velocidade do treino, definições avançadas (recolhidas).
 *
 * Chaves do store LIDAS:   training, mazeSize, seed, population, generations,
 *                          speed, autoRotate, memoryMode, bestFitness,
 *                          savedTrainings, selectedTrainingIds
 * Chaves do store ESCRITAS: mazeSize, seed, population, generations, speed,
 *                          autoRotate, memoryMode, savedTrainings,
 *                          selectedTrainingIds, playbackSource
 *   - population/generations não têm action no contrato: ficam só no store.
 *   - autoRotate: #ctrl-auto-rotate -> store.autoRotate + actions.setAutoRotate(bool)
 *     no change (a action é ignorada em silêncio se não existir).
 *   - generations = "limite de épocas": inteiro >= 0; vazio/NaN -> 0.
 *     0 = treinar até vencer; n > 0 = teto opcional.
 *   - speed guarda o valor do radiogroup (1 | 4 | 16 | 'max');
 *     actions.setSpeed recebe o tamanho de lote em épocas: 1 | 4 | 16 e 'max' -> 50.
 *     Depois de chamar a action, o store volta a ficar com o valor canónico
 *     (1 | 4 | 16 | 'max'), porque a integração grava lá o tamanho do lote.
 *   - viewMode foi removido da UI (UX-REBUILD): a chave do store mantém-se.
 *
 * Botões (UX-REBUILD §3): Treinar inicia/retoma (etiqueta "Retomar" em pausa),
 * Pausar só ativo enquanto corre, Recomeçar sempre disponível.
 * Mudar "tamanho do desafio" ou "labirinto nº" durante o treino reinicia o
 * desafio e avisa "desafio novo: a contar do zero" (evento 'ann-goal-notice'
 * para a faixa de objetivo).
 * IDs DOM em falta são ignorados em silêncio; destroy() remove todos os listeners.
 */

// treinos guardados (E14): fonte de verdade da lista; sem dependências externas
import * as trainingStore from '../training-store.js';

// velocidade -> épocas por lote do worker
const SPEED_BATCH = { '1': 1, '4': 4, '16': 16, 'max': 50 };
const SPEED_IDS = { '1': 'speed-1', '4': 'speed-4', '16': 'speed-16', 'max': 'speed-max' };
const NOTICE_EVENT = 'ann-goal-notice';
const NOTICE_TEXT = 'desafio novo: a contar do zero';
const NOTICE_MS = 5000;

/** Inteiro com clamping; valores não finitos caem no fallback (nunca propaga NaN). */
function clampInt(raw, min, max, fallback) {
  const n = Math.trunc(Number(raw));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/** Lado do labirinto: ímpar em [5, 31] (opções do select). */
function oddSize(raw, fallback) {
  const n = clampInt(raw, 5, 31, fallback);
  return n % 2 ? n : Math.min(31, n + 1);
}

/** Prioridade: valor válido do store, senão o do input, senão fallback. */
function pick(domVal, storeVal, min, max, fallback) {
  const sv = Math.trunc(Number(storeVal));
  if (Number.isFinite(sv) && sv >= min && sv <= max) return sv;
  const dv = Math.trunc(Number(domVal));
  if (Number.isFinite(dv) && dv >= min && dv <= max) return dv;
  return fallback;
}

// ---- E14: nomes, modos de memória e compatibilidade de treinos ----

const MEMORY_MODES = ['sinapses', 'mapa', 'ambos'];
const NAME_MAX = 60;

/** Nome de treino: sem caracteres de controlo, espaços colapsados, máx. 60. */
function sanitizeName(raw) {
  return String(raw == null ? '' : raw)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_MAX);
}

/** 2,71 em pt-PT (vírgula decimal) para o nome por defeito. */
function fmt2(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(2).replace('.', ',') : '0,00';
}

/** Nome por defeito do treino: "7×7 · labirinto 3 · 2,71". */
function defaultTrainingName(s) {
  const size = oddSize(s.mazeSize, 7);
  return `${size}\u00d7${size} \u00b7 labirinto ${clampInt(s.seed, 0, 2147483647, 1)} \u00b7 ${fmt2(s.bestFitness)}`;
}

/**
 * Compatibilidade de um treino guardado com o labirinto atual (E14): a rede
 * tem 12 entradas (sinais: vale para qualquer labirinto) ou 12 + células do
 * labirinto (mapa: só vale para esse tamanho). Devolve o motivo em pt-PT quando
 * NÃO pode jogar; null quando pode. (Gêmea da função em ui/stats.js: mantidas
 * as duas para os módulos não dependerem um do outro.)
 */
function compatReason(rec, s) {
  const nInRaw = rec && rec.net && Number.isFinite(Number(rec.net.nIn))
    ? Math.trunc(Number(rec.net.nIn))
    : rec && rec.meta && Number.isFinite(Number(rec.meta.nIn))
      ? Math.trunc(Number(rec.meta.nIn))
      : NaN;
  if (nInRaw === 12) return null; // 12 sinais: qualquer labirinto
  const side = oddSize(s.mazeSize, 7);
  if (nInRaw === 12 + side * side) return null; // mapa do mesmo tamanho
  const mapCells = nInRaw > 12 ? nInRaw - 12 : 0;
  const mapSide = Math.round(Math.sqrt(mapCells));
  if (mapCells > 0 && mapSide * mapSide === mapCells) {
    return `este treino aprendeu com o mapa de ${mapSide}\u00d7${mapSide} e s\u00f3 joga em labirintos desse tamanho`;
  }
  return 'este treino n\u00e3o serve para o labirinto atual';
}

export function mountControls(store, actions = {}) {
  const doc = globalThis.document;
  if (!doc || !store || typeof store.get !== 'function' || typeof store.set !== 'function') {
    return { destroy() {} };
  }
  const $ = (id) => doc.getElementById(id);
  const act = (name, ...args) => {
    const fn = actions[name];
    if (typeof fn === 'function') fn(...args);
  };

  const selMaze = $('ctrl-maze-size');
  const inSeed = $('ctrl-seed');
  const inPop = $('ctrl-population');
  const inGens = $('ctrl-generations');
  const chkAutoRotate = $('ctrl-auto-rotate');
  const selMemory = $('ctrl-memory-mode');
  const inName = $('training-name');
  const btnSave = $('btn-save-training');
  const savedList = $('saved-list');
  const savedStatus = $('saved-status');
  const btnTrain = $('btn-train');
  const btnPause = $('btn-pause');
  const btnReset = $('btn-reset');
  const speedRadios = Object.values(SPEED_IDS).map($);

  const listeners = [];
  const on = (el, type, fn) => {
    if (!el || typeof el.addEventListener !== 'function') return;
    el.addEventListener(type, fn);
    listeners.push([el, type, fn]);
  };

  const training = () => {
    const t = store.get().training;
    return t === 'running' || t === 'paused' ? t : 'idle';
  };

  /** Aviso curto na faixa de objetivo (consumido por ui/stats.js). */
  function notifyChallengeReset() {
    const view = doc.defaultView;
    if (!view || typeof view.dispatchEvent !== 'function' || typeof view.CustomEvent !== 'function') return;
    view.dispatchEvent(new view.CustomEvent(NOTICE_EVENT, { detail: { text: NOTICE_TEXT, ms: NOTICE_MS } }));
  }

  // ---- E14: treinos guardados (nome, guardar, linhas da lista) ----

  let statusTimer = 0;
  /** Nota inline curta em #saved-status (nunca paragem silenciosa). */
  function note(text) {
    if (!savedStatus) return;
    savedStatus.textContent = String(text || '');
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = 0;
    if (text) {
      statusTimer = setTimeout(() => {
        statusTimer = 0;
        if (savedStatus) savedStatus.textContent = '';
      }, NOTICE_MS);
    }
  }

  /** Repõe a lista do store a partir do training-store (fonte de verdade). */
  function syncSaved() {
    let records = [];
    try {
      records = trainingStore.list();
    } catch {
      records = [];
    }
    const ids = new Set(records.map((r) => r.id));
    const s = store.get();
    const selected = (Array.isArray(s.selectedTrainingIds) ? s.selectedTrainingIds : [])
      .filter((id) => ids.has(id))
      .slice(0, 2); // máximo 2 (comparação dupla)
    store.set({ savedTrainings: records, selectedTrainingIds: selected });
  }

  /** Nome por defeito "7×7 · labirinto 3 · 2,71" enquanto o campo não é editado. */
  let lastAutoName = '';
  function syncNameDefault() {
    if (!inName || doc.activeElement === inName) return; // não interromper digitação
    const v = defaultTrainingName(store.get());
    if (inName.value === '' || inName.value === lastAutoName) {
      if (inName.value !== v) inName.value = v;
      lastAutoName = v;
    }
  }

  function applyMemoryMode(raw) {
    const v = MEMORY_MODES.indexOf(String(raw)) >= 0 ? String(raw) : 'sinapses';
    if (selMemory && selMemory.value !== v) selMemory.value = v;
    if (store.get().memoryMode !== v) store.set({ memoryMode: v });
    act('setMemoryMode', v); // ignorado em silêncio se a action não existir
  }

  function onSaveTraining() {
    const name = sanitizeName(inName ? inName.value : '') || defaultTrainingName(store.get());
    if (typeof actions.saveTraining === 'function') {
      act('saveTraining', name);
    } else {
      // fallback: guarda aqui (precisa de uma rede no store; nunca fabrica uma)
      const s = store.get();
      const net = s.bestNet || s.championNet || s.net || null;
      if (!net) {
        note('ainda não há rede treinada para guardar');
        return;
      }
      const size = oddSize(s.mazeSize, 7);
      let saved = null;
      try {
        saved = trainingStore.save({
          name,
          meta: {
            mazeSize: size,
            seed: clampInt(s.seed, 0, 2147483647, 1),
            epochs: clampInt(s.generation, 0, 1000000000, 0),
            fitness: Number(s.bestFitness) || 0,
            memoryMode: MEMORY_MODES.indexOf(String(s.memoryMode)) >= 0 ? String(s.memoryMode) : 'sinapses',
            nIn: Number(net.nIn) || 12,
            createdAt: Date.now(),
          },
          net,
        });
      } catch {
        saved = null;
      }
      if (!saved) {
        note('não foi possível guardar o treino');
        return;
      }
    }
    syncSaved();
    if (inName) {
      // campo pronto para o próximo treino (volta ao nome por defeito)
      const v = defaultTrainingName(store.get());
      inName.value = v;
      lastAutoName = v;
    }
    note(`treino guardado: ${name}`);
  }

  /** Botão de ação da linha da lista a partir do alvo do clique (ou null). */
  function actionButtonOf(target) {
    if (!savedList || !target) return null;
    if (typeof target.closest === 'function') {
      const b = target.closest('button[data-action][data-id]');
      if (!b) return null;
      return typeof savedList.contains !== 'function' || savedList.contains(b) ? b : null;
    }
    let el = target;
    while (el && el !== savedList) {
      if (
        typeof el.getAttribute === 'function' &&
        el.getAttribute('data-action') &&
        el.getAttribute('data-id')
      ) {
        return el;
      }
      el = el.parentElement || null;
    }
    return null;
  }

  function onRowAction(id, action) {
    const rec = (store.get().savedTrainings || []).find((r) => r && r.id === id) || trainingStore.load(id);
    if (action === 'play') {
      if (rec && compatReason(rec, store.get())) return; // guarda defensiva
      store.set({ playbackSource: { kind: 'training', id } }); // estado idempotente
      act('playTraining', id);
      return;
    }
    if (action === 'compare') {
      if (typeof actions.toggleCompareTraining === 'function') {
        act('toggleCompareTraining', id); // a seleção é mutada pela integração
        return;
      }
      // fallback: alterna o id na seleção (máximo 2; o terceiro expulsa o mais antigo)
      const s = store.get();
      const cur = (Array.isArray(s.selectedTrainingIds) ? s.selectedTrainingIds : []).slice(0, 2);
      const i = cur.indexOf(id);
      if (i >= 0) {
        cur.splice(i, 1);
      } else if (cur.length < 2) {
        cur.push(id);
      } else {
        cur.shift();
        cur.push(id);
        note('a comparação guarda dois treinos de cada vez: o mais antigo saiu');
      }
      store.set({ selectedTrainingIds: cur });
      return;
    }
    if (action === 'delete') {
      if (typeof actions.deleteTraining === 'function') {
        act('deleteTraining', id);
      } else {
        try {
          trainingStore.remove(id);
        } catch {
          // ignorado: o store de treinos nunca lança
        }
      }
      syncSaved();
    }
  }

  /**
   * Semântica dos botões (UX-REBUILD §3):
   *   running: Pausar ativo, Treinar desativado, Recomeçar disponível;
   *   paused:  primário "Retomar" ativo, Pausar desativado;
   *   idle:    primário "Treinar" ativo, Pausar desativado.
   * Recomeçar está sempre ativo.
   */
  function syncButtons(t) {
    const st = t === 'running' || t === 'paused' ? t : 'idle';
    if (btnTrain) {
      const label = st === 'paused' ? 'Retomar' : 'Treinar';
      if (btnTrain.textContent !== label) btnTrain.textContent = label;
      btnTrain.disabled = st === 'running';
    }
    if (btnPause) btnPause.disabled = st !== 'running';
    if (btnReset) btnReset.disabled = false;
  }

  // ---- escritores de configuração (sanitização + store + actions) ----

  function applyMazeSize(raw) {
    const v = oddSize(raw, oddSize(store.get().mazeSize, 7));
    if (selMaze && selMaze.value !== String(v)) selMaze.value = String(v);
    if (store.get().mazeSize !== v) store.set({ mazeSize: v });
    act('setMazeSize', v);
    // config mudou com treino ativo: reinicia o desafio e avisa
    if (training() !== 'idle') {
      act('reset');
      notifyChallengeReset();
    }
  }

  function applySeed(raw) {
    const v = clampInt(raw, 0, 2147483647, clampInt(store.get().seed, 0, 2147483647, 1));
    if (inSeed && inSeed.value !== String(v)) inSeed.value = String(v);
    if (store.get().seed !== v) store.set({ seed: v });
    act('setSeed', v);
    if (training() !== 'idle') {
      act('reset');
      notifyChallengeReset();
    }
  }

  function applyPopulation(raw) {
    const v = clampInt(raw, 2, 10000, clampInt(store.get().population, 2, 10000, 60));
    if (inPop && inPop.value !== String(v)) inPop.value = String(v);
    if (store.get().population !== v) store.set({ population: v });
  }

  function applyGenerations(raw) {
    // "limite de épocas": inteiro >= 0; vazio/NaN cai em 0 (0 = até vencer)
    const v = clampInt(raw, 0, 100000, 0);
    if (inGens && inGens.value !== String(v)) inGens.value = String(v);
    if (store.get().generations !== v) store.set({ generations: v });
  }

  function applySpeed(raw) {
    const key = Object.prototype.hasOwnProperty.call(SPEED_BATCH, String(raw)) ? String(raw) : '1';
    const storeVal = key === 'max' ? 'max' : Number(key);
    if (store.get().speed !== storeVal) store.set({ speed: storeVal });
    act('setSpeed', SPEED_BATCH[key]);
    // a integração grava o tamanho do lote no store; repõe o valor canónico
    if (store.get().speed !== storeVal) store.set({ speed: storeVal });
  }

  function applyAutoRotate(raw) {
    // rotação automática da câmara -> store.autoRotate + actions.setAutoRotate(bool)
    const v = !!raw;
    if (chkAutoRotate && chkAutoRotate.checked !== v) chkAutoRotate.checked = v;
    if (store.get().autoRotate !== v) store.set({ autoRotate: v });
    act('setAutoRotate', v); // ignorado em silêncio se a action não existir
  }

  // ---- listeners ----

  on(selMaze, 'change', () => applyMazeSize(selMaze.value));
  on(inSeed, 'change', () => applySeed(inSeed.value));
  on(inPop, 'change', () => applyPopulation(inPop.value));
  on(inGens, 'change', () => applyGenerations(inGens.value));
  for (const r of speedRadios) {
    on(r, 'change', () => {
      if (r.checked) applySpeed(r.value);
    });
  }
  on(chkAutoRotate, 'change', () => applyAutoRotate(!!(chkAutoRotate && chkAutoRotate.checked)));
  on(selMemory, 'change', () => applyMemoryMode(selMemory ? selMemory.value : 'sinapses'));
  on(btnTrain, 'click', () => act('train'));
  on(btnPause, 'click', () => act('pause'));
  on(btnReset, 'click', () => act('reset'));

  // E14: guardar treino atual + ações das linhas da lista (delegação)
  on(btnSave, 'click', () => onSaveTraining());
  on(inName, 'keydown', (ev) => {
    if (ev && ev.key === 'Enter') onSaveTraining();
  });
  on(inName, 'blur', () => syncNameDefault()); // campo vazio volta ao nome por defeito
  on(savedList, 'click', (ev) => {
    const b = actionButtonOf(ev && ev.target);
    if (!b) return;
    onRowAction(b.getAttribute('data-id'), b.getAttribute('data-action'));
  });

  // ---- sincronismo inicial: store primeiro, DOM como reserva ----

  const s0 = store.get();
  const patch = {};

  if (selMaze) {
    const v = oddSize(pick(selMaze.value, s0.mazeSize, 5, 31, 7), 7);
    selMaze.value = String(v);
    if (s0.mazeSize !== v) patch.mazeSize = v;
  }
  if (inSeed) {
    const v = clampInt(pick(inSeed.value, s0.seed, 0, 2147483647, 1), 0, 2147483647, 1);
    inSeed.value = String(v);
    if (s0.seed !== v) patch.seed = v;
  }
  if (inPop) {
    const v = clampInt(pick(inPop.value, s0.population, 2, 10000, 60), 2, 10000, 60);
    inPop.value = String(v);
    if (s0.population !== v) patch.population = v;
  }
  if (inGens) {
    // 0 é valor válido (até vencer); vazio/NaN -> 0
    const v = clampInt(pick(inGens.value, s0.generations, 0, 100000, 0), 0, 100000, 0);
    inGens.value = String(v);
    if (s0.generations !== v) patch.generations = v;
  }

  const domSpeed = (speedRadios.find((r) => r && r.checked) || {}).value;
  const speedKey =
    s0.speed === 'max' || s0.speed === 1 || s0.speed === 4 || s0.speed === 16
      ? String(s0.speed)
      : SPEED_BATCH[domSpeed] ? domSpeed : '16';
  for (const r of speedRadios) if (r) r.checked = r.value === speedKey;
  const speedStoreVal = speedKey === 'max' ? 'max' : Number(speedKey);
  if (s0.speed !== speedStoreVal) patch.speed = speedStoreVal;

  if (chkAutoRotate) {
    // desligado por defeito; store primeiro, estado do DOM (unchecked) como reserva
    const v = typeof s0.autoRotate === 'boolean' ? s0.autoRotate : chkAutoRotate.checked === true;
    chkAutoRotate.checked = v;
    if (s0.autoRotate !== v) patch.autoRotate = v;
  }
  if (selMemory) {
    // 'sinapses' por defeito (E13); store primeiro, DOM como reserva
    const domVal = MEMORY_MODES.indexOf(selMemory.value) >= 0 ? selMemory.value : 'sinapses';
    const v = MEMORY_MODES.indexOf(String(s0.memoryMode)) >= 0 ? String(s0.memoryMode) : domVal;
    selMemory.value = v;
    if (s0.memoryMode !== v) patch.memoryMode = v;
  }
  if (inName) {
    // nome por defeito "7×7 · labirinto 3 · 2,71" (forçado no arranque)
    const v = defaultTrainingName({ ...s0, ...patch });
    inName.value = v;
    lastAutoName = v;
  }

  if (Object.keys(patch).length) store.set(patch);
  act('setSpeed', SPEED_BATCH[speedKey]); // anuncia o lote inicial (idempotente)
  if (store.get().speed !== speedStoreVal) store.set({ speed: speedStoreVal });
  syncSaved(); // hidrata savedTrainings a partir do training-store e poda a seleção
  syncButtons(s0.training);

  // ---- sincronismo contínuo (mudanças externas do store) ----

  const syncInput = (el, value) => {
    // não interferir enquanto o utilizador edita o campo
    if (el && el !== doc.activeElement && el.value !== value) el.value = value;
  };
  const syncRadio = (ids, value) => {
    for (const key of Object.keys(ids)) {
      const r = $(ids[key]);
      if (r) r.checked = key === value;
    }
  };

  const unsub = store.subscribe((s) => {
    syncButtons(s.training);
    syncInput(selMaze, String(oddSize(s.mazeSize, 7)));
    syncInput(inSeed, String(clampInt(s.seed, 0, 2147483647, 1)));
    if (s.population != null) syncInput(inPop, String(clampInt(s.population, 2, 10000, 60)));
    if (s.generations != null) syncInput(inGens, String(clampInt(s.generations, 0, 100000, 0)));
    if (s.speed != null) {
      // o store pode conter o tamanho do lote (50) em vez de 'max'; só sincroniza
      // chaves canónicas para não desmarcar os segmentos
      const k = String(s.speed);
      if (Object.prototype.hasOwnProperty.call(SPEED_IDS, k)) syncRadio(SPEED_IDS, k);
    }
    if (chkAutoRotate && typeof s.autoRotate === 'boolean' && chkAutoRotate.checked !== s.autoRotate) {
      chkAutoRotate.checked = s.autoRotate;
    }
    if (selMemory && s.memoryMode != null) {
      const v = MEMORY_MODES.indexOf(String(s.memoryMode)) >= 0 ? String(s.memoryMode) : 'sinapses';
      if (selMemory.value !== v) selMemory.value = v;
    }
    syncNameDefault(); // nome por defeito enquanto o utilizador não escreve
  });

  let dead = false;
  return {
    destroy() {
      if (dead) return;
      dead = true;
      for (const [el, type, fn] of listeners) el.removeEventListener(type, fn);
      listeners.length = 0;
      if (typeof unsub === 'function') unsub();
      if (statusTimer) clearTimeout(statusTimer);
      statusTimer = 0;
    },
  };
}
