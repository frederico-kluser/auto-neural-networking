// tests/unit-core.mjs [A] — testes unitários de core/rng.mjs, core/maze.mjs, core/sensors.mjs.
// Correr: node demo/tests/unit-core.mjs  → imprime PASS/FAIL por check; exit != 0 se algum falhar.
import assert from 'node:assert/strict';
import { makeRng } from '../core/rng.mjs';
import { generateMaze, solveMaze, rayInfo, DIRS, DIR_VEC } from '../core/maze.mjs';
import { sense, senseInto, EXIT_SIGNAL, SENSOR_NAMES } from '../core/sensors.mjs';
import { distanceField } from '../core/evolution.mjs'; // E15 (helper do motor; testado aqui)

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log('PASS ' + name);
  } catch (err) {
    fail++;
    console.log('FAIL ' + name + ' — ' + (err && err.message));
  }
}

// Labirinto construído à mão a partir de linhas de texto ('#' = parede, '.' = aberto).
function gridMaze(cols, rows, lines, exit) {
  const grid = new Uint8Array(cols * rows);
  for (let y = 0; y < rows; y++) {
    assert.equal(lines[y].length, cols, 'linha com largura errada');
    for (let x = 0; x < cols; x++) grid[y * cols + x] = lines[y][x] === '#' ? 1 : 0;
  }
  return {
    cols,
    rows,
    seed: 0,
    grid,
    start: { x: 1, y: 1 },
    exit,
    idx(x, y) {
      return y * cols + x;
    },
    isWall(x, y) {
      return x < 0 || y < 0 || x >= cols || y >= rows ? true : grid[y * cols + x] === 1;
    },
  };
}

// BFS genérico entre duas células; devolve caminho (inclui extremos) ou null.
function bfsPath(maze, ax, ay, bx, by) {
  const { cols, rows, grid } = maze;
  const si = ay * cols + ax;
  const ei = by * cols + bx;
  if (grid[si] === 1 || grid[ei] === 1) return null;
  const prev = new Int32Array(cols * rows).fill(-2);
  const q = [si];
  prev[si] = -1;
  for (let head = 0; head < q.length; head++) {
    const cur = q[head];
    if (cur === ei) break;
    const cx = cur % cols;
    const cy = (cur / cols) | 0;
    for (const [dx, dy] of DIR_VEC) {
      const nx = cx + dx;
      const ny = cy + dy;
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

// Existe caminho a→b evitando a aresta (u,v)<->(v,u)? (para provar unicidade de caminho)
function pathAvoidingEdge(maze, a, b, u, v) {
  const { cols, rows, grid } = maze;
  const uKey = u.y * cols + u.x;
  const vKey = v.y * cols + v.x;
  const si = a.y * cols + a.x;
  const ei = b.y * cols + b.x;
  const seen = new Uint8Array(cols * rows);
  const q = [si];
  seen[si] = 1;
  for (let head = 0; head < q.length; head++) {
    const cur = q[head];
    if (cur === ei) return true;
    const cx = cur % cols;
    const cy = (cur / cols) | 0;
    for (const [dx, dy] of DIR_VEC) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      const ni = ny * cols + nx;
      if (grid[ni] === 1 || seen[ni]) continue;
      if ((cur === uKey && ni === vKey) || (cur === vKey && ni === uKey)) continue; // aresta removida
      seen[ni] = 1;
      q.push(ni);
    }
  }
  return false;
}

// Estatísticas do grafo de células abertas (4-adjacência).
function openGraphStats(maze) {
  const { cols, rows, grid } = maze;
  const open = [];
  for (let i = 0; i < grid.length; i++) if (grid[i] === 0) open.push(i);
  let edges = 0;
  for (const i of open) {
    const x = i % cols;
    const y = (i / cols) | 0;
    if (x + 1 < cols && grid[i + 1] === 0) edges++;
    if (y + 1 < rows && grid[i + cols] === 0) edges++;
  }
  const seen = new Uint8Array(cols * rows);
  const q = [open[0]];
  seen[open[0]] = 1;
  let reach = 1;
  for (let head = 0; head < q.length; head++) {
    const i = q[head];
    const x = i % cols;
    const y = (i / cols) | 0;
    for (const [dx, dy] of DIR_VEC) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      const ni = ny * cols + nx;
      if (grid[ni] === 0 && !seen[ni]) {
        seen[ni] = 1;
        reach++;
        q.push(ni);
      }
    }
  }
  return { openCount: open.length, edges, reach };
}

const ODD_SIZES = [5, 7, 9, 11, 13, 15, 17, 19, 21, 23, 25, 27, 29, 31];

// ── constantes de direções ────────────────────────────────────────────────────
check('DIRS ordem canónica', () => assert.deepEqual(DIRS, ['up', 'down', 'left', 'right']));
check('DIR_VEC exato (up=y-1, down=y+1, left=x-1, right=x+1)', () =>
  assert.deepEqual(DIR_VEC, [[0, -1], [0, 1], [-1, 0], [1, 0]]));

// ── rng.mjs ───────────────────────────────────────────────────────────────────
check('rng: mesma seed ⇒ sequência idêntica', () => {
  const a = makeRng(123);
  const b = makeRng(123);
  for (let i = 0; i < 1000; i++) assert.equal(a.next(), b.next());
});
check('rng: seeds diferentes ⇒ sequências diferentes', () => {
  const a = makeRng(1);
  const b = makeRng(2);
  let same = 0;
  for (let i = 0; i < 100; i++) if (a.next() === b.next()) same++;
  assert.ok(same < 100, 'sequências iguais');
});
check('rng: campo seed devolvido', () => {
  assert.equal(makeRng(42).seed, 42);
  assert.equal(makeRng().seed, 1);
});
check('rng: next() ∈ [0,1)', () => {
  const r = makeRng(7);
  for (let i = 0; i < 10000; i++) {
    const v = r.next();
    assert.ok(v >= 0 && v < 1, 'fora de [0,1): ' + v);
  }
});
check('rng: int(n) inteiro ∈ [0,n)', () => {
  const r = makeRng(9);
  for (const n of [2, 3, 6, 100]) {
    const seen = new Set();
    for (let i = 0; i < 5000; i++) {
      const v = r.int(n);
      assert.ok(Number.isInteger(v) && v >= 0 && v < n, 'fora de [0,' + n + '): ' + v);
      seen.add(v);
    }
    assert.equal(seen.size, n, 'não cobriu [0,' + n + ')');
  }
  for (let i = 0; i < 100; i++) assert.equal(r.int(1), 0);
});
check('rng: range(a,b) ∈ [a,b)', () => {
  const r = makeRng(11);
  for (let i = 0; i < 5000; i++) {
    const v = r.range(-0.5, 0.5);
    assert.ok(v >= -0.5 && v < 0.5, 'fora de [-0.5,0.5): ' + v);
  }
});
check('rng: pick(arr) devolve elementos do array', () => {
  const r = makeRng(13);
  const arr = ['a', 'b', 'c'];
  const seen = new Set();
  for (let i = 0; i < 500; i++) {
    const v = r.pick(arr);
    assert.ok(arr.includes(v), 'elemento estranho: ' + v);
    seen.add(v);
  }
  assert.equal(seen.size, 3);
});

// ── maze.mjs: dimensões, fronteira, start/exit ────────────────────────────────
check('maze: cols/rows forçados a ímpares e ≥ 5 (4→5, 6→7, 8×3→9×5, 15×15→15×15)', () => {
  assert.deepEqual([generateMaze(4, 4).cols, generateMaze(4, 4).rows], [5, 5]);
  assert.deepEqual([generateMaze(6, 6).cols, generateMaze(6, 6).rows], [7, 7]);
  assert.deepEqual([generateMaze(8, 3).cols, generateMaze(8, 3).rows], [9, 5]);
  assert.deepEqual([generateMaze(15, 15).cols, generateMaze(15, 15).rows], [15, 15]);
  assert.deepEqual([generateMaze(31, 31).cols, generateMaze(31, 31).rows], [31, 31]);
});
check('maze: fronteira toda parede (5..31 ímpares)', () => {
  for (const n of ODD_SIZES) {
    const m = generateMaze(n, n, 5);
    for (let i = 0; i < n; i++) {
      assert.ok(m.isWall(i, 0), `(${i},0)`);
      assert.ok(m.isWall(i, n - 1), `(${i},${n - 1})`);
      assert.ok(m.isWall(0, i), `(0,${i})`);
      assert.ok(m.isWall(n - 1, i), `(${n - 1},${i})`);
    }
  }
});
check('maze: start=(1,1) e exit=(cols-2,rows-2) abertos (5..31 ímpares)', () => {
  for (const n of ODD_SIZES) {
    const m = generateMaze(n, n, 3);
    assert.deepEqual(m.start, { x: 1, y: 1 });
    assert.deepEqual(m.exit, { x: n - 2, y: n - 2 });
    assert.ok(!m.isWall(m.start.x, m.start.y), 'start fechado em ' + n);
    assert.ok(!m.isWall(m.exit.x, m.exit.y), 'exit fechado em ' + n);
  }
});
check('maze: grid Uint8Array(cols*rows) só com 0/1, seed guardada, idx correto', () => {
  const m = generateMaze(9, 7, 77);
  assert.ok(m.grid instanceof Uint8Array);
  assert.equal(m.grid.length, 9 * 7);
  assert.equal(m.seed, 77);
  for (let y = 0; y < 7; y++) for (let x = 0; x < 9; x++) assert.ok(m.grid[m.idx(x, y)] === 0 || m.grid[m.idx(x, y)] === 1);
  assert.equal(m.idx(3, 2), 2 * 9 + 3);
});
check('maze: isWall fora dos limites é parede', () => {
  const m = generateMaze(5, 5, 1);
  assert.ok(m.isWall(-1, 0) && m.isWall(0, -1) && m.isWall(5, 0) && m.isWall(0, 5));
});

// ── maze.mjs: solvabilidade e caminho válido ──────────────────────────────────
check('solveMaze: resolve 5..31 ímpares, caminho adjacente-4 start→exit', () => {
  for (const n of ODD_SIZES) {
    const m = generateMaze(n, n, 2);
    const path = solveMaze(m);
    assert.ok(path !== null, 'sem caminho em ' + n);
    assert.deepEqual(path[0], m.start, 'não começa em start (' + n + ')');
    assert.deepEqual(path[path.length - 1], m.exit, 'não termina em exit (' + n + ')');
    for (let i = 0; i < path.length; i++) {
      assert.ok(!m.isWall(path[i].x, path[i].y), 'passo em parede (' + n + ')');
      if (i > 0) assert.equal(Math.abs(path[i].x - path[i - 1].x) + Math.abs(path[i].y - path[i - 1].y), 1, 'passo não adjacente (' + n + ')');
    }
  }
});
check('solveMaze: devolve null quando não há caminho', () => {
  const m = gridMaze(5, 5, ['#####', '#.#.#', '#####', '#.#.#', '#####'], { x: 3, y: 3 });
  assert.equal(solveMaze(m), null);
});

// ── maze.mjs: propriedade de labirinto perfeito (grafo de aberturas é árvore) ──
check('perfeito: |aberturas| = 2K−1, arestas = |aberturas|−1, tudo ligado (5..31)', () => {
  for (const n of ODD_SIZES) {
    const m = generateMaze(n, n, 4);
    const K = ((n - 1) / 2) * ((n - 1) / 2); // células ímpares do backtracker
    const { openCount, edges, reach } = openGraphStats(m);
    assert.equal(openCount, 2 * K - 1, 'contagem de aberturas (' + n + ')');
    assert.equal(edges, openCount - 1, 'grafo não é árvore (' + n + ')');
    assert.equal(reach, openCount, 'aberturas desconectadas (' + n + ')');
  }
});
check('perfeito: caminho único — remover qualquer aresta do caminho desconecta o par', () => {
  const m = generateMaze(15, 15, 8);
  const r = makeRng(8);
  const open = [];
  for (let y = 0; y < m.rows; y++) for (let x = 0; x < m.cols; x++) if (!m.isWall(x, y)) open.push({ x, y });
  for (let t = 0; t < 3; t++) {
    const a = open[r.int(open.length)];
    let b = open[r.int(open.length)];
    while (b.x === a.x && b.y === a.y) b = open[r.int(open.length)];
    const path = bfsPath(m, a.x, a.y, b.x, b.y);
    assert.ok(path && path.length >= 2, 'par sem caminho');
    for (let i = 1; i < path.length; i++) {
      assert.ok(!pathAvoidingEdge(m, a, b, path[i - 1], path[i]), 'caminho alternativo após remover aresta');
    }
  }
});

// ── maze.mjs: determinismo ────────────────────────────────────────────────────
check('determinismo: mesma seed+tamanho ⇒ grelha idêntica', () => {
  for (const n of [5, 9, 15, 21, 31]) {
    const a = generateMaze(n, n, 1);
    const b = generateMaze(n, n, 1);
    assert.deepEqual(Array.from(a.grid), Array.from(b.grid), 'grelhas divergem em ' + n);
  }
});
check('determinismo: seeds diferentes ⇒ grelhas diferentes', () => {
  for (const n of [9, 15, 21]) {
    const a = generateMaze(n, n, 1);
    const b = generateMaze(n, n, 2);
    assert.notDeepEqual(Array.from(a.grid), Array.from(b.grid), 'grelhas iguais em ' + n);
  }
});

// ── maze.mjs: rayInfo (grelhas construídas à mão) ─────────────────────────────
// 9x3: corredor com parede ao meio. exit em (7,1).
//   #########
//   #...#...#
//   #########
const rayGrid = gridMaze(9, 3, ['#########', '#...#...#', '#########'], { x: 7, y: 1 });
check('rayInfo: parede adjacente ⇒ dist 0', () => {
  assert.deepEqual(rayInfo(rayGrid, 1, 1, 0), { dist: 0, exitVisible: false }); // ↑
  assert.deepEqual(rayInfo(rayGrid, 1, 1, 1), { dist: 0, exitVisible: false }); // ↓
  assert.deepEqual(rayInfo(rayGrid, 1, 1, 2), { dist: 0, exitVisible: false }); // ←
});
check('rayInfo: comprimento da corrida aberta contado até à parede', () => {
  assert.equal(rayInfo(rayGrid, 1, 1, 3).dist, 2); // (2,1),(3,1) abertas, (4,1) parede
  assert.equal(rayInfo(rayGrid, 5, 1, 2).dist, 0); // (4,1) é parede adjacente
  assert.equal(rayInfo(rayGrid, 7, 1, 2).dist, 2); // (6,1),(5,1) abertas, (4,1) parede
});
check('rayInfo: exitVisible true só com linha reta livre até ao exit', () => {
  assert.deepEqual(rayInfo(rayGrid, 5, 1, 3), { dist: 2, exitVisible: true }); // (6,1) livre, exit (7,1)
  assert.deepEqual(rayInfo(rayGrid, 1, 1, 3), { dist: 2, exitVisible: false }); // parede (4,1) bloqueia
  assert.deepEqual(rayInfo(rayGrid, 7, 1, 3), { dist: 0, exitVisible: false }); // exit não é "estritamente" à direita
  assert.deepEqual(rayInfo(rayGrid, 7, 1, 2), { dist: 2, exitVisible: false }); // exit está atrás (← não o vê)
  assert.deepEqual(rayInfo(rayGrid, 5, 1, 0), { dist: 0, exitVisible: false }); // direção perpendicular
});
check('rayInfo: dist atravessa o exit (conta só abertas até à parede)', () => {
  // 9x5: linha 3 totalmente aberta, exit em (7,3).
  const g = gridMaze(9, 5, ['#########', '#.......#', '#.......#', '#.......#', '#########'], { x: 7, y: 3 });
  assert.deepEqual(rayInfo(g, 1, 3, 3), { dist: 6, exitVisible: true }); // (2..7,3) abertas, (8,3) parede
});
check('rayInfo: dir inválido lança RangeError', () => {
  assert.throws(() => rayInfo(rayGrid, 1, 1, 4), RangeError);
  assert.throws(() => rayInfo(rayGrid, 1, 1, -1), RangeError);
});

// ── sensors.mjs ───────────────────────────────────────────────────────────────
check('sensors: EXIT_SIGNAL === 1.0 e SENSOR_NAMES exatos (12 com memória de visitas)', () => {
  assert.equal(EXIT_SIGNAL, 1.0);
  assert.deepEqual(SENSOR_NAMES, [
    'parede↑', 'parede↓', 'parede←', 'parede→', 'saída↑', 'saída↓', 'saída←', 'saída→',
    'visitado↑', 'visitado↓', 'visitado←', 'visitado→',
  ]);
});
check('sense: com withMap devolve Float32Array(12 + cols*rows); paredes normalizadas por max(cols,rows)', () => {
  // 9x3: max=9. Em (5,1): ↑↓← parede (0), → corrida de 2 até à parede, exit visível.
  const s = sense(rayGrid, 5, 1, null, { withMap: true });
  assert.ok(s instanceof Float32Array);
  assert.equal(s.length, 12 + rayGrid.cols * rayGrid.rows);
  assert.equal(s[0], 0);
  assert.equal(s[1], 0);
  assert.equal(s[2], 0);
  assert.equal(s[3], Math.fround(2 / 9));
});
check('sense: sinal de saída exato (1.0 visível / 0 invisível)', () => {
  const seen = sense(rayGrid, 5, 1);
  assert.equal(seen[7], 1.0); // → vê o exit
  assert.equal(seen[4], 0);
  assert.equal(seen[5], 0);
  assert.equal(seen[6], 0);
  const blocked = sense(rayGrid, 1, 1); // → bloqueado pela parede (4,1)
  assert.equal(blocked[7], 0);
  assert.equal(blocked[3], Math.fround(2 / 9));
});
check('sense: valores sempre em [0,1] e sinais em {0,1} em labirintos reais', () => {
  for (const n of [5, 11, 21]) {
    const m = generateMaze(n, n, 6);
    for (let y = 0; y < m.rows; y++) {
      for (let x = 0; x < m.cols; x++) {
        if (m.isWall(x, y)) continue;
        const s = sense(m, x, y);
        for (let i = 0; i < 4; i++) {
          assert.ok(s[i] >= 0 && s[i] <= 1, 'dist normalizada fora de [0,1]');
          assert.ok(s[4 + i] === 0 || s[4 + i] === 1, 'sinal de saída inválido');
        }
      }
    }
  }
});
check('sense: exatamente 1 sinal de saída aceso por célula em labirinto perfeito (alinhamento)', () => {
  // Numa célula alinhada com o exit na mesma linha/coluna e sem paredes pelo caminho,
  // o sinal correspondente tem de estar aceso; nos restantes casos testados acima está apagado.
  const g = gridMaze(9, 5, ['#########', '#.......#', '#.......#', '#.......#', '#########'], { x: 7, y: 3 });
  const s = sense(g, 3, 3);
  assert.equal(s[7], 1.0); // → alinhado, livre
  assert.equal(s[6], 0); // ← exit não está estritamente à esquerda
  assert.equal(s[4], 0);
  assert.equal(s[5], 0);
});

// ── E2: memória de células visitadas (índices 8..11) ──────────────────────────
// Grelha 9x5 aberta por dentro; em (4,2): ↑1 célula no raio, ↓1, ←3, →3.
const openGrid = gridMaze(9, 5, ['#########', '#.......#', '#.......#', '#.......#', '#########'], { x: 7, y: 3 });

check('sense E2: fração de visitadas exata por direção (grelha à mão)', () => {
  const v = new Uint8Array(9 * 5);
  v[1 * 9 + 4] = 1; // (4,1) visitada: ↑ 1/1
  // (4,3) por visitar: ↓ 0/1
  v[2 * 9 + 3] = 1; // (3,2) e (1,2) visitadas: ← 2/3
  v[2 * 9 + 1] = 1;
  v[2 * 9 + 6] = 1; // (6,2) e (7,2) visitadas: → 2/3
  v[2 * 9 + 7] = 1;
  const s = sense(openGrid, 4, 2, v);
  assert.equal(s[8], 1); // ↑ 1/1
  assert.equal(s[9], 0); // ↓ 0/1
  assert.equal(s[10], Math.fround(2 / 3)); // ← 2/3
  assert.equal(s[11], Math.fround(2 / 3)); // → 2/3
  // Frações parciais e dist === 0: em (1,1), ↑ e ← têm parede adjacente ⇒ 0
  // mesmo com a parede (1,0) marcada visitada; ↓ 1/2 ((1,2) sim, (1,3) não); → 1/6.
  v[0 * 9 + 1] = 1;
  const s2 = sense(openGrid, 1, 1, v);
  assert.equal(s2[8], 0); // ↑ dist 0
  assert.equal(s2[9], Math.fround(1 / 2)); // ↓ (1,2),(1,3)
  assert.equal(s2[10], 0); // ← dist 0
  assert.equal(s2[11], Math.fround(1 / 6)); // → (2,1)..(7,1), só (4,1) visitada
});
check('sense E2: visited a zeros ⇒ frações 0', () => {
  const s = sense(openGrid, 4, 2, new Uint8Array(9 * 5));
  for (let i = 8; i < 12; i++) assert.equal(s[i], 0, 'fração devia ser 0 em ' + i);
});
check('sense E2: visited null ⇒ frações 0; índices 0..7 inalterados por visited', () => {
  const s = sense(openGrid, 4, 2);
  for (let i = 8; i < 12; i++) assert.equal(s[i], 0, 'fração devia ser 0 em ' + i);
  const v = new Uint8Array(9 * 5);
  v[1 * 9 + 4] = 1;
  v[2 * 9 + 3] = 1;
  const sv = sense(openGrid, 4, 2, v);
  assert.deepEqual(Array.from(sv.slice(0, 8)), Array.from(s.slice(0, 8)), 'visited não pode alterar 0..7');
  assert.ok(sv[8] > 0, 'fração devia refletir as visitas');
});
check('sense E2: frações em [0,1] em labirintos reais com visited', () => {
  for (const n of [5, 11, 21]) {
    const m = generateMaze(n, n, 6);
    const v = new Uint8Array(m.cols * m.rows);
    for (let i = 0; i < v.length; i += 3) v[i] = 1;
    for (let y = 0; y < m.rows; y++) {
      for (let x = 0; x < m.cols; x++) {
        if (m.isWall(x, y)) continue;
        const s = sense(m, x, y, v);
        for (let i = 8; i < 12; i++) assert.ok(s[i] >= 0 && s[i] <= 1, 'fração fora de [0,1]');
      }
    }
  }
});

// ── E13: modo de memória — sense() SEM mapa devolve 12; withMap mantém o mapa E7 ──
check('sense E13: sem opts.withMap devolve exatamente 12 valores (0..11 idênticos ao withMap)', () => {
  const v = new Uint8Array(9 * 5);
  v[1 * 9 + 4] = 1;
  v[2 * 9 + 3] = 1;
  const s = sense(openGrid, 4, 2, v);
  assert.ok(s instanceof Float32Array);
  assert.equal(s.length, 12);
  const sm = sense(openGrid, 4, 2, v, { withMap: true });
  assert.equal(sm.length, 12 + 9 * 5);
  assert.deepEqual(Array.from(s), Array.from(sm.slice(0, 12)), 'índices 0..11 divergem entre modos');
  assert.equal(sense(openGrid, 4, 2, v, {}).length, 12); // opts vazio ⇒ 12
  assert.equal(sense(openGrid, 4, 2, v, { withMap: false }).length, 12);
  assert.equal(sense(openGrid, 4, 2).length, 12); // sem visited ⇒ 12
});

check('sense E13: withMap devolve estados 0 / 0,5 / 1,0 exatos por célula', () => {
  const v = new Uint8Array(9 * 5);
  v[2 * 9 + 3] = 1; // (3,2) visitada
  v[2 * 9 + 5] = 1; // (5,2) visitada
  const s = sense(openGrid, 4, 2, v, { withMap: true });
  assert.equal(s[12 + 2 * 9 + 3], 0.5); // visitada
  assert.equal(s[12 + 2 * 9 + 5], 0.5); // visitada
  assert.equal(s[12 + 2 * 9 + 4], 1.0); // posição ATUAL (4,2) tem valor próprio
  assert.equal(s[12 + 1 * 9 + 1], 0); // nunca visitada
  // a posição atual vale 1.0 MESMO marcada em visited (nunca 0.5)
  v[2 * 9 + 4] = 1;
  assert.equal(sense(openGrid, 4, 2, v, { withMap: true })[12 + 2 * 9 + 4], 1.0);
  // sem visited: mapa todo a 0 exceto a posição atual (1.0)
  const s2 = sense(openGrid, 4, 2, null, { withMap: true });
  for (let i = 12; i < s2.length; i++) {
    if (i === 12 + 2 * 9 + 4) continue;
    assert.equal(s2[i], 0, 'célula ' + i + ' devia ser 0');
  }
  assert.equal(s2[12 + 2 * 9 + 4], 1.0);
});

// ── EMENDA v6/E15: distanceField — BFS até ao exit, paredes bloqueiam ─────────
// Grelha 5x5 à mão com exit em (3,1). O caminho de Manhattan ((1,1)→(3,1) = 2) está
// BLOQUEADO pela coluna x=2: o BFS dá a volta por baixo ⇒ dist((1,1)) = 6.
//   #####
//   #.#.#
//   #.#.#
//   #...#
//   #####
const bfsGrid = gridMaze(5, 5, ['#####', '#.#.#', '#.#.#', '#...#', '#####'], { x: 3, y: 1 });
check('distanceField: exato em grelha à mão (paredes bloqueiam; BFS ≠ Manhattan)', () => {
  const d = distanceField(bfsGrid);
  assert.ok(d instanceof Int32Array);
  assert.equal(d.length, 5 * 5);
  assert.equal(d[bfsGrid.idx(3, 1)], 0, 'exit = 0');
  assert.equal(d[bfsGrid.idx(3, 2)], 1);
  assert.equal(d[bfsGrid.idx(3, 3)], 2);
  assert.equal(d[bfsGrid.idx(2, 3)], 3);
  assert.equal(d[bfsGrid.idx(1, 3)], 4);
  assert.equal(d[bfsGrid.idx(1, 2)], 5);
  assert.equal(d[bfsGrid.idx(1, 1)], 6, 'BFS dá a volta: 6, não Manhattan=2');
  assert.ok(d[bfsGrid.idx(1, 1)] > 2, 'as paredes têm de bloquear o caminho direto');
  // paredes todas a -1
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 5; x++) {
      if (bfsGrid.isWall(x, y)) assert.equal(d[bfsGrid.idx(x, y)], -1, `parede (${x},${y}) devia ser -1`);
    }
  }
});
check('distanceField: células abertas inalcançáveis ficam a -1', () => {
  // Duas colunas desconectadas; exit em (3,2). (1,·) fica inalcançável.
  //   #####
  //   #.#.#
  //   #.#.#
  //   #####
  const g = gridMaze(5, 4, ['#####', '#.#.#', '#.#.#', '#####'], { x: 3, y: 2 });
  const d = distanceField(g);
  assert.equal(d[g.idx(3, 2)], 0);
  assert.equal(d[g.idx(3, 1)], 1);
  assert.equal(d[g.idx(1, 1)], -1, 'região isolada aberta tem de ficar a -1');
  assert.equal(d[g.idx(1, 2)], -1);
});
check('distanceField: em labirintos reais dist(start) === len(solveMaze) − 1 (5..31)', () => {
  for (const n of ODD_SIZES) {
    const m = generateMaze(n, n, 2);
    const d = distanceField(m);
    const path = solveMaze(m);
    assert.equal(d[m.idx(m.exit.x, m.exit.y)], 0);
    assert.equal(d[m.idx(m.start.x, m.start.y)], path.length - 1, `BFS ≠ caminho em ${n}`);
    // consistência: cada célula do caminho desce exatamente 1 em cada passo
    for (let i = 1; i < path.length; i++) {
      const a = d[m.idx(path[i - 1].x, path[i - 1].y)];
      const b = d[m.idx(path[i].x, path[i].y)];
      assert.equal(a - b, 1, `degrau errado em ${n} (${i})`);
    }
  }
});

// ── EMENDA v6/E18: senseInto — igual a sense, sem alocação (mesmo `out`) ──────
check('senseInto: igual a sense em todos os modos (com/sem visited, com/sem withMap)', () => {
  const v = new Uint8Array(9 * 5);
  v[1 * 9 + 4] = 1;
  v[2 * 9 + 3] = 1;
  const cases = [
    [openGrid, 4, 2, v, {}],
    [openGrid, 1, 1, v, {}],
    [openGrid, 4, 2, null, {}],
    [openGrid, 4, 2, v, { withMap: true }],
    [openGrid, 4, 2, null, { withMap: true }],
    [rayGrid, 5, 1, null, {}],
    [rayGrid, 5, 1, v, { withMap: true }],
  ];
  for (const [m, x, y, vis, o] of cases) {
    const want = sense(m, x, y, vis, o);
    const out = new Float32Array(want.length);
    const got = senseInto(out, m, x, y, vis, o);
    assert.equal(got, out, 'senseInto tem de devolver o MESMO buffer');
    assert.deepEqual(Array.from(got), Array.from(want), `divergência em (${x},${y}) ${JSON.stringify(o)}`);
  }
});
check('senseInto: sem alocação — o mesmo `out` é mutado no local e devolvido', () => {
  const out = new Float32Array(12);
  const r1 = senseInto(out, openGrid, 4, 2, null);
  assert.equal(r1, out, 'referência tem de ser o mesmo objeto');
  const first = Array.from(out);
  const r2 = senseInto(out, openGrid, 1, 1, null); // posição diferente, MESMO buffer
  assert.equal(r2, out);
  assert.notDeepEqual(Array.from(out), first, 'conteúdo tem de ser sobrescrito no local');
  // chamadas repetidas não crescem nada: identidade estável
  for (let t = 0; t < 5; t++) assert.equal(senseInto(out, openGrid, 4, 2, null), out);
  assert.deepEqual(Array.from(out), Array.from(sense(openGrid, 4, 2, null)), 'reutilização alterou o resultado');
});
check('senseInto: buffer reutilizado com withMap reescreve o mapa todo (0 / 0,5 / 1,0)', () => {
  const n = 12 + 9 * 5;
  const out = new Float32Array(n).fill(7); // lixo prévio em TODO o buffer
  const v = new Uint8Array(9 * 5);
  v[2 * 9 + 3] = 1;
  senseInto(out, openGrid, 4, 2, v, { withMap: true });
  assert.deepEqual(Array.from(out), Array.from(sense(openGrid, 4, 2, v, { withMap: true })));
  // sem visited no MESMO buffer: o mapa tem de ficar todo a 0 exceto a posição atual
  senseInto(out, openGrid, 4, 2, null, { withMap: true });
  for (let i = 12; i < n; i++) {
    if (i === 12 + 2 * 9 + 4) continue;
    assert.equal(out[i], 0, 'célula ' + i + ' devia ser reescrita a 0');
  }
  assert.equal(out[12 + 2 * 9 + 4], 1.0);
  assert.deepEqual(Array.from(out), Array.from(sense(openGrid, 4, 2, null, { withMap: true })));
});
check('senseInto: buffer curto lança RangeError; excedente não é tocado', () => {
  assert.throws(() => senseInto(new Float32Array(11), openGrid, 4, 2, null), RangeError);
  assert.throws(() => senseInto(new Float32Array(12), openGrid, 4, 2, null, { withMap: true }), RangeError);
  const big = new Float32Array(20).fill(9);
  senseInto(big, openGrid, 4, 2, null);
  assert.equal(big[12], 9, 'entradas além de 12 não podem ser tocadas sem withMap');
});

// ── fim ───────────────────────────────────────────────────────────────────────
console.log('\n' + pass + ' pass, ' + fail + ' fail');
process.exit(fail > 0 ? 1 : 0);
