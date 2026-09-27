/**
 * web/src/state.js [C] · store central (pub/sub simples).
 * Contrato: demo/CONTRACTS.md § "web/src/state.js [C]" + demo/UX-REBUILD.md.
 *
 *   export const store = { get(), set(patch), subscribe(fn) => unsubscribe }
 *
 * Invariantes:
 *   - get() devolve um snapshot raso (copia): nunca o estado interno.
 *   - set(patch) faz merge raso das chaves de `patch` e notifica todos os
 *     subscritores com o novo snapshot; devolve esse mesmo snapshot.
 *   - subscribe(fn) regista `fn(snapshot)` e devolve a função de cancelamento.
 *     Um subscritor que lance exceção não interrompe os restantes.
 *   - ESM puro, sem dependências, sem DOM, sem import de core/*.
 *
 * Chaves do store (todas presentes desde o arranque):
 *   training 'idle'|'running'|'paused' · generation · bestFitness · meanFitness ·
 *   mazeSize (7 por defeito: "tamanho do desafio") · seed ("labirinto nº") ·
 *   population ("redes em competição") · generations ("limite de épocas", 0 = até
 *   vencer) · speed (1 | 4 | 16 | 'max'; 16 = RÁPIDA por defeito) · viewMode
 *   (mantido por compatibilidade; o controlo foi removido na reconstrução de UX,
 *   valor 'live') · bankStats · nNeurons · nConns · episode · history ·
 *   autoRotate · solved · solvedCount · mazeCount ·
 *   stopReason ('solved' | 'limit' | null: motivo explícito de paragem) ·
 *   savedTrainings · selectedTrainingIds · memoryMode · playbackSource
 *   (EMENDA v5/E14: treinos guardados, comparação dupla e fonte de reprodução).
 *
 * Chaves E14 (treinos guardados):
 *   savedTrainings [{ id, name, meta, net }]  registos de web/src/training-store.js
 *       (meta = { mazeSize, seed, epochs, fitness, memoryMode, nIn, createdAt };
 *        net = rede em JSON simples: ver training-store.serializeNet)
 *   selectedTrainingIds [string]  ids escolhidos para comparação simultânea
 *       (máximo 2; vazio = sem comparação)
 *   memoryMode 'sinapses' | 'mapa' | 'ambos'  como a rede guarda memória
 *       ('sinapses' por defeito: memória nos próprios neurónios, vale para
 *        labirintos de qualquer tamanho)
 *   playbackSource { kind: 'champion' | 'training', id?: string }  o que reproduz
 *       agora no labirinto atual (campeão do treino ou um treino guardado).
 */

/** Estado inicial (chaves obrigatórias do contrato; formas livres). */
const initialState = {
  training: 'idle', // 'idle' | 'running' | 'paused'
  generation: 0, // número de épocas concluídas
  bestFitness: 0, // melhor resultado da última época
  meanFitness: 0, // resultado médio da última época
  mazeSize: 7, // lado do labirinto (ímpar, 5..31); defeito 7×7 = normal
  seed: 1, // "labirinto nº": inteiro que determina o labirinto
  population: 60, // "redes em competição"
  generations: 0, // "limite de épocas": 0 = treinar até vencer
  speed: 16, // 1 | 4 | 16 | 'max' (lenta | normal | rápida | máxima)
  viewMode: 'live', // 'live' | 'champion' (sem controlo na UI; compatibilidade)
  bankStats: {}, // { [opName]: { p, q, count } } (ver core/ops.mjs)
  nNeurons: 0, // neurónios vivos da rede atual
  nConns: 0, // ligações da rede atual
  episode: null, // { x, y, path, sensors, outputs, solved } | null
  history: [], // [{ gen, best, mean }] (uma entrada por época)
  autoRotate: false, // rotação automática da câmara (desligada por defeito)
  solved: false, // true quando o campeão resolveu todos os labirintos de treino
  solvedCount: 0, // labirintos de treino já resolvidos pelo campeão
  mazeCount: 0, // total de labirintos de treino
  stopReason: null, // 'solved' | 'limit' | null (motivo da última paragem)
  savedTrainings: [], // [{ id, name, meta, net }] (registos de training-store.js)
  selectedTrainingIds: [], // ids para comparação simultânea (máximo 2)
  memoryMode: 'sinapses', // 'sinapses' | 'mapa' | 'ambos' (memória da rede)
  playbackSource: { kind: 'champion' }, // { kind: 'champion'|'training', id? }
};

let state = { ...initialState };
const listeners = new Set();

function snapshot() {
  return { ...state };
}

function notify() {
  const snap = snapshot();
  for (const fn of Array.from(listeners)) {
    try {
      fn(snap);
    } catch (err) {
      console.error('[state] subscritor falhou:', err);
    }
  }
}

export const store = {
  /** @returns {object} cópia rasa do estado atual */
  get() {
    return snapshot();
  },

  /**
   * Merge raso de `patch` sobre o estado atual e notificação dos subscritores.
   * @param {object} patch
   * @returns {object} novo snapshot
   */
  set(patch) {
    if (patch == null || typeof patch !== 'object') {
      return snapshot();
    }
    state = { ...state, ...patch };
    notify();
    return snapshot();
  },

  /**
   * @param {(state: object) => void} fn
   * @returns {() => void} função de cancelamento (idempotente)
   */
  subscribe(fn) {
    if (typeof fn !== 'function') {
      throw new TypeError('store.subscribe(fn): fn tem de ser uma função');
    }
    listeners.add(fn);
    let active = true;
    return function unsubscribe() {
      if (active) {
        active = false;
        listeners.delete(fn);
      }
    };
  },
};
