// core/sensors.mjs [A + EMENDA v2/E2 + EMENDA v4/E7 + EMENDA v5/E13] — os 12 sensores
// nomeados do agente (4 distâncias a paredes + 4 sinais de saída + 4 frações de células
// visitadas no raio) e, OPCIONALMENTE (opts.withMap), o mapa de visitas por célula (E7).
import { rayInfo, DIR_VEC } from './maze.mjs';

export const EXIT_SIGNAL = 1.0;

/**
 * Nomes dos 12 sinais nomeados (índices 0..11). Os índices >= 12 NÃO estão aqui:
 * são entradas do MAPA por célula do labirinto (E7), só presentes com
 * `opts.withMap === true`: uma entrada por célula, na ordem `idx = y*maze.cols + x`,
 * com valor 1.0 = posição ATUAL do agente, 0.5 = já visitada (marcada em `visited`)
 * e 0.0 = nunca visitada. Com mapa, o comprimento total é 12 + maze.cols * maze.rows.
 */
export const SENSOR_NAMES = ['parede↑', 'parede↓', 'parede←', 'parede→', 'saída↑', 'saída↓', 'saída←', 'saída→', 'visitado↑', 'visitado↓', 'visitado←', 'visitado→'];

/**
 * EMENDA v5/E13: `sense(maze, x, y, visited = null, opts = {})`.
 * - `opts.withMap === true` → Float32Array(12 + cols*rows) (mapa E7 no fim);
 * - caso contrário (DEFEITO) → Float32Array(12) — exatamente os índices 0..11.
 * Índices 0..11 idênticos nos dois casos. O modo de memória do episódio
 * ('sinapses' | 'mapa' | 'ambos') escolhe o withMap correspondente em evolution.mjs.
 *
 * Índices 0..11 (inalterados desde E2):
 *  - 0..3  distâncias às paredes, normalizadas por max(cols,rows), clip [0,1];
 *  - 4..7  EXIT_SIGNAL se o exit é visível nessa direção, senão 0;
 *  - 8..11 fração de células abertas do raio já visitadas (0 se dist===0 ou visited null).
 *
 * Com `visited === null` o mapa sai todo a 0.0 exceto a posição atual (sempre 1.0).
 * Quente (milhares de chamadas/s): só aloca o Float32Array devolvido (nascido a
 * zeros), escreve o mapa com um passeio linear sobre `visited` e sobrescreve a
 * posição atual — sem closures nem alocações intermédias.
 */
export function sense(maze, x, y, visited = null, opts = {}) {
  const withMap = opts.withMap === true;
  const cols = maze.cols;
  const n = cols * maze.rows;
  const out = new Float32Array(withMap ? 12 + n : 12);
  const norm = Math.max(maze.cols, maze.rows);
  for (let d = 0; d < 4; d++) {
    const info = rayInfo(maze, x, y, d);
    const v = info.dist / norm;
    out[d] = v < 0 ? 0 : v > 1 ? 1 : v; // normalizada por max(cols,rows), clip [0,1]
    out[4 + d] = info.exitVisible ? EXIT_SIGNAL : 0;
    // Fração de visitadas no raio: as `dist` células abertas a partir da adjacente;
    // 0 se dist === 0 ou se não há memória (visited null).
    let frac = 0;
    if (visited && info.dist > 0) {
      const dx = DIR_VEC[d][0];
      const dy = DIR_VEC[d][1];
      let cx = x + dx;
      let cy = y + dy;
      let seen = 0;
      for (let t = 0; t < info.dist; t++) {
        if (visited[cy * cols + cx]) seen++;
        cx += dx;
        cy += dy;
      }
      frac = seen / info.dist;
    }
    out[8 + d] = frac;
  }
  // Mapa E7 (só com opts.withMap): 0.5 nas células com visited[] set (o resto já nasceu
  // a 0), e a posição atual a 1.0 SEMPRE — mesmo que visited não a marque (ou seja null).
  if (withMap) {
    if (visited) {
      for (let i = 0; i < n; i++) out[12 + i] = visited[i] ? 0.5 : 0;
    }
    out[12 + y * cols + x] = 1.0;
  }
  return out;
}
