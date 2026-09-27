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
  const rng = makeRng(s);
  const grid = new Uint8Array(C * R).fill(1); // tudo parede
  const at = (x, y) => y * C + x;
  // DFS iterativo com stack explícita sobre células ímpares (x e y ímpares).
  const stack = [[1, 1]];
  grid[at(1, 1)] = 0;
  while (stack.length > 0) {
    const [cx, cy] = stack[stack.length - 1];
    const cand = [];
    for (let d = 0; d < 4; d++) {
      const nx = cx + 2 * DIR_VEC[d][0];
      const ny = cy + 2 * DIR_VEC[d][1];
      // dentro do interior e ainda não visitada (as não visitadas continuam parede)
      if (nx > 0 && ny > 0 && nx < C - 1 && ny < R - 1 && grid[at(nx, ny)] === 1) cand.push(d);
    }
    if (cand.length === 0) {
      stack.pop();
      continue;
    }
    const d = cand[rng.int(cand.length)];
    const nx = cx + 2 * DIR_VEC[d][0];
    const ny = cy + 2 * DIR_VEC[d][1];
    grid[at(cx + DIR_VEC[d][0], cy + DIR_VEC[d][1])] = 0; // abre a passagem
    grid[at(nx, ny)] = 0; // e a célula destino
    stack.push([nx, ny]);
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
