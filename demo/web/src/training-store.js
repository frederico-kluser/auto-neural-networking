/**
 * web/src/training-store.js [Q] · treinos guardados (EMENDA v5, E14).
 * Contrato: demo/CONTRACTS.md § "EMENDA v5" E14 + demo/UX-REBUILD.md.
 *
 * Persistência de treinos treinados para os poder reproduzir depois (mesmo em
 * labirintos diferentes) e comparar dois de cada vez. Tudo síncrono, sem
 * dependências, sem DOM; corre no browser e em Node (com stub de localStorage).
 *
 * API exata (tudo síncrono, nunca lança exceções para o chamador):
 *   save({ name, meta, net }) -> record | null   (gera id; teto de 50; expulsa o mais antigo)
 *   list() -> record[]                            (mais recente primeiro; cópias rasas)
 *   load(id) -> record | null
 *   remove(id) -> boolean
 *   rename(id, name) -> record | null
 *   exportJSON() -> string
 *   importJSON(str) -> { added, skipped }         (tolerante a entrada corrompida)
 *   serializeNet(net) -> plain                    (typed arrays -> arrays simples)
 *   deserializeNet(plain) -> net                  (typed arrays repostas, invariantes íntegros)
 *   storageAvailable -> boolean                   (false = fallback em memória)
 *
 * Registo guardado: { id, name, meta, net } com
 *   meta = { mazeSize, seed, epochs, fitness, memoryMode, nIn, createdAt }
 *   net  = serialização JSON simples do Net do motor (core/network.mjs): inclui
 *          nIn, nOut, nSlots, alive, W, M, b, alpha, h, W_in, M_in, W_out, M_out,
 *          b_out, F, alphaJ, fastLambda, fastEta, fastOn (tipos: arrays simples; F/estados
 *          rápidos aceitam-se em falta e recebem valores por defeito).
 *
 * Ordem e teto: os registos guardam-se por ordem de inserção (o mais antigo é o
 * primeiro dentro do armazenamento). list() devolve essa ordem invertida (mais
 * recente primeiro). Ao passar de 50 registos, o guardado há mais tempo é
 * expulso. Registos devolvidos são cópias rasas (meta copiado; net partilhado
 * por referência: tratar como imutável).
 *
 * localStorage: chave `ann.trainings.v1`. Todas as operações são envolvidas em
 * try/catch; se o localStorage não existir ou falhar (modo privado, quota), o
 * módulo continua a funcionar em memória e `storageAvailable` fica a false.
 */

const STORAGE_KEY = 'ann.trainings.v1';
const PROBE_KEY = 'ann.probe.v1';
const MAX_RECORDS = 50;
const NAME_MAX = 60;

// limites aceites de dimensões (o motor: nSlots máx. 256, saídas 4; entradas
// podem chegar a 12 + 31*31 = 973 em modo mapa; folga para valores maiores)
const MAX_SLOTS = 256;
const MAX_NIN = 65536;
const MAX_NOUT = 64;

const DEFAULT_ALPHA = 0.25;
const DEFAULT_FAST_LAMBDA = 0.92;
const DEFAULT_FAST_ETA = 0.35;
const MEMORY_MODES = ['sinapses', 'mapa', 'ambos'];

// ---- utilitários internos (tolerantes; nunca lançam) ----

function toInt(v, fallback) {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? n : fallback;
}

function toFinite(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clampInt(v, min, max, fallback) {
  return Math.min(max, Math.max(min, toInt(v, fallback)));
}

/** Nome visível: sem caracteres de controlo, espaços colapsados, teto de 60. */
function sanitizeName(raw) {
  const s = String(raw == null ? '' : raw)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s.slice(0, NAME_MAX);
}

/**
 * Aceita arrays, typed arrays e o resultado de JSON.stringify sobre typed
 * arrays (objetos {0:..,1:..}), que é como as redes chegam quando alguém
 * serializa um registo à mão antes de o importar.
 */
function arrayLike(src) {
  if (!src || typeof src !== 'object') return src;
  if (typeof src.length === 'number') return src;
  const keys = Object.keys(src).filter((k) => /^\d+$/.test(k));
  if (!keys.length) return src;
  keys.sort((a, b) => Number(a) - Number(b));
  return keys.map((k) => src[k]);
}

/** alpha do motor: 0 < alpha <= 1; fora disso volta ao defeito. */
function sanitizeAlpha(v) {
  const a = toFinite(v, DEFAULT_ALPHA);
  if (a <= 0) return DEFAULT_ALPHA;
  return a > 1 ? 1 : a;
}

function sanitizeFastLambda(v) {
  const a = toFinite(v, DEFAULT_FAST_LAMBDA);
  return a < 0 ? 0 : a > 1 ? 1 : a;
}

function sanitizeFastEta(v) {
  const a = toFinite(v, DEFAULT_FAST_ETA);
  return a < 0 ? 0 : a > 100 ? 100 : a;
}

/** Copia array-like (typed ou simples) para Float64Array de tamanho exato. */
function copyFloats(srcIn, len) {
  const out = new Float64Array(len);
  const src = arrayLike(srcIn);
  if (src && typeof src.length === 'number') {
    const n = Math.min(len, src.length);
    for (let i = 0; i < n; i++) {
      const v = Number(src[i]);
      out[i] = Number.isFinite(v) ? v : 0;
    }
  }
  return out;
}

/** Copia array-like de bits (alive/M/M_in/M_out) para Uint8Array 0/1. */
function copyBits(srcIn, len) {
  const out = new Uint8Array(len);
  const src = arrayLike(srcIn);
  if (src && typeof src.length === 'number') {
    const n = Math.min(len, src.length);
    for (let i = 0; i < n; i++) {
      out[i] = Number(src[i]) >= 1 ? 1 : 0;
    }
  }
  return out;
}

const plainFloats = (src, len) => Array.from(copyFloats(src, len));
const plainBits = (src, len) => Array.from(copyBits(src, len));

/** Invariante do motor (core/network.mjs): M === 0 ⇒ W === 0. */
function zeroWhereMasked(W, M) {
  for (let i = 0; i < M.length; i++) {
    if (!M[i]) W[i] = 0;
  }
}

// ---- serialização do Net (typed arrays ↔ arrays simples) ----

/**
 * Serializa um Net do motor (ou um plain já serializado) para JSON simples.
 * Aceita typed arrays e arrays normais; campos em falta recebem valores por
 * defeito (F zerado, fastLambda 0.92, fastEta 0.35, fastOn true). Não altera o
 * objeto de entrada. A invariante M=0 ⇒ W=0 é imposta na cópia.
 *
 * @param {object} net
 * @returns {object} net em JSON simples (sempre bem formado)
 */
export function serializeNet(net) {
  const n = net && typeof net === 'object' ? net : {};
  const nIn = clampInt(n.nIn, 1, MAX_NIN, 1);
  const nOut = clampInt(n.nOut, 1, MAX_NOUT, 4);
  const nSlots = clampInt(n.nSlots, 1, MAX_SLOTS, 1);
  const sWW = nSlots * nSlots;
  const alive = plainBits(n.alive, nSlots);
  const W = plainFloats(n.W, sWW);
  const M = plainBits(n.M, sWW);
  const W_in = plainFloats(n.W_in, nIn * nSlots);
  const M_in = plainBits(n.M_in, nIn * nSlots);
  const W_out = plainFloats(n.W_out, nSlots * nOut);
  const M_out = plainBits(n.M_out, nSlots * nOut);
  zeroWhereMasked(W, M);
  zeroWhereMasked(W_in, M_in);
  zeroWhereMasked(W_out, M_out);
  return {
    nIn,
    nOut,
    nSlots,
    alive,
    W,
    M,
    b: plainFloats(n.b, nSlots),
    alpha: sanitizeAlpha(n.alpha),
    h: plainFloats(n.h, nSlots),
    W_in,
    M_in,
    W_out,
    M_out,
    b_out: plainFloats(n.b_out, nOut),
    F: plainFloats(n.F, sWW),
    alphaJ: plainFloats(n.alphaJ, nSlots), // E12: vazamento por neurónio (0 = herda alpha)
    fastLambda: sanitizeFastLambda(n.fastLambda),
    fastEta: sanitizeFastEta(n.fastEta),
    fastOn: typeof n.fastOn === 'boolean' ? n.fastOn : true,
  };
}

/**
 * Reconstrói um Net com typed arrays a partir do plain serializado. Tamanhos
 * repostos a partir de nIn/nOut/nSlots; invariantes do motor garantidas
 * (M ∈ {0,1}, M=0 ⇒ W=0, idem M_in/M_out; F zerado onde M=0). Nunca lança:
 * valores inválidos caem nos defeitos do motor.
 *
 * @param {object} plain
 * @returns {object} Net pronto para core/network.mjs (step, cloneNet, ...)
 */
export function deserializeNet(plain) {
  const p = plain && typeof plain === 'object' ? plain : {};
  const nIn = clampInt(p.nIn, 1, MAX_NIN, 1);
  const nOut = clampInt(p.nOut, 1, MAX_NOUT, 4);
  const nSlots = clampInt(p.nSlots, 1, MAX_SLOTS, 1);
  const sWW = nSlots * nSlots;
  const alive = copyBits(p.alive, nSlots);
  const W = copyFloats(p.W, sWW);
  const M = copyBits(p.M, sWW);
  const b = copyFloats(p.b, nSlots);
  const h = copyFloats(p.h, nSlots);
  const W_in = copyFloats(p.W_in, nIn * nSlots);
  const M_in = copyBits(p.M_in, nIn * nSlots);
  const W_out = copyFloats(p.W_out, nSlots * nOut);
  const M_out = copyBits(p.M_out, nSlots * nOut);
  const b_out = copyFloats(p.b_out, nOut);
  const F = copyFloats(p.F, sWW);
  zeroWhereMasked(W, M);
  zeroWhereMasked(W_in, M_in);
  zeroWhereMasked(W_out, M_out);
  zeroWhereMasked(F, M);
  return {
    nIn,
    nOut,
    nSlots,
    alive,
    W,
    M,
    b,
    alpha: sanitizeAlpha(p.alpha),
    h,
    W_in,
    M_in,
    W_out,
    M_out,
    b_out,
    F,
    alphaJ: p.alphaJ ? Float64Array.from(p.alphaJ.map((v) => (Number.isFinite(v) && v >= 0 && v <= 1 ? v : 0))) : new Float64Array(nSlots),
    fastLambda: sanitizeFastLambda(p.fastLambda),
    fastEta: sanitizeFastEta(p.fastEta),
    fastOn: typeof p.fastOn === 'boolean' ? p.fastOn : true,
  };
}

/** Forma mínima de um net utilizável: dimensões válidas + arrays estruturais. */
function isNetShapeOk(raw) {
  try {
    if (!raw || typeof raw !== 'object') return false;
    const nIn = toInt(raw.nIn, NaN);
    const nOut = toInt(raw.nOut, NaN);
    const nSlots = toInt(raw.nSlots, NaN);
    if (!Number.isFinite(nIn) || nIn < 1 || nIn > MAX_NIN) return false;
    if (!Number.isFinite(nOut) || nOut < 1 || nOut > MAX_NOUT) return false;
    if (!Number.isFinite(nSlots) || nSlots < 1 || nSlots > MAX_SLOTS) return false;
    const need = [
      [raw.alive, nSlots],
      [raw.W, nSlots * nSlots],
      [raw.M, nSlots * nSlots],
      [raw.b, nSlots],
      [raw.h, nSlots],
      [raw.W_in, nIn * nSlots],
      [raw.M_in, nIn * nSlots],
      [raw.W_out, nSlots * nOut],
      [raw.M_out, nSlots * nOut],
      [raw.b_out, nOut],
    ];
    for (const [item, len] of need) {
      const arr = arrayLike(item);
      if (!arr || typeof arr.length !== 'number' || arr.length < len) return false;
    }
    return true;
  } catch {
    return false;
  }
}

// ---- normalização de registos ----

function sanitizeMeta(raw, net) {
  const m = raw && typeof raw === 'object' ? raw : {};
  const memoryMode = MEMORY_MODES.indexOf(m.memoryMode) >= 0 ? m.memoryMode : 'sinapses';
  return {
    mazeSize: clampInt(m.mazeSize, 0, 99, 0),
    seed: clampInt(m.seed, 0, 2147483647, 0),
    epochs: clampInt(m.epochs, 0, 1000000000, 0),
    fitness: toFinite(m.fitness, 0),
    memoryMode,
    nIn: clampInt(m.nIn, 1, MAX_NIN, net ? net.nIn : 1),
    createdAt: clampInt(m.createdAt, 0, Number.MAX_SAFE_INTEGER, Date.now()),
  };
}

function defaultRecordName(meta) {
  if (meta && meta.mazeSize > 0) {
    return `${meta.mazeSize}\u00d7${meta.mazeSize} \u00b7 labirinto ${meta.seed}`;
  }
  return 'treino';
}

let idCounter = 0;
function makeId() {
  let id = '';
  do {
    idCounter += 1;
    const t = Date.now().toString(36);
    const r = Math.random().toString(36).slice(2, 8);
    id = `t${t}-${idCounter.toString(36)}-${r}`;
  } while (cache && cache.some((x) => x.id === id));
  return id;
}

/**
 * Converte um objeto bruto (guardado, importado ou recebido em save) num
 * registo normalizado; null se não houver rede utilizável.
 * opts.requireId: exige id string válido (carga do armazenamento).
 * opts.forceNewId: gera sempre id novo (save).
 */
function normalizeRecord(raw, opts = {}) {
  try {
    if (!raw || typeof raw !== 'object') return null;
    if (!isNetShapeOk(raw.net)) return null;
    let id = null;
    if (!opts.forceNewId && typeof raw.id === 'string' && raw.id.length > 0 && raw.id.length <= 120) {
      id = raw.id;
    } else if (opts.requireId) {
      return null;
    }
    const net = serializeNet(raw.net);
    const meta = sanitizeMeta(raw.meta, net);
    const name = sanitizeName(raw.name) || defaultRecordName(meta);
    return { id: id || makeId(), name, meta, net };
  } catch {
    return null;
  }
}

function cloneRecord(r) {
  return { id: r.id, name: r.name, meta: { ...r.meta }, net: r.net };
}

// ---- camada de armazenamento (localStorage com fallback em memória) ----

let storage = undefined; // undefined = ainda não sondado; null = indisponível
let cache = null; // fonte de verdade em memória (também é o fallback)

/** @type {boolean} true quando o localStorage responde; false = só memória. */
export let storageAvailable = false;

function getStorage() {
  if (storage !== undefined) return storage;
  storage = null;
  try {
    const s = globalThis.localStorage;
    if (
      s &&
      typeof s.getItem === 'function' &&
      typeof s.setItem === 'function' &&
      typeof s.removeItem === 'function'
    ) {
      s.setItem(PROBE_KEY, '1');
      s.removeItem(PROBE_KEY);
      storage = s;
    }
  } catch {
    storage = null;
  }
  storageAvailable = storage !== null;
  return storage;
}

function persist() {
  const s = getStorage();
  if (!s) return;
  try {
    s.setItem(STORAGE_KEY, JSON.stringify(cache));
  } catch {
    // quota excedida ou escrita bloqueada: continua em memória
    storage = null;
    storageAvailable = false;
  }
}

function ensureLoaded() {
  if (cache) return cache;
  cache = [];
  const s = getStorage();
  if (!s) return cache;
  try {
    const raw = s.getItem(STORAGE_KEY);
    if (!raw) return cache;
    const data = JSON.parse(raw);
    const items = Array.isArray(data)
      ? data
      : data && typeof data === 'object' && Array.isArray(data.records)
        ? data.records
        : [];
    for (const item of items) {
      const rec = normalizeRecord(item, { requireId: true });
      if (rec && !cache.some((x) => x.id === rec.id)) cache.push(rec);
    }
    while (cache.length > MAX_RECORDS) cache.shift(); // teto também em dados antigos
  } catch {
    cache = []; // conteúdo corrompido: começa vazio (nunca lança)
  }
  return cache;
}

// sonda o armazenamento ao arrancar (assim storageAvailable está logo correto)
getStorage();

// ---- API pública ----

/**
 * Guarda { name, meta, net } e devolve o registo criado (com id novo).
 * O teto é de 50 registos: o guardado há mais tempo é expulso. Devolve null só
 * quando não há rede utilizável (nunca fabrica uma rede).
 *
 * @param {{ name?: string, meta?: object, net?: object }} recordWithoutId
 * @returns {{ id: string, name: string, meta: object, net: object } | null}
 */
export function save(recordWithoutId) {
  try {
    const rec = normalizeRecord(recordWithoutId, { forceNewId: true });
    if (!rec) return null;
    const records = ensureLoaded();
    records.push(rec);
    while (records.length > MAX_RECORDS) records.shift();
    persist();
    return cloneRecord(rec);
  } catch {
    return null;
  }
}

/**
 * Lista os treinos guardados (mais recente primeiro).
 * @returns {Array<{ id: string, name: string, meta: object, net: object }>}
 */
export function list() {
  try {
    return ensureLoaded().map(cloneRecord).reverse();
  } catch {
    return [];
  }
}

/**
 * @param {string} id
 * @returns {{ id: string, name: string, meta: object, net: object } | null}
 */
export function load(id) {
  try {
    const r = ensureLoaded().find((x) => x.id === id);
    return r ? cloneRecord(r) : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} id
 * @returns {boolean} true se um registo foi apagado
 */
export function remove(id) {
  try {
    const records = ensureLoaded();
    const i = records.findIndex((x) => x.id === id);
    if (i < 0) return false;
    records.splice(i, 1);
    persist();
    return true;
  } catch {
    return false;
  }
}

/**
 * Muda o nome do treino (nome vazio/nulo mantém o anterior).
 * @param {string} id
 * @param {string} name
 * @returns {object | null} registo atualizado ou null se o id não existir
 */
export function rename(id, name) {
  try {
    const records = ensureLoaded();
    const r = records.find((x) => x.id === id);
    if (!r) return null;
    const v = sanitizeName(name);
    if (v) r.name = v;
    persist();
    return cloneRecord(r);
  } catch {
    return null;
  }
}

/**
 * Exporta tudo como JSON (envelope com chave e versão; os dados são os registos).
 * @returns {string}
 */
export function exportJSON() {
  try {
    return JSON.stringify({ key: STORAGE_KEY, version: 1, records: ensureLoaded().map(cloneRecord) });
  } catch {
    return JSON.stringify({ key: STORAGE_KEY, version: 1, records: [] });
  }
}

/**
 * Importa JSON (envelope { records: [...] }, lista simples ou um registo só).
 * Tolerante a entrada corrompida: nunca lança; o que não for utilizável conta
 * como "skipped" (incluindo o JSON ilegível, que conta como 1 entrada inútil).
 * Registos com id já existente são ignorados (não duplica).
 *
 * @param {string} str
 * @returns {{ added: number, skipped: number }}
 */
export function importJSON(str) {
  const out = { added: 0, skipped: 0 };
  try {
    if (typeof str !== 'string' || !str.trim()) return out;
    let data;
    try {
      data = JSON.parse(str);
    } catch {
      return { added: 0, skipped: 1 };
    }
    let items;
    if (Array.isArray(data)) {
      items = data;
    } else if (data && typeof data === 'object' && Array.isArray(data.records)) {
      items = data.records;
    } else if (data && typeof data === 'object' && data.net) {
      items = [data];
    } else {
      return { added: 0, skipped: 1 };
    }
    const records = ensureLoaded();
    for (const raw of items) {
      const rec = normalizeRecord(raw, {});
      if (!rec) {
        out.skipped += 1;
        continue;
      }
      if (records.some((x) => x.id === rec.id)) {
        out.skipped += 1; // já existe: não duplica
        continue;
      }
      records.push(rec);
      out.added += 1;
    }
    while (records.length > MAX_RECORDS) records.shift();
    persist();
    return out;
  } catch {
    return out;
  }
}
