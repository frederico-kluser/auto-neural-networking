// core/maze.mjs [A] — geração (recursive backtracker), resolução BFS e raycasting.
// Coordenadas: x cresce para a direita, y cresce para baixo.
// Direções canónicas: 0=up (y-1), 1=down (y+1), 2=left (x-1), 3=right (x+1).
import { makeRng } from './rng.mjs';

export const DIRS = ['up', 'down', 'left', 'right'];
export const DIR_VEC = [[0, -1], [0, 1], [-1, 0], [1, 0]];

// cols/rows são forçados a ímpares e ≥ 5 (arredonda para o ímpar seguinte; mínimo 5):
// o backtracker vive em células "ímpares" e start=(1,1) / exit=(cols-2,rows-2) têm de
// ser células abertas, o que só acontece com dimensões ímpares.
function oddAtLeast5(n) {
  if (!Number.isFinite(n)) n = 5;
  n = Math.floor(n);
  if (n < 5) return 5;
  return n % 2 === 0 ? n + 1 : n;
}

// opts: reservado pelo contrato (sem opções ativas atualmente).
export function generateMaze(cols, rows, seed = 1, opts = {}) {
  const C = oddAtLeast5(cols);
  const R = oddAtLeast5(rows);
  const s = Number.isFinite(seed) ? Math.trunc(seed) : 1;
  const mixed = (Math.imul(s ^ 0x9e3779b9, 0x85ebca6b) ^ (s >>> 13) ^ 0x27d4eb2d) >>> 0;
  const rng = makeRng(mixed || 1);
  const grid = new Uint8Array(C * R).fill(1); // tudo parede
  const at = (x, y) => y * C + x;
  // Kruskal randomizado sobre as células ímpares: a árvore geradora é amostrada de forma
  // UNIFORME (o backtracker DFS tinha viés forte: 5x5 só saía em 2 layouts). Union-find com
  // compressão de caminho; arestas baralhadas com Fisher-Yates determinístico.
  const cells = [];
  for (let y = 1; y < R - 1; y += 2) for (let x = 1; x < C - 1; x += 2) cells.push([x, y]);
  const idOf = new Int32Array(C * R).fill(-1);
  cells.forEach(([x, y], i) => { idOf[at(x, y)] = i; grid[at(x, y)] = 0; });
  const parent = new Int32Array(cells.length);
  for (let i = 0; i < cells.length; i++) parent[i] = i;
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const edges = [];
  for (let i = 0; i < cells.length; i++) {
    const [x, y] = cells[i];
    if (idOf[at(x + 2, y)] >= 0) edges.push([i, idOf[at(x + 2, y)], at(x + 1, y)]);
    if (idOf[at(x, y + 2)] >= 0) edges.push([i, idOf[at(x, y + 2)], at(x, y + 1)]);
  }
  for (let i = edges.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    const t = edges[i]; edges[i] = edges[j]; edges[j] = t;
  }
  let merged = 0;
  for (const [a, b, mid] of edges) {
    const ra = find(a), rb = find(b);
    if (ra !== rb) {
      parent[ra] = rb;
      grid[mid] = 0; // abre a passagem
      if (++merged === cells.length - 1) break;
    }
  }
  return {
    cols: C,
    rows: R,
    seed: s,
    grid,
    start: { x: 1, y: 1 },
    exit: { x: C - 2, y: R - 2 },
    idx(x, y) {
      return y * C + x;
    },
    isWall(x, y) {
      return x < 0 || y < 0 || x >= C || y >= R ? true : grid[y * C + x] === 1;
    },
  };
}

// BFS start→exit; devolve o caminho completo (inclui start e exit) ou null.
export function solveMaze(maze) {
  const { cols, rows, grid, start, exit } = maze;
  const si = start.y * cols + start.x;
  const ei = exit.y * cols + exit.x;
  if (grid[si] === 1 || grid[ei] === 1) return null;
  const prev = new Int32Array(cols * rows).fill(-2); // -2 = por visitar
  const q = [si];
  prev[si] = -1;
  for (let head = 0; head < q.length; head++) {
    const cur = q[head];
    if (cur === ei) break;
    const cx = cur % cols;
    const cy = (cur / cols) | 0;
    for (let d = 0; d < 4; d++) {
      const nx = cx + DIR_VEC[d][0];
      const ny = cy + DIR_VEC[d][1];
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      const ni = ny * cols + nx;
      if (prev[ni] !== -2 || grid[ni] === 1) continue;
      prev[ni] = cur;
      q.push(ni);
    }
  }
  if (prev[ei] === -2) return null;
  const path = [];
  for (let i = ei; i !== -1; i = prev[i]) path.push({ x: i % cols, y: (i / cols) | 0 });
  path.reverse();
  return path;
}

// dist = nº de células abertas consecutivas a partir da adjacente (adjacente parede ⇒ 0).
// exitVisible = exit estritamente nessa linha/coluna, nessa direção, sem paredes pelo caminho.
export function rayInfo(maze, x, y, dir) {
  if (!Number.isInteger(dir) || dir < 0 || dir > 3) throw new RangeError('rayInfo: dir inválido ' + dir);
  const dx = DIR_VEC[dir][0];
  const dy = DIR_VEC[dir][1];
  let dist = 0;
  let cx = x + dx;
  let cy = y + dy;
  while (!maze.isWall(cx, cy)) {
    dist++;
    cx += dx;
    cy += dy;
  }
  const ex = maze.exit.x;
  const ey = maze.exit.y;
  const aligned = dx === 0 ? ex === x : ey === y;
  const beyond = dx === 0 ? (ey - y) * dy > 0 : (ex - x) * dx > 0;
  let exitVisible = false;
  if (aligned && beyond && !maze.isWall(ex, ey)) {
    exitVisible = true; // confirma que não há parede entre (x,y) e o exit (exclusive)
    let wx = x + dx;
    let wy = y + dy;
    while (wx !== ex || wy !== ey) {
      if (maze.isWall(wx, wy)) {
        exitVisible = false;
        break;
      }
      wx += dx;
      wy += dy;
    }
  }
  return { dist, exitVisible };
}
