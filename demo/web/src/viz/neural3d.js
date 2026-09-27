/**
 * neural3d.js [D] — visualização 3D "hero" da rede de neurónios
 * (demo/CONTRACTS.md § Visualização 3D [D] + EMENDA v2 · E3 + EMENDA v4 · E7/E8).
 *
 * createNeuralView(container) -> { update(net, activity), resize(), dispose(), setCameraPreset(name),
 *                                  setAutoRotate(enabled) }
 *
 * INPUT (EMENDA v4 · E7): net.nIn = 12 + cols*rows (variável com o labirinto).
 *   - índices 0..11 = sinais nomeados (0..3 paredes, 4..7 saída visível, 8..11 fração visitada);
 *   - índices 12+idx (idx = y*cols + x) = estado do mapa: 0 nunca visitada, 0.5 visitada,
 *     1.0 posição ATUAL do agente;
 *   - update(net, activity) recebe activity = { h, y, inputs, solved, maze?: { cols, rows } };
 *     `maze` é opcional — sem ele deriva-se cols/rows fatorando nIn-12 (par mais quadrado;
 *     sem fatoração própria => arco compacto até 24 células, grelha aproximada acima disso).
 *
 * E8 — as três features obrigatórias:
 *
 * 1) DISTÂNCIA MÍNIMA entre quaisquer dois nós visíveis:
 *    - ocultos: configuração fixa de 256 pontos sobre a casca (raio SHELL_R) construída UMA vez:
 *      espiral de ângulo dourado (índice de slot permutado por ×151 mod 256 para os slots
 *      consecutivos se espalharem) + relaxação determinística push-apart (Gauss-Seidel com
 *      reprojeção à casca) até min >= MIN_DIST. Como o conjunto dos 256 satisfaz MIN_DIST,
 *      QUALQUER subconjunto (qualquer alive-count 1..256) satisfaz também — e a posição de cada
 *      slot é uma função PURA do índice: estável para sempre, sem recomputação por frame nem
 *      sequer quando o conjunto vivo muda (a posição do slot s NUNCA se move);
 *    - 12 sinais: arco fixo com espaçamento igual em comprimento de arco (>= MIN_DIST);
 *    - 4 saídas: arco fixo idem;
 *    - mapa: grelha de passo fixo MAP_STEP (menor que MIN_DIST de propósito: o mapa é um painel
 *      "mini-mapa" separado, ver abaixo); nós de mapa nunca se sobrepõem (diâmetro <= 0.27 <
 *      MAP_STEP = 0.34) e o painel (z = MAP_Z) fica >= 3.7 unidades de tudo o resto, portanto os
 *      dois regimes de espaçamento nunca interagem.
 *    - invariantes numéricos: MIN_DIST = 0.95 > diâmetro máximo de qualquer nó da casca/arcos
 *      (saídas 0.864) => nada se sobrepõe mesmo com 256 slots.
 *
 * 2) VALOR ESCRITO EM CADA NÓ: rótulo numérico por sprite de texto (NUNCA DOM) — UM InstancedMesh
 *    de quadrados billboard + UM atlas de glifos pré-desenhado em canvas (tira de células 16×64px,
 *    glifo branco com contorno escuro). O texto de cada instância viaja em atributos instanciados
 *    (6 caracteres empacotados 2 por float + comprimento); o shader escolhe a célula do glifo por
 *    fragmento. Recursos partilhados: 1 textura, 1 material, 1 draw call para todos os rótulos.
 *    Atualização SÓ quando a string/cor mudam (key quantizada por valor — zero alocação quando o
 *    valor está estável). Formato curto: `-0.15`, `0.5`, `1`, `0`, `99+`.
 *    Cor: positivo âmbar #F5B04A, negativo ardósia #5C6B7A, zero (|v| < 0.005) ténue #9A9AA3;
 *    intensidade = 0.55 + 0.45·min(1,|v|).
 *    Cobertura: 12 sinais + até 256 ocultos vivos + 4 saídas (até 272 rótulos).
 *    DECISÃO DOCUMENTADA: as células do mapa NÃO levam rótulo (31×31 ⇒ 12px/célula na câmara
 *    por defeito — texto ilegível); o contrato E8 diz que na grelha do mapa os valores são
 *    codificados pela luz, e o enunciado torna os rótulos do mapa OPCIONAIS. Conta e cor do mapa
 *    fazem o trabalho visual.
 *
 * 3) MAPA DE ENTRADAS ACENDE: as entradas 12+idx desenham-se como grelha (mini-mapa, passo fixo
 *    MAP_STEP, painel vertical em z = MAP_Z): 0 = escuro/discreto (escala mínima), 0.5 = âmbar a
 *    ~35% de intensidade, 1.0 = âmbar a 100% + escala ligeiramente maior (posição do agente).
 *    Interpola-se linearmente entre os três estados; acende célula a célula em tempo real.
 *
 * DESEMPENHO (orçamento rígido, >= 55 fps com 256 neurónios + 4000 arestas + 31×31 mapa + labels):
 *  - neurónios: UM InstancedMesh (1233 instâncias: 12 sinais + 961 mapa + 4 saídas + 256 slots),
 *    cor/escala por instância, esfera de baixa poligonagem (12×8);
 *  - ligações: UM LineSegments com position/color RGBA prealocados, reescritos in place APENAS
 *    quando topologia/pesos/forma do mapa mudam (scan profundo contra snapshot; nunca por frame).
 *    Cap ~4000 por |w| com cotas ESTRATIFICADAS por família (documentado em rebuildEdges):
 *    HH 2000 · sinais→ocultos 600 · mapa→ocultos 1000 · ocultos→saídas 400; famílias que não
 *    enchem a sua cota são repostas por um 2.º passe global (threshold por fusão das 4 regiões
 *    ordenadas) — assim as arestas do mapa têm representação justa sem esmagar a estrutura HH;
 *  - rótulos: UM InstancedMesh de quadrados + UM CanvasTexture de glifos; escrita por instância
 *    só em mudança (keys inteiras), um upload de buffer por atributo por frame em que algo mudou;
 *  - pulsos: UM InstancedMesh (orçamento 256) com transformadas CPU (|h_from·w| + fase, fade
 *    sin(πu) nas pontas);
 *  - UM único loop rAF e só enquanto anima (órbita automática — off por defeito —, pulsos, tween
 *    de câmara ou drag); em regime estável o render é on-demand;
 *  - zero alocação em regime estável: todos os buffers (incluindo candidatos de arestas, até
 *    315 648) são pré-alocados; a formatação numérica só aloca quando o valor muda.
 *
 * setAutoRotate(enabled) (EMENDA v2 · E3): liga/desliga a órbita automática da câmara.
 *   - por defeito DESLIGADA (página parada; câmara continua totalmente interativa com damping);
 *   - false pára de imediato, sem velocidade angular residual (ver stopOrbitCleanly);
 *   - prefers-reduced-motion recusa sempre ligar (syncControls força off).
 */

import * as THREE from 'three';
import { OrbitControls } from '../../vendor/OrbitControls.js'; // web/vendor/ (2 níveis acima de src/viz/)

// ---- constantes de layout / orçamento ----
const N_SIG = 12; // sinais nomeados (EMENDA v4/E7: índices 0..11)
const N_OUT = 4; // leitura da rede
const MAX_SLOTS = 256; // nSlots máximo do contrato
const MAX_MAP = 31 * 31; // maior mapa da UI (31×31)
const MAP_BASE = N_SIG; // célula idx vive no NÓ 12+idx (= índice de input, coincidência feliz)
const OUT_BASE = MAP_BASE + MAX_MAP; // nós das saídas
const HID_BASE = OUT_BASE + N_OUT; // nó do slot oculto s = HID_BASE + s
const MAX_NODES = HID_BASE + MAX_SLOTS; // 1233 instâncias
const MAX_LABELS = N_SIG + N_OUT + MAX_SLOTS; // 272 rótulos (mapa sem rótulo — ver cabeçalho)

// Espaçamento mínimo garantido entre quaisquer dois nós da casca/arcos (sinais, saídas, ocultos).
const MIN_DIST = 0.95;
const SHELL_R = 4.5; // raio da casca dos ocultos
const MAP_STEP = 0.34; // passo fixo da grelha do mapa (painel "mini-mapa")
const MAP_Z = -8.2; // plano do painel do mapa (bem atrás da casca: separação >= 3.7)
const MAP_CELL_R0 = 0.075; // escala da célula nunca visitada (discreta)
const MAP_CELL_R1 = 0.135; // escala da célula = posição atual (ligeiramente maior)

// Cap de ligações desenhadas (~4000), repartido por família — ver rebuildEdges().
const MAX_EDGES = 4000;
const FAM_HH = 0, FAM_SIG = 1, FAM_MAP = 2, FAM_HO = 3, N_FAM = 4;
const FAM_CAP = [2000, 600, 1000, 400]; // soma = MAX_EDGES
const MAX_CAND = MAX_SLOTS * MAX_SLOTS + N_SIG * MAX_SLOTS + MAX_MAP * MAX_SLOTS + MAX_SLOTS * N_OUT;

const PULSE_BUDGET = 256;
const PULSE_SPEED = 0.55; // fases/segundo (uma passagem por aresta em ~1.8 s)
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5)); // espiral uniforme sobre a esfera

// ---- rótulos: atlas de glifos + formato ----
const MAXLEN = 6; // caracteres por rótulo ("-0.15", "99+", ...)
const GLYPH_CELLS = 16; // células no atlas (13 usadas; restantes em branco)
const GLYPH_PX = 64; // pixels por célula do atlas
const GLYPH_SPACE = 15; // índice de célula em branco
const LAB_CELL = 0.52; // lado de um glifo em unidades de mundo (escala 1)
const LAB_SCALE_HID = 0.85; // rótulos dos ocultos (densos) ligeiramente mais pequenos
const LAB_Y_SIG = 0.72, LAB_Y_OUT = 0.8, LAB_Y_HID = 0.52; // âncora acima do nó

// ---- linguagem visual (vinculativa) ----
const COL_BASE = new THREE.Color(0x9a9aa3); // cinza neutro dos neurónios
const COL_HOT = new THREE.Color(0xe8e8ea); // brilho intermédio da rampa
const COL_AMBER = new THREE.Color(0xf5b04a); // ativação quente / pesos positivos (E8: positivo)
const COL_SLATE = new THREE.Color(0x5c6b7a); // pesos negativos / rótulos negativos (E8)
const COL_SLATE_LIGHT = new THREE.Color(0x8fa3b5); // pulsos em arestas negativas (visíveis no vazio)
const COL_GREEN = new THREE.Color(0x3fb984); // semântica "resolvido" (só output com max y)
const COL_MAP_DARK = new THREE.Color(0x2e3138); // célula do mapa nunca visitada (discreta)
const COL_LABEL_ZERO = new THREE.Color(0x9a9aa3); // rótulo de valor zero (E8)

const PRESETS = {
  geral: { pos: [11.5, 7.2, 14.5], tgt: [0, 0, 0] },
  frente: { pos: [0, 1.5, 20.5], tgt: [0, 0, 0] },
  topo: { pos: [0.5, 19.5, 3.2], tgt: [0, 0, 0] },
};

const frac = (x) => x - Math.floor(x);

// ---------------------------------------------------------------------------
// Formatação curta de valores (E8): `1`, `0.5`, `-0.15`, `0`, `12.3`, `99+`.
// A chave de string é função injetiva da chave => nunca há escrita com string
// errada; chaves iguais garantem strings iguais (cache por chave, sem alocação
// quando o valor está estável).
// ---------------------------------------------------------------------------
function trimZeros(s) {
  let e = s.length;
  while (e > 0 && s.charCodeAt(e - 1) === 48) e--; // '0'
  if (e > 0 && s.charCodeAt(e - 1) === 46) e--; // '.'
  return s.slice(0, e);
}

function fmtVal(v) {
  if (!(v <= 0 || v >= 0)) return '0'; // NaN/±∞ mostram-se como zero ténue
  const a = v < 0 ? -v : v;
  if (a < 0.005) return '0'; // limiar de "zero" (compartilhado com a cor)
  if (a >= 100) return v < 0 ? '-99+' : '99+';
  return trimZeros(a >= 10 ? v.toFixed(1) : v.toFixed(2));
}

function strKeyOf(v) {
  const a = v < 0 ? -v : v;
  const sign = v < 0 ? -1 : 1;
  const reg = a >= 100 ? 2 : a >= 10 ? 1 : 0; // mesmo corte do fmtVal
  const q = reg === 2 ? 0 : Math.min(10000, Math.round(a * 100));
  return sign * (reg * 10001 + q);
}

function colKeyOf(v) {
  const a = v < 0 ? -v : v;
  const cls = a < 0.005 ? 0 : v > 0 ? 1 : 2; // zero / positivo / negativo
  return cls * 33 + Math.min(32, Math.round(32 * Math.min(1, a)));
}

function glyphIndex(code) {
  if (code >= 48 && code <= 57) return code - 48; // '0'..'9'
  if (code === 46) return 10; // '.'
  if (code === 45) return 11; // '-'
  if (code === 43) return 12; // '+'
  return GLYPH_SPACE;
}

// ---------------------------------------------------------------------------
// Geometria de layout (funções puras, memoizadas ao nível do módulo):
//   - arcPoints: pontos igualmente espaçados em comprimento de arco (sinais/saídas);
//   - getShell: configuração relaxada dos 256 slots ocultos (posições IMUTÁVEIS por índice).
// ---------------------------------------------------------------------------
function arcPoints(cx0, cxA, cy, cz, aMin, aMax, n) {
  const S = 512;
  const xs = new Float64Array(S + 1);
  const ys = new Float64Array(S + 1);
  const zs = new Float64Array(S + 1);
  const cum = new Float64Array(S + 1);
  for (let k = 0; k <= S; k++) {
    const a = aMin + ((aMax - aMin) * k) / S;
    xs[k] = cx0 + cxA * Math.cos(a);
    ys[k] = cy * Math.sin(a);
    zs[k] = cz * Math.cos(a) + 1.0;
    if (k > 0) {
      cum[k] = cum[k - 1] + Math.hypot(xs[k] - xs[k - 1], ys[k] - ys[k - 1], zs[k] - zs[k - 1]);
    }
  }
  const out = new Float32Array(n * 3);
  let placed = 0;
  for (let k = 0; k <= S && placed < n; k++) {
    while (placed < n && cum[k] >= (placed * cum[S]) / (n - 1)) {
      const i3 = placed * 3;
      out[i3] = xs[k];
      out[i3 + 1] = ys[k];
      out[i3 + 2] = zs[k];
      placed++;
    }
  }
  while (placed < n) {
    // garante o último ponto (fim do arco)
    const i3 = placed * 3;
    out[i3] = xs[S];
    out[i3 + 1] = ys[S];
    out[i3 + 2] = zs[S];
    placed++;
  }
  return out;
}

let shellCache = null; // Float32Array(256*3): posição fixa do slot oculto s
function getShell() {
  if (shellCache) return shellCache;
  const N = MAX_SLOTS;
  const R = SHELL_R;
  const px = new Float64Array(N);
  const py = new Float64Array(N);
  const pz = new Float64Array(N);
  for (let s = 0; s < N; s++) {
    // espiral de ângulo dourado sobre a casca; a permutação ×151 mod 256 (151 coprimo com 256)
    // mantém a posição função pura do índice E espalha slots consecutivos por toda a casca
    const j = (s * 151) % N;
    const t = (j + 0.5) / N;
    const yy = 1 - 2 * t;
    const rr = Math.sqrt(Math.max(0, 1 - yy * yy));
    const th = j * GOLDEN_ANGLE;
    px[s] = R * rr * Math.cos(th);
    py[s] = R * yy;
    pz[s] = R * rr * Math.sin(th);
  }
  // relaxação determinística push-apart (Gauss-Seidel + reprojeção à casca), UMA vez:
  // o conjunto dos 256 fica com min >= MIN_DIST => qualquer subconjunto também (alive-count
  // arbitrário até 256 sem recomputar nada) e cada slot tem posição estável para sempre.
  const MIN2 = MIN_DIST * MIN_DIST;
  for (let it = 0; it < 128; it++) {
    let worst = Infinity;
    for (let i = 0; i < N; i++) {
      for (let j = i + 1; j < N; j++) {
        let dx = px[i] - px[j];
        let dy = py[i] - py[j];
        let dz = pz[i] - pz[j];
        const d2 = dx * dx + dy * dy + dz * dz;
        const d = Math.sqrt(d2);
        if (d < worst) worst = d;
        if (d2 < MIN2) {
          if (d < 1e-9) {
            dx = 1e-3;
            dy = 1e-3;
            dz = 1e-3;
          }
          const f = ((MIN_DIST - d) / (d || 1)) * 0.55;
          px[i] += dx * f;
          py[i] += dy * f;
          pz[i] += dz * f;
          px[j] -= dx * f;
          py[j] -= dy * f;
          pz[j] -= dz * f;
          // reprojeção à casca (desenrolado: zero alocações no ciclo quente)
          let li = Math.hypot(px[i], py[i], pz[i]) || 1;
          px[i] *= R / li;
          py[i] *= R / li;
          pz[i] *= R / li;
          let lj = Math.hypot(px[j], py[j], pz[j]) || 1;
          px[j] *= R / lj;
          py[j] *= R / lj;
          pz[j] *= R / lj;
        }
      }
    }
    if (worst >= MIN_DIST) break;
  }
  shellCache = new Float32Array(N * 3);
  for (let s = 0; s < N; s++) {
    shellCache[s * 3] = px[s];
    shellCache[s * 3 + 1] = py[s];
    shellCache[s * 3 + 2] = pz[s];
  }
  return shellCache;
}

let sigArcCache = null;
let outArcCache = null;
function getSigArc() {
  if (!sigArcCache) sigArcCache = arcPoints(-8.7, -0.85, 6.2, -2.3, -1.2, 1.2, N_SIG);
  return sigArcCache;
}
function getOutArc() {
  if (!outArcCache) outArcCache = arcPoints(8.7, 0.85, 4.2, -2.0, -0.72, 0.72, N_OUT);
  return outArcCache;
}

// Deriva a forma do mapa a partir de nIn (e de activity.maze quando presente e coerente).
// Par mais quadrado com ambos os fatores >= 2; sem fatoração => arco compacto (<= 24 células)
// ou grelha aproximada (acima, para não perder o passo fixo em números primos grandes).
// Devolve a assinatura da forma; o objeto `out` é sempre preenchido. Chamado por update(), mas
// o trabalho real (layout/arestas) só acontece quando a assinatura muda.
function resolveMapShape(out, nIn, activity) {
  const count = Math.max(0, Math.min(nIn - N_SIG, MAX_MAP));
  const m = activity && activity.maze;
  let cols = 0;
  let rows = 0;
  let grid = false;
  if (m && (m.cols | 0) >= 1 && (m.rows | 0) >= 1 && (m.cols | 0) * (m.rows | 0) === count) {
    cols = m.cols | 0;
    rows = m.rows | 0;
    grid = cols <= 48 && rows <= 48;
  } else {
    for (let c = 2; c * c <= count; c++) {
      if (count % c !== 0) continue;
      const r = count / c;
      if (!cols || r - c < rows - cols) {
        cols = c;
        rows = r;
      }
    }
    grid = !!cols && cols <= 48 && rows <= 48;
  }
  if (!grid && count > 24) {
    // primos grandes: grelha aproximada (última linha incompleta) mantém o passo fixo
    cols = Math.max(1, Math.floor(Math.sqrt(count)));
    rows = Math.ceil(count / cols);
    grid = true;
  }
  out.count = count;
  out.cols = cols;
  out.rows = rows;
  out.grid = grid;
  out.sig = count * 65536 + cols * 256 + rows + (grid ? 32768 : 0);
  return out.sig;
}

export function createNeuralView(container) {
  // ---------- renderer / cena / câmara ----------
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setClearColor(0x000000, 0); // fundo transparente: a página fornece #0B0B0D
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  const canvas = renderer.domElement;
  canvas.style.display = 'block';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  container.appendChild(canvas);

  const scene = new THREE.Scene(); // vazio limpo: sem grelha, sem estrelas, sem fog
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 140);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.075;
  controls.enablePan = false;
  controls.minDistance = 8;
  controls.maxDistance = 45;
  controls.minPolarAngle = 0.22; // ângulo polar clampado (nunca atravessa os polos)
  controls.maxPolarAngle = Math.PI - 0.22;
  controls.autoRotateSpeed = 0.45; // órbita lenta (~133 s/órbita a 60 fps)

  const rmQuery = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const reducedMotion = () => !!(rmQuery && rmQuery.matches);
  let pulsesTravel = !reducedMotion();

  // ---------- layout determinístico (estável entre updates) ----------
  const nodePos = new Float32Array(MAX_NODES * 3); // índice de nó: sinais, mapa, saídas, slots
  {
    const sig = getSigArc();
    for (let k = 0; k < N_SIG; k++) {
      nodePos[k * 3] = sig[k * 3];
      nodePos[k * 3 + 1] = sig[k * 3 + 1];
      nodePos[k * 3 + 2] = sig[k * 3 + 2];
    }
    const out = getOutArc();
    for (let o = 0; o < N_OUT; o++) {
      const i3 = (OUT_BASE + o) * 3;
      nodePos[i3] = out[o * 3];
      nodePos[i3 + 1] = out[o * 3 + 1];
      nodePos[i3 + 2] = out[o * 3 + 2];
    }
    const shell = getShell();
    for (let s = 0; s < MAX_SLOTS; s++) {
      // posição do slot = função pura do índice (imutável; ver cabeçalho E8 · 1)
      const i3 = (HID_BASE + s) * 3;
      nodePos[i3] = shell[s * 3];
      nodePos[i3 + 1] = shell[s * 3 + 1];
      nodePos[i3 + 2] = shell[s * 3 + 2];
    }
    // nós do mapa: preenchidos por layoutMap() quando a forma do mapa é conhecida
    for (let i = 0; i < MAX_MAP; i++) {
      const i3 = (MAP_BASE + i) * 3;
      nodePos[i3] = 0;
      nodePos[i3 + 1] = 0;
      nodePos[i3 + 2] = MAP_Z;
    }
  }

  // ---------- neurónios: 1 InstancedMesh ----------
  const neuronGeo = new THREE.SphereGeometry(1, 12, 8);
  const neuronMat = new THREE.MeshBasicMaterial({ toneMapped: false });
  const neuronMesh = new THREE.InstancedMesh(neuronGeo, neuronMat, MAX_NODES);
  neuronMesh.frustumCulled = false;
  neuronMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  neuronMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_NODES * 3).fill(1), 3);
  neuronMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  scene.add(neuronMesh);

  // ---------- rótulos (E8): 1 InstancedMesh de quadrados + 1 atlas de glifos ----------
  const atlasCanvas = document.createElement('canvas');
  atlasCanvas.width = GLYPH_CELLS * GLYPH_PX;
  atlasCanvas.height = GLYPH_PX;
  {
    const g = atlasCanvas.getContext('2d');
    g.clearRect(0, 0, atlasCanvas.width, atlasCanvas.height);
    g.font = `bold ${Math.round(GLYPH_PX * 0.72)}px "DejaVu Sans Mono", "Menlo", monospace`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineWidth = Math.max(3, Math.round(GLYPH_PX * 0.11));
    g.lineJoin = 'round';
    g.strokeStyle = 'rgba(0,0,0,0.92)'; // contorno escuro => contraste sobre qualquer fundo
    g.fillStyle = '#ffffff'; // máscara branca; o shader tinge com a cor do valor
    const chars = '0123456789-+';
    for (let i = 0; i < chars.length; i++) {
      const cx = i * GLYPH_PX + GLYPH_PX / 2;
      const cy = GLYPH_PX / 2 + GLYPH_PX * 0.02;
      g.strokeText(chars[i], cx, cy);
      g.fillText(chars[i], cx, cy);
    }
  }
  const atlasTex = new THREE.CanvasTexture(atlasCanvas);
  atlasTex.minFilter = THREE.LinearFilter;
  atlasTex.magFilter = THREE.LinearFilter;
  atlasTex.generateMipmaps = false;

  const labPack = new Float32Array(MAX_LABELS * 3); // 6 glifos empacotados 2 por float
  const labInfo = new Float32Array(MAX_LABELS * 2); // (comprimento, escala)
  const labPosArr = new Float32Array(MAX_LABELS * 3);
  const labColArr = new Float32Array(MAX_LABELS * 3);
  const labelGeo = new THREE.PlaneGeometry(MAXLEN * LAB_CELL, LAB_CELL);
  const labPackAttr = new THREE.InstancedBufferAttribute(labPack, 3);
  const labInfoAttr = new THREE.InstancedBufferAttribute(labInfo, 2);
  const labPosAttr = new THREE.InstancedBufferAttribute(labPosArr, 3);
  const labColAttr = new THREE.InstancedBufferAttribute(labColArr, 3);
  labPackAttr.setUsage(THREE.DynamicDrawUsage);
  labInfoAttr.setUsage(THREE.DynamicDrawUsage);
  labColAttr.setUsage(THREE.DynamicDrawUsage);
  labelGeo.setAttribute('aPack', labPackAttr);
  labelGeo.setAttribute('aInfo', labInfoAttr);
  labelGeo.setAttribute('aPos', labPosAttr);
  labelGeo.setAttribute('aCol', labColAttr);
  const labelMat = new THREE.ShaderMaterial({
    uniforms: {
      uAtlas: { value: atlasTex },
      uGlyphW: { value: 1 / GLYPH_CELLS },
      uMaxLen: { value: MAXLEN },
    },
    vertexShader: /* glsl */ `
      attribute vec3 aPos;
      attribute vec3 aCol;
      attribute vec3 aPack;
      attribute vec2 aInfo;
      varying vec2 vUv;
      varying vec3 vCol;
      varying vec3 vPack;
      varying vec2 vInfo;
      void main() {
        vUv = uv;
        vCol = aCol;
        vPack = aPack;
        vInfo = aInfo;
        vec4 mv = modelViewMatrix * vec4(aPos, 1.0);
        mv.xy += position.xy * aInfo.y; // billboard em espaço de vista
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vCol;
      varying vec3 vPack;
      varying vec2 vInfo;
      uniform sampler2D uAtlas;
      uniform float uGlyphW;
      uniform float uMaxLen;
      void main() {
        float len = vInfo.x;
        if (len <= 0.0) discard; // rótulo oculto
        float off = floor((uMaxLen - len) * 0.5);
        float gpos = vUv.x * uMaxLen - off;
        if (gpos < 0.0 || gpos >= len) discard; // fora da string
        float fi = floor(gpos);
        float pair = fi < 2.0 ? vPack.x : (fi < 4.0 ? vPack.y : vPack.z);
        float sub = fi < 2.0 ? fi : (fi < 4.0 ? fi - 2.0 : fi - 4.0);
        float c0 = floor(pair / 256.0);
        float ch = sub < 0.5 ? c0 : (pair - c0 * 256.0);
        vec4 t = texture2D(uAtlas, vec2((ch + fract(gpos)) * uGlyphW, vUv.y));
        if (t.a < 0.02) discard;
        gl_FragColor = vec4(vCol * t.rgb, t.a); // rgb da textura = contorno/fill; tinta = cor do valor
        #include <colorspace_fragment> // linear -> output (coerente com MeshBasicMaterial da cena)
      }
    `,
    transparent: true,
    depthWrite: false,
    depthTest: true,
  });
  const labelMesh = new THREE.InstancedMesh(labelGeo, labelMat, MAX_LABELS);
  labelMesh.frustumCulled = false; // posições vêm dos atributos instanciados
  labelMesh.renderOrder = 10; // por cima de nós/arestas
  labelMesh.count = MAX_LABELS; // invisíveis = comprimento 0 (discard no shader)
  scene.add(labelMesh);

  // âncoras e escalas dos rótulos são fixas (função do índice do nó) — escritas UMA vez
  {
    for (let k = 0; k < N_SIG; k++) {
      const li = k;
      labPosArr[li * 3] = nodePos[k * 3];
      labPosArr[li * 3 + 1] = nodePos[k * 3 + 1] + LAB_Y_SIG;
      labPosArr[li * 3 + 2] = nodePos[k * 3 + 2];
      labInfo[li * 2 + 1] = 1.0;
    }
    for (let o = 0; o < N_OUT; o++) {
      const li = N_SIG + o;
      const n3 = (OUT_BASE + o) * 3;
      labPosArr[li * 3] = nodePos[n3];
      labPosArr[li * 3 + 1] = nodePos[n3 + 1] + LAB_Y_OUT;
      labPosArr[li * 3 + 2] = nodePos[n3 + 2];
      labInfo[li * 2 + 1] = 1.0;
    }
    for (let s = 0; s < MAX_SLOTS; s++) {
      const li = N_SIG + N_OUT + s;
      const n3 = (HID_BASE + s) * 3;
      labPosArr[li * 3] = nodePos[n3];
      labPosArr[li * 3 + 1] = nodePos[n3 + 1] + LAB_Y_HID;
      labPosArr[li * 3 + 2] = nodePos[n3 + 2];
      labInfo[li * 2 + 1] = LAB_SCALE_HID;
    }
    labPosAttr.needsUpdate = true;
    labInfoAttr.needsUpdate = true;
  }
  const labSKey = new Int32Array(MAX_LABELS); // chave da string mostrada
  const labCKey = new Int32Array(MAX_LABELS).fill(-1); // chave da cor mostrada

  // ---------- ligações: 1 LineSegments com buffers prealocados ----------
  const linePos = new Float32Array(MAX_EDGES * 2 * 3);
  const lineCol = new Float32Array(MAX_EDGES * 2 * 4); // RGBA: alpha por vértice (USE_COLOR_ALPHA)
  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute('position', new THREE.BufferAttribute(linePos, 3));
  lineGeo.setAttribute('color', new THREE.BufferAttribute(lineCol, 4));
  lineGeo.setDrawRange(0, 0);
  const lineMat = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending, // contributo final = rgb·alpha somado ao fundo
  });
  const lineMesh = new THREE.LineSegments(lineGeo, lineMat);
  lineMesh.frustumCulled = false;
  scene.add(lineMesh);

  // ---------- pulsos: 1 InstancedMesh (orçamento 256) ----------
  const pulseGeo = new THREE.SphereGeometry(1, 8, 6);
  const pulseMat = new THREE.MeshBasicMaterial({ toneMapped: false, transparent: true, depthWrite: false });
  const pulseMesh = new THREE.InstancedMesh(pulseGeo, pulseMat, PULSE_BUDGET);
  pulseMesh.frustumCulled = false;
  pulseMesh.count = 0;
  pulseMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  pulseMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(PULSE_BUDGET * 3).fill(1), 3);
  pulseMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  scene.add(pulseMesh);

  // ---------- buffers de trabalho (alocados uma vez) ----------
  const candFrom = new Int32Array(MAX_CAND);
  const candTo = new Int32Array(MAX_CAND);
  const candW = new Float32Array(MAX_CAND);
  const strSort = new Float32Array(MAX_CAND); // cópia das forças para o corte top-K por família
  const candSel = new Uint8Array(MAX_CAND); // marcas de seleção (passe de reposição)
  const famOff = new Int32Array(N_FAM + 1); // regiões contíguas por família em cand*
  const famSel = new Int32Array(N_FAM);
  const famPtr = new Int32Array(N_FAM);
  const eFrom = new Int32Array(MAX_EDGES);
  const eTo = new Int32Array(MAX_EDGES);
  const eW = new Float32Array(MAX_EDGES);
  const act = new Float32Array(MAX_NODES); // |ativação| por nó (cor + seleção de pulsos)
  const selScore = new Float32Array(PULSE_BUDGET);
  const selEdge = new Int32Array(PULSE_BUDGET);
  const pulseFrom = new Float32Array(PULSE_BUDGET * 3);
  const pulseTo = new Float32Array(PULSE_BUDGET * 3);
  const pulsePhase = new Float32Array(PULSE_BUDGET);
  const pulseScale = new Float32Array(PULSE_BUDGET);
  const labColor = new Float32Array(3);
  const m4 = new THREE.Matrix4();
  const v3 = new THREE.Vector3();
  const cA = new THREE.Color();
  let selCount = 0;
  let nEdges = 0;
  let nPulses = 0;
  let mapSig = -1; // assinatura da forma do mapa corrente
  const mapShapeCur = { count: 0, cols: 0, rows: 0, grid: false, sig: -1 }; // forma corrente (reusado)

  // snapshot dos arrays estruturais do net para detectar mudanças sem alocar por frame
  const cache = { nSlots: -1, nIn: -1, nOut: -1, alive: null, W: null, M: null, WIn: null, MIn: null, WOut: null, MOut: null };

  // ---------- ciclo de animação (só quando anima) ----------
  let rafId = 0;
  let wakeUntil = 0;
  let dragging = false;
  let tween = null;
  let disposed = false;
  let autoRotateWanted = false; // E3: órbita automática DESLIGADA por defeito (pedido do utilizador)

  const autoOrbitOn = () => controls.autoRotate;

  function loopNeeded(nowMs) {
    return !disposed && (autoOrbitOn() || !!tween || (pulsesTravel && nPulses > 0) || dragging || nowMs < wakeUntil);
  }
  function ensureLoop() {
    if (!rafId && loopNeeded(performance.now())) rafId = requestAnimationFrame(frame);
  }
  function renderNow() {
    if (!disposed) renderer.render(scene, camera);
  }
  function wake(ms) {
    wakeUntil = Math.max(wakeUntil, performance.now() + ms);
    ensureLoop();
  }
  function syncControls() {
    // órbita só quando o utilizador a pediu E o movimento é permitido E a câmara está livre
    // (sem tween de preset, sem drag); reduced-motion força sempre off, mesmo com o toggle on
    controls.autoRotate = autoRotateWanted && !reducedMotion() && !tween && !dragging;
  }

  // Assenta e anula a rotação pendente que o autoRotate deixou no sphericalDelta interno do
  // OrbitControls (com damping, um simples autoRotate=false deixaria a câmara a derivar ~0.5°
  // durante dezenas de frames). O delta assenta sem desenhar e a pose exata da câmara é reposta
  // => velocidade angular residual ZERO no momento do toggle.
  function stopOrbitCleanly() {
    const p = camera.position.clone();
    const t = controls.target.clone();
    for (let i = 0; i < 128; i++) controls.update(); // damping 0.075 => resíduo final ~5e-7 rad
    camera.position.copy(p);
    controls.target.copy(t);
    camera.lookAt(t);
  }

  function frame(now) {
    rafId = 0;
    if (disposed) return;
    const t = now * 0.001;
    if (tween) stepTween(now);
    if (pulsesTravel && nPulses > 0) writePulseMatrices(t);
    controls.update(); // damping + autoRotate
    renderer.render(scene, camera);
    if (loopNeeded(now)) rafId = requestAnimationFrame(frame);
  }

  function stepTween(now) {
    let k = (now - tween.t0) / tween.dur;
    if (k >= 1) k = 1;
    const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2; // easeInOutCubic
    camera.position.lerpVectors(tween.p0, tween.p1, e);
    controls.target.lerpVectors(tween.t0v, tween.t1v, e);
    if (k === 1) {
      tween = null;
      syncControls();
    }
  }

  // ---------- deteção de mudança (topologia, pesos, alive) — um único scan por update ----------
  // devolve: 0 = igual, 1 = pesos mudaram (rebuild de arestas), 3 = estrutura/alive mudou
  function scanNet(net, nS, nIn, nOut) {
    if (cache.nSlots !== nS || cache.nIn !== nIn || cache.nOut !== nOut || !cache.alive) return 3;
    for (let i = 0; i < nS; i++) if (net.alive[i] !== cache.alive[i]) return 3;
    const nHH = nS * nS;
    for (let k = 0; k < nHH; k++) {
      const m = net.M[k];
      if (m !== cache.M[k]) return 1;
      if (m && net.W[k] !== cache.W[k]) return 1;
    }
    const nIH = nIn * nS;
    for (let k = 0; k < nIH; k++) {
      const m = net.M_in[k];
      if (m !== cache.MIn[k]) return 1;
      if (m && net.W_in[k] !== cache.WIn[k]) return 1;
    }
    const nHO = nS * nOut;
    for (let k = 0; k < nHO; k++) {
      const m = net.M_out[k];
      if (m !== cache.MOut[k]) return 1;
      if (m && net.W_out[k] !== cache.WOut[k]) return 1;
    }
    return 0;
  }

  function syncCache(net, nS, nIn, nOut) {
    cache.nSlots = nS;
    cache.nIn = nIn;
    cache.nOut = nOut;
    cache.alive = net.alive.slice(0, nS);
    cache.M = net.M.slice(0, nS * nS);
    cache.W = net.W.slice(0, nS * nS);
    cache.MIn = net.M_in.slice(0, nIn * nS);
    cache.WIn = net.W_in.slice(0, nIn * nS);
    cache.MOut = net.M_out.slice(0, nS * nOut);
    cache.WOut = net.W_out.slice(0, nS * nOut);
  }

  // ---------- layout do mapa (só quando a forma do mapa muda) ----------
  function layoutMap(shape) {
    if (shape.grid) {
      const { cols, rows } = shape;
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          const idx = y * cols + x;
          if (idx >= shape.count) break;
          const i3 = (MAP_BASE + idx) * 3;
          nodePos[i3] = (x - (cols - 1) / 2) * MAP_STEP;
          nodePos[i3 + 1] = ((rows - 1) / 2 - y) * MAP_STEP; // y do labirinto cresce para baixo
          nodePos[i3 + 2] = MAP_Z;
        }
      }
    } else {
      // arco compacto (contagens pequenas sem fatoração própria)
      const n = shape.count;
      for (let k = 0; k < n; k++) {
        const ang = n > 1 ? -1.35 + (2.7 * k) / (n - 1) : 0;
        const i3 = (MAP_BASE + k) * 3;
        nodePos[i3] = 3.4 * Math.sin(ang);
        nodePos[i3 + 1] = -6.9 - 1.7 * Math.cos(ang);
        nodePos[i3 + 2] = MAP_Z;
      }
    }
  }

  // ---------- reconstrução das ligações (só em mudança de topologia/pesos/mapa) ----------
  // Seleção top-~4000 por |w| com cotas ESTRATIFICADAS por família (documentado no cabeçalho):
  //   HH (oculto→oculto) 2000 · SIG (sinal→oculto) 600 · MAP (mapa→oculto) 1000 · HO 400.
  // Famílias que não enchem a cota devolvem o excedente num 2.º passe global (threshold
  // obtido por fusão das 4 regiões ordenadas), para nunca desperdiçar orçamento quando há
  // candidatos fortes por escolher. O passe final tem guarda dura nEdges < MAX_EDGES.
  function rebuildEdges(net, nS, nIn, nOut) {
    const alive = net.alive;
    let E = 0;
    famOff[0] = 0;
    // família HH: hidden -> hidden
    for (let i = 0; i < nS; i++) {
      if (!alive[i]) continue;
      const row = i * nS;
      const from = HID_BASE + i;
      for (let j = 0; j < nS; j++) {
        const k = row + j;
        if (!alive[j] || !net.M[k]) continue;
        candFrom[E] = from;
        candTo[E] = HID_BASE + j;
        candW[E] = net.W[k];
        E++;
      }
    }
    famOff[FAM_SIG] = E;
    // família SIG: sinais (0..11) -> hidden
    const nSig = Math.min(nIn, N_SIG);
    for (let i = 0; i < nSig; i++) {
      const row = i * nS;
      for (let j = 0; j < nS; j++) {
        const k = row + j;
        if (!alive[j] || !net.M_in[k]) continue;
        candFrom[E] = i;
        candTo[E] = HID_BASE + j;
        candW[E] = net.W_in[k];
        E++;
      }
    }
    famOff[FAM_MAP] = E;
    // família MAP: células do mapa (12..nIn-1) -> hidden
    for (let i = N_SIG; i < nIn; i++) {
      const row = i * nS;
      for (let j = 0; j < nS; j++) {
        const k = row + j;
        if (!alive[j] || !net.M_in[k]) continue;
        candFrom[E] = i;
        candTo[E] = HID_BASE + j;
        candW[E] = net.W_in[k];
        E++;
      }
    }
    famOff[FAM_HO] = E;
    // família HO: hidden -> saídas
    for (let j = 0; j < nS; j++) {
      if (!alive[j]) continue;
      const row = j * nOut;
      const from = HID_BASE + j;
      for (let o = 0; o < nOut; o++) {
        const k = row + o;
        if (!net.M_out[k]) continue;
        candFrom[E] = from;
        candTo[E] = OUT_BASE + o;
        candW[E] = net.W_out[k];
        E++;
      }
    }
    famOff[N_FAM] = E;

    // forças ordenadas por família (só aqui, nunca por frame)
    for (let f = 0; f < N_FAM; f++) {
      const off = famOff[f];
      const n = famOff[f + 1] - off;
      for (let e = 0; e < n; e++) strSort[off + e] = Math.abs(candW[off + e]);
      if (n > 1) strSort.subarray(off, off + n).sort(); // ordem numérica ascendente in place
    }

    nEdges = 0;
    famSel.fill(0);
    candSel.fill(0);
    // passe 1: top-|w| dentro de cada família, até à cota
    for (let f = 0; f < N_FAM; f++) {
      const off = famOff[f];
      const n = famOff[f + 1] - off;
      const cap = Math.min(FAM_CAP[f], MAX_EDGES);
      const thr = n > cap ? strSort[off + n - cap] : -1;
      for (let e = off; e < off + n && nEdges < MAX_EDGES; e++) {
        const a = Math.abs(candW[e]);
        if (a < thr || (a === thr && famSel[f] >= cap)) continue;
        acceptEdge(e);
        famSel[f]++;
      }
    }
    // passe 2: repor o orçamento das famílias que não encheram (threshold por fusão das
    // regiões ordenadas, saltando as cabeças já escolhidas de cada família)
    if (nEdges < MAX_EDGES && E > nEdges) {
      const need = MAX_EDGES - nEdges;
      for (let f = 0; f < N_FAM; f++) famPtr[f] = famOff[f + 1] - 1 - famSel[f];
      let thr2 = 0;
      for (let k = 0; k < need; k++) {
        let best = -1;
        let bf = -1;
        for (let f = 0; f < N_FAM; f++) {
          if (famPtr[f] < famOff[f]) continue;
          const w = strSort[famPtr[f]];
          if (w > best) {
            best = w;
            bf = f;
          }
        }
        if (bf < 0) break;
        thr2 = best;
        famPtr[bf]--;
      }
      for (let e = 0; e < E && nEdges < MAX_EDGES; e++) {
        if (candSel[e]) continue;
        if (Math.abs(candW[e]) < thr2) continue;
        acceptEdge(e);
      }
    }

    lineGeo.attributes.position.needsUpdate = true;
    lineGeo.attributes.color.needsUpdate = true;
    lineGeo.setDrawRange(0, nEdges * 2);
  }

  function acceptEdge(e) {
    candSel[e] = 1;
    fillEdge(nEdges, candFrom[e], candTo[e], candW[e]);
    eFrom[nEdges] = candFrom[e];
    eTo[nEdges] = candTo[e];
    eW[nEdges] = candW[e];
    nEdges++;
  }

  // Escreve 2 vértices (posição + cor RGBA) no buffer prealocado do LineSegments.
  function fillEdge(slot, from, to, w) {
    const a3 = from * 3;
    const b3 = to * 3;
    const p6 = slot * 6;
    const c8 = slot * 8;
    linePos[p6] = nodePos[a3];
    linePos[p6 + 1] = nodePos[a3 + 1];
    linePos[p6 + 2] = nodePos[a3 + 2];
    linePos[p6 + 3] = nodePos[b3];
    linePos[p6 + 4] = nodePos[b3 + 1];
    linePos[p6 + 5] = nodePos[b3 + 2];
    const col = w >= 0 ? COL_AMBER : COL_SLATE;
    const alpha = Math.min(0.92, Math.max(0.06, Math.abs(w) * 1.4)); // alpha ∝ |w|, mínimo 0.06
    for (let v = 0; v < 2; v++) {
      const o = c8 + v * 4;
      lineCol[o] = col.r;
      lineCol[o + 1] = col.g;
      lineCol[o + 2] = col.b;
      lineCol[o + 3] = alpha;
    }
  }

  // ---------- atualização dos neurónios ----------
  function rampColor(t, out) {
    // cinza base -> cinza claro -> âmbar quente, proporcional a |h| (ou |y|)
    if (t < 0.55) out.copy(COL_BASE).lerp(COL_HOT, t / 0.55);
    else out.copy(COL_HOT).lerp(COL_AMBER, (t - 0.55) / 0.45);
    return out;
  }

  function setNeuron(i, scale, color) {
    const i3 = i * 3;
    m4.makeScale(scale, scale, scale);
    m4.setPosition(nodePos[i3], nodePos[i3 + 1], nodePos[i3 + 2]);
    neuronMesh.setMatrixAt(i, m4);
    neuronMesh.setColorAt(i, color);
  }

  function updateNeurons(alive, nS, nIn, nOut, y, solved, inVals, mapShape) {
    for (let k = 0; k < N_SIG; k++) {
      // sinais: tingimento âmbar pelo valor atual do sensor (0 quando desconhecido)
      const used = k < nIn;
      const t = used ? Math.min(1, act[k]) : 0;
      cA.copy(COL_BASE).lerp(COL_AMBER, t);
      setNeuron(k, used ? 0.3 * (1 + 0.3 * t) : 0, cA);
    }
    // mapa (E8 · 3): 0 = escuro/discreto · 0.5 = âmbar ~35% · 1.0 = âmbar 100% + escala maior
    const mc = mapShape.count;
    for (let idx = 0; idx < MAX_MAP; idx++) {
      const used = idx < mc;
      let sc = 0;
      if (used) {
        const li = MAP_BASE + idx;
        const v = inVals && li < inVals.length ? inVals[li] : 0;
        const t = v <= 0 ? 0 : v >= 1 ? 1 : v;
        if (t <= 0) {
          cA.copy(COL_MAP_DARK);
        } else {
          const bright = t <= 0.5 ? 0.35 * (t / 0.5) : 0.35 + 0.65 * ((t - 0.5) / 0.5);
          cA.copy(COL_MAP_DARK).lerp(COL_AMBER, bright);
        }
        sc = MAP_CELL_R0 + t * (MAP_CELL_R1 - MAP_CELL_R0);
      }
      setNeuron(MAP_BASE + idx, sc, used ? cA : COL_MAP_DARK);
    }
    let best = -1;
    if (solved && y) {
      // verde semântico reservado ao output com max y quando a rede resolveu
      let bestVal = -Infinity;
      for (let o = 0; o < nOut; o++) {
        const v = y[o];
        if (v > bestVal) {
          bestVal = v;
          best = o;
        }
      }
    }
    for (let o = 0; o < N_OUT; o++) {
      const used = o < nOut;
      const t = used && y && o < y.length ? Math.min(1, Math.abs(y[o])) : 0;
      if (used && o === best) cA.copy(COL_GREEN);
      else rampColor(t, cA);
      setNeuron(OUT_BASE + o, used ? 0.32 * (1 + 0.35 * t) : 0, cA);
    }
    for (let s = 0; s < MAX_SLOTS; s++) {
      // slots vivos sobre a casca; mortos ficam com escala 0 (invisíveis)
      const used = s < nS && !!alive[s];
      const t = used ? Math.min(1, act[HID_BASE + s]) : 0;
      if (used) rampColor(t, cA);
      setNeuron(HID_BASE + s, used ? 0.22 * (1 + 0.5 * t) : 0, used ? cA : COL_BASE);
    }
    neuronMesh.instanceMatrix.needsUpdate = true;
    neuronMesh.instanceColor.needsUpdate = true;
  }

  // ---------- rótulos (E8): escrita só em mudança ----------
  function labelColorOf(v, out) {
    const a = v < 0 ? -v : v;
    const base = a < 0.005 ? COL_LABEL_ZERO : v > 0 ? COL_AMBER : COL_SLATE;
    const k = 0.55 + 0.45 * Math.min(1, a); // intensidade ∝ |v|
    out[0] = base.r * k;
    out[1] = base.g * k;
    out[2] = base.b * k;
    return out;
  }

  function writeLabelText(li, str, v) {
    const n = Math.min(str.length, MAXLEN);
    const o = li * 3;
    for (let f = 0; f < 3; f++) {
      const c0 = 2 * f < n ? glyphIndex(str.charCodeAt(2 * f)) : GLYPH_SPACE;
      const c1 = 2 * f + 1 < n ? glyphIndex(str.charCodeAt(2 * f + 1)) : GLYPH_SPACE;
      labPack[o + f] = c0 + 256 * c1;
    }
    labInfo[li * 2] = n;
    labPackAttr.needsUpdate = true;
    labInfoAttr.needsUpdate = true;
    labSKey[li] = strKeyOf(v);
    // cor: quantizada (33×33 chaves) => escrita também só em mudança
    const ck = colKeyOf(v);
    if (ck !== labCKey[li]) {
      labCKey[li] = ck;
      labelColorOf(v, labColor);
      labColArr[o] = labColor[0];
      labColArr[o + 1] = labColor[1];
      labColArr[o + 2] = labColor[2];
      labColAttr.needsUpdate = true;
    }
  }

  function setLabelHidden(li) {
    if (labInfo[li * 2] !== 0) {
      labInfo[li * 2] = 0;
      labInfoAttr.needsUpdate = true;
      labSKey[li] = 0;
      labCKey[li] = -1;
    }
  }

  function updateLabels(alive, nS, nIn, nOut, h, y, inVals) {
    for (let k = 0; k < N_SIG; k++) {
      const li = k;
      if (inVals && k < nIn && k < inVals.length) writeLabelIfChanged(li, inVals[k]);
      else setLabelHidden(li);
    }
    for (let o = 0; o < N_OUT; o++) {
      const li = N_SIG + o;
      if (y && o < nOut && o < y.length) writeLabelIfChanged(li, y[o]);
      else setLabelHidden(li);
    }
    for (let s = 0; s < MAX_SLOTS; s++) {
      const li = N_SIG + N_OUT + s;
      if (h && s < nS && s < h.length && alive[s]) writeLabelIfChanged(li, h[s]);
      else setLabelHidden(li);
    }
  }

  // Só formata/escreve quando a chave quantizada do valor muda (zero escritas e zero alocação
  // quando o valor está estável — "change-driven updates only").
  function writeLabelIfChanged(li, v) {
    const sk = strKeyOf(v);
    const ck = colKeyOf(v);
    if (sk === labSKey[li] && ck === labCKey[li] && labInfo[li * 2] > 0) return;
    writeLabelText(li, fmtVal(v), v);
  }

  // ---------- pulsos ----------
  function writePulse(i, fromNode, toNode, scale, phase, color) {
    const a3 = fromNode * 3;
    const b3 = toNode * 3;
    const o3 = i * 3;
    pulseFrom[o3] = nodePos[a3];
    pulseFrom[o3 + 1] = nodePos[a3 + 1];
    pulseFrom[o3 + 2] = nodePos[a3 + 2];
    pulseTo[o3] = nodePos[b3];
    pulseTo[o3 + 1] = nodePos[b3 + 1];
    pulseTo[o3 + 2] = nodePos[b3 + 2];
    pulseScale[i] = scale;
    pulsePhase[i] = phase;
    pulseMesh.setColorAt(i, color);
  }

  // Matrizes dos pulsos: u viaja 0→1 ao longo da aresta; env=sin(πu) faz fade nas pontas.
  function writePulseMatrices(time) {
    for (let i = 0; i < nPulses; i++) {
      const o3 = i * 3;
      const u = pulsesTravel ? frac(pulsePhase[i] + time * PULSE_SPEED) : 0.5;
      const inv = 1 - u;
      const s = pulseScale[i] * Math.sin(Math.PI * u);
      v3.set(
        pulseFrom[o3] * inv + pulseTo[o3] * u,
        pulseFrom[o3 + 1] * inv + pulseTo[o3 + 1] * u,
        pulseFrom[o3 + 2] * inv + pulseTo[o3 + 2] * u
      );
      m4.makeScale(s, s, s);
      m4.setPosition(v3);
      pulseMesh.setMatrixAt(i, m4);
    }
    pulseMesh.instanceMatrix.needsUpdate = true;
  }

  function updatePulses(activity, alive, nS) {
    // 1) pulsos pedidos explicitamente: activity.pulse = [{from,to}] com índices de slot
    const list = activity && activity.pulse;
    let nExp = 0;
    if (list) {
      for (let i = 0; i < list.length && nExp < PULSE_BUDGET; i++) {
        const p = list[i];
        if (!p) continue;
        const a = p.from | 0;
        const b = p.to | 0;
        if (a < 0 || a >= nS || b < 0 || b >= nS || !alive[a] || !alive[b]) continue;
        const h = ((Math.imul(a, 73856093) ^ Math.imul(b, 19349663)) & 255) / 255; // fase estável
        writePulse(nExp, HID_BASE + a, HID_BASE + b, 0.14, h, COL_AMBER);
        nExp++;
      }
    }
    // 2) restantes: ligações mais ativas por |h_from·w| (top-K por inserção, sem alocações)
    const cap = PULSE_BUDGET - nExp;
    selCount = 0;
    let maxScore = 0;
    for (let e = 0; e < nEdges && cap > 0; e++) {
      const w = eW[e];
      const score = act[eFrom[e]] * (w < 0 ? -w : w);
      if (!(score > 0)) continue;
      if (score > maxScore) maxScore = score;
      let pos = selCount < cap ? selCount : cap - 1;
      while (pos > 0 && selScore[pos - 1] < score) {
        selScore[pos] = selScore[pos - 1];
        selEdge[pos] = selEdge[pos - 1];
        pos--;
      }
      selScore[pos] = score;
      selEdge[pos] = e;
      if (selCount < cap) selCount++;
    }
    for (let i = 0; i < selCount; i++) {
      const e = selEdge[i];
      const w = eW[e];
      const strength = maxScore > 0 ? selScore[i] / maxScore : 0;
      writePulse(
        nExp + i,
        eFrom[e],
        eTo[e],
        0.05 + 0.085 * strength,
        (e * 0.61803398875) % 1, // fase determinística por aresta
        w >= 0 ? COL_AMBER : COL_SLATE_LIGHT
      );
    }
    nPulses = nExp + selCount;
    pulseMesh.count = nPulses;
    pulseMesh.instanceColor.needsUpdate = true;
    if (!pulsesTravel) writePulseMatrices(0); // sem movimento: pulsos fixos a meio da aresta
  }

  // ---------- update(net, activity) ----------
  function update(net, activity) {
    if (disposed || !net) return;
    const nS = Math.min(net.nSlots | 0, MAX_SLOTS);
    let nIn = net.nIn | 0;
    if (!nIn && activity) {
      const iv = activity.inputs || activity.input || activity.sensors;
      if (iv) nIn = iv.length | 0;
    }
    nIn = Math.max(0, Math.min(nIn, MAP_BASE + MAX_MAP));
    const nOut = Math.min(net.nOut | 0, N_OUT);
    const h = activity ? activity.h : null;
    const y = activity ? activity.y : null;
    const inVals = activity ? activity.inputs || activity.input || activity.sensors : null;
    const solved = !!(activity && activity.solved);

    // 1) forma do mapa (E7): trabalho real (layout/arestas) só quando a assinatura muda
    const shapeChanged = resolveMapShape(mapShapeCur, nIn, activity) !== mapSig;
    if (shapeChanged) {
      mapSig = mapShapeCur.sig;
      layoutMap(mapShapeCur);
    }

    // 2) rede: um único scan; rebuild de arestas em mudança (nunca por frame)
    const ch = scanNet(net, nS, nIn, nOut);
    if (ch || shapeChanged) {
      syncCache(net, nS, nIn, nOut);
      rebuildEdges(net, nS, nIn, nOut);
    }

    // 3) ativações (buffer fixo): entradas pelos sensores/mapa, slots pelo estado h
    for (let k = 0; k < nIn; k++) act[k] = inVals && k < inVals.length ? Math.abs(inVals[k]) : 0;
    for (let s = 0; s < nS; s++) act[HID_BASE + s] = h && s < h.length ? Math.abs(h[s]) : 0;
    for (let o = 0; o < nOut; o++) act[OUT_BASE + o] = y && o < y.length ? Math.abs(y[o]) : 0;

    updateNeurons(net.alive, nS, nIn, nOut, y, solved, inVals, mapShapeCur);
    updateLabels(net.alive, nS, nIn, nOut, h, y, inVals);
    updatePulses(activity, net.alive, nS);

    ensureLoop();
    if (!rafId) renderNow(); // sem loop ativo: render on demand (uma chamada por update)
  }

  // ---------- resize / dispose / presets ----------
  function applySize() {
    if (disposed) return;
    const rect = container.getBoundingClientRect();
    const w = Math.max(1, Math.round(container.clientWidth || rect.width || 1));
    const h = Math.max(1, Math.round(container.clientHeight || rect.height || 1));
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2)); // acompanha mudanças de DPR
    renderer.setSize(w, h, false); // canvas fixado a 100% via CSS
    if (!rafId) renderNow();
  }

  function resize() {
    applySize();
  }

  function setCameraPreset(name) {
    if (disposed) return;
    const p = PRESETS[name] || PRESETS.geral;
    if (reducedMotion()) {
      camera.position.set(p.pos[0], p.pos[1], p.pos[2]);
      controls.target.set(p.tgt[0], p.tgt[1], p.tgt[2]);
      controls.update();
      renderNow();
      return;
    }
    tween = {
      t0: performance.now(),
      dur: 900,
      p0: camera.position.clone(),
      p1: new THREE.Vector3(p.pos[0], p.pos[1], p.pos[2]),
      t0v: controls.target.clone(),
      t1v: new THREE.Vector3(p.tgt[0], p.tgt[1], p.tgt[2]),
    };
    syncControls();
    ensureLoop();
  }

  // ---------- rotação automática (EMENDA v2 · E3) ----------
  // true: reativa a órbita suave (e o loop rAF enquanto ela for a animação);
  // false: pára de imediato, sem velocidade residual; o loop rAF adormece sozinho logo que
  // não haja pulsos/tween/drag/wake (loopNeeded) — nada fica a correr "só pela rotação".
  // prefers-reduced-motion: recusa sempre ligar (syncControls mantém off).
  function setAutoRotate(enabled) {
    if (disposed) return;
    const wasOn = controls.autoRotate;
    autoRotateWanted = !!enabled;
    syncControls();
    if (wasOn && !controls.autoRotate) stopOrbitCleanly(); // só na transição on -> off
    ensureLoop();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    tween = null;
    if (observer) observer.disconnect();
    else window.removeEventListener('resize', applySize);
    if (rmQuery) {
      if (rmQuery.removeEventListener) rmQuery.removeEventListener('change', onRmChange);
      else if (rmQuery.removeListener) rmQuery.removeListener(onRmChange);
    }
    controls.dispose();
    neuronGeo.dispose();
    neuronMat.dispose();
    neuronMesh.dispose();
    labelGeo.dispose();
    labelMat.dispose();
    atlasTex.dispose();
    lineGeo.dispose();
    lineMat.dispose();
    pulseGeo.dispose();
    pulseMat.dispose();
    pulseMesh.dispose();
    renderer.dispose();
    if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
  }

  // ---------- arranque ----------
  const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => applySize()) : null;
  if (observer) observer.observe(container);
  else window.addEventListener('resize', applySize);

  function onRmChange() {
    pulsesTravel = !reducedMotion();
    syncControls();
    if (pulsesTravel) ensureLoop();
    else {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
      wakeUntil = 0;
      if (tween) {
        // sem movimento: o tween salta diretamente para o destino
        camera.position.copy(tween.p1);
        controls.target.copy(tween.t1v);
        tween = null;
        syncControls();
      }
      if (nPulses > 0) writePulseMatrices(0);
      renderNow();
    }
  }
  if (rmQuery) {
    if (rmQuery.addEventListener) rmQuery.addEventListener('change', onRmChange);
    else if (rmQuery.addListener) rmQuery.addListener(onRmChange);
  }

  controls.addEventListener('start', () => {
    dragging = true;
    tween = null; // o utilizador assume a câmara e cancela qualquer tween de preset
    syncControls();
    ensureLoop();
  });
  controls.addEventListener('end', () => {
    dragging = false;
    syncControls();
    wake(1800); // deixa o damping assentar antes de parar o loop
  });

  const g = PRESETS.geral; // enquadramento inicial
  camera.position.set(g.pos[0], g.pos[1], g.pos[2]);
  controls.target.set(g.tgt[0], g.tgt[1], g.tgt[2]);
  syncControls();
  applySize();

  return { update, resize, dispose, setCameraPreset, setAutoRotate };
}
