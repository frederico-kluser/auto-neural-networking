/**
 * maze3d.js — Visualização 3D do labirinto [E] (ver demo/CONTRACTS.md).
 *
 * API pública (exata): createMazeView(container) ->
 *   { setMaze, updateAgent, updateAgents, resize, dispose, setAutoRotate }
 *   setMaze(maze)                      maze: { cols, rows, grid, start, exit, isWall, idx }
 *   updateAgent({ x, y, path, sensors, visited, color })
 *   updateAgents([{ x, y, path, sensors, visited, color }, ...])   (EMENDA v5 · E14)
 *                                        1 ou 2 estados de agente: reprodução dupla, os dois
 *                                        agentes jogam o MESMO labirinto ao mesmo tempo.
 *                                        sensors: Float32Array(8) — [0..3] dist. normalizada
 *                                        à parede (0=up,1=down,2=left,3=right), [4..7] sinal
 *                                        de saída visível (EXIT_SIGNAL) na mesma direção
 *                                        visited: Uint8Array(cols*rows) OPCIONAL (EMENDA v2 · E2)
 *                                        — 1 = já esteve, indexado como maze.grid; null/ausente
 *                                        não muda nada; objeto novo = episódio novo (recomeça
 *                                        do zero); mesmo objeto = marcação incremental
 *                                        color: OPCIONAL, compatível com THREE.Color (número,
 *                                        '#hex', nome CSS ou THREE.Color) — cor de identidade
 *                                        do agente (marcador, rasto, raios, pontas dos raios
 *                                        e tint de memória derivado). Omissão => paleta do
 *                                        slot: A âmbar #F5B04A (como sempre), B azul-pálido
 *                                        #8FB8DA. Nota: deteta-se por igualdade de referência
 *                                        (===) — mutar in-place o mesmo THREE.Color não é
 *                                        detetado; passe um valor/objeto novo.
 *   updateAgent(a)                     açúcar de updateAgents([a]) com o slot A (cor por
 *                                        omissão âmbar): comportamento EXATO do passado,
 *                                        incluindo no-op para null/ausente. Ver regras abaixo.
 *   Regras da lista (defensivas, documentadas):
 *                                        >2 entradas => extras IGNORADAS (só os 2 primeiros);
 *                                        entrada null/undefined/inválida => esse slot fica
 *                                        escondido; lista vazia => ambos escondidos (a saída
 *                                        mantém-se); não-array => no-op. updateAgent mantém a
 *                                        semântica antiga para null (no-op, não esconde).
 *   resize()                           ResizeObserver + pixel ratio capado em 2
 *   dispose()                          teardown completo (inclui todos os recursos dos 2 slots)
 *   setAutoRotate(enabled)             (EMENDA v2 · E3) órbita automática da câmara:
 *                                        por defeito DESLIGADA (página parada); false pára de
 *                                        imediato sem velocidade residual; prefers-reduced-motion
 *                                        recusa sempre ligar
 *
 * Estratégia de buffers (EMENDA v5 · E14, reprodução dupla): tudo é pré-alocado em
 * createMazeView/setMaze e dividido em DOIS slots de agente (A e B) com recursos
 * INDEPENDENTES cada um: marcador + sombra (disco), rasto de 400 pontos (janela
 * deslizante própria, ring buffer como sempre), 4 raios de sensores + 4 pontas + 4
 * linhas de visão à saída, e UM InstancedMesh de memória (visited) 31x31 por slot
 * (máximo 2 meshes) com snapshot Uint8Array próprio. Recursos ÚNICOS e partilhados
 * por ambos: chão, grelha, paredes (InstancedMesh 31x31), anel/feixe da saída (verde
 * semântico) e o material verde das linhas de visão. O slot B nasce escondido e só é
 * ativado quando updateAgents recebe 2 estados => em modo single a cena renderizada é
 * idêntica à de sempre (regressão). updateAgent/updateAgents correm até 60 Hz e escrevem
 * typed arrays no lugar; chamadas em estado estacionário (nada mudou) fazem zero escritas
 * e zero alocações. Sem shadow maps: a sombra de cada agente é um disco plano escuro.
 *
 * Decisões documentadas (sem desvios silenciosos):
 *  - Raios dos sensores tingidos com a cor do agente; a linha de visão à saída
 *    (EXIT_SIGNAL) permanece VERDE semântico (é semântica de saída, como o anel/feixe)
 *    com geometria por agente (cada um olha a partir da sua posição).
 *  - Bob (hover): AMBOS os agentes flutuam, com a MESMA fase do agente único de sempre
 *    (custo: 2 writes de posição por frame por agente ativo — desprezável).
 *  - Tint de memória (visited): A = 0xc9a36f (como sempre), B = 0x8fb8da, ambos a 0.15 de
 *    opacidade (EMENDA v5 · E14). Com `color` personalizado, o tint deriva da cor
 *    (lerp para cinzento neutro — aproximação, sem valor canónico).
 *  - `color` personalizado muda a identidade do agente (marcador, rasto, raios, pontas,
 *    tint); a saída continua verde (semântica fixa, nunca tingida por agente).
 */
import * as THREE from 'three';
import { OrbitControls } from '../../vendor/OrbitControls.js'; // web/vendor/ (2 níveis acima de src/viz/)

// ---- linguagem visual (binding) ----
const C_BG = 0x0e0e11;        // fundo, ligeiramente acima do chão para silhuetar paredes
const C_FLOOR = 0x0b0b0d;
const C_GRID = 0x232329;
const C_WALL_LO = 0x232329;   // variação neutra das paredes #232329..#2E2E36
const C_WALL_HI = 0x2e2e36;
const C_GREEN = 0x3fb984;     // semântica: saída / resolvido — mais nada

// ---- identidades dos agentes (EMENDA v5 · E14): A âmbar (o de sempre), B azul-pálido ----
const C_AMBER = 0xf5b04a;     // acento do agente A: marcador, rasto, raios de sensores
const C_AMBER_HI = 0xffd9a0;  // pontas dos raios do A (mais claras)
const C_VISITED = 0xc9a36f;   // âmbar #F5B04A dessaturado — memória de onde já esteve (A)
const C_BLUE = 0x8fb8da;      // azul-pálido: agente B (EMENDA v5 · E14)
const C_BLUE_HI = 0xd9e9f6;   // pontas dos raios do B (mais claras)
const C_VISITED_B = 0x8fb8da; // memória de onde já esteve (B), mesma opacidade ténue
const N_SLOTS = 2;            // máx. de agentes simultâneos; extras em updateAgents ignoradas

// ---- geometria do tabuleiro (célula = 1 unidade; mundo: x = x grelha, z = -y grelha) ----
const MAX_DIM = 31;           // labirintos 5x5..31x31 ímpares
const MAX_INST = MAX_DIM * MAX_DIM;
const WALL_SIZE = 0.92;       // ligeiramente < 1 => aresta subtil entre cubos adjacentes
const WALL_H = 0.8;           // ligeiramente < altura da célula => "edge feel"
const AGENT_R = 0.3;
const AGENT_Y = 0.32;         // centro do agente (raios saem daqui)
const TRAIL_Y = 0.015;
const TRAIL_CAP = 400;        // pontos máximos do rasto (janela deslizante) — por agente
const RAY_MIN = 0.22;         // stub visível mesmo com distância medida 0
const VISITED_Y = 0.004;      // memória: entre o chão (0) e a grelha (0.008) => sempre por baixo
const VISIT_SIZE = 0.88;      // quadrado plano ligeiramente < célula (mesmo "edge feel" das paredes)
const VISITED_ALPHA = 0.15;   // ténue (0.12..0.18)
const VISITED_OP = -1;        // renderOrder: primeiro dos transparentes => nunca cobre agente/rasto/raios
// direções canónicas 0=up(y-1), 1=down(y+1), 2=left(x-1), 3=right(x+1) -> vetor no mundo 3D
const DIR_W = [[0, 0, 1], [0, 0, -1], [-1, 0, 0], [1, 0, 0]];

// paleta por omissão de cada slot: base (identidade), ponta clara, tint de memória, emissive
const SLOT_PALETTE = [
  { base: C_AMBER, hi: C_AMBER_HI, tint: C_VISITED, emissive: 0x6b3d0a },
  { base: C_BLUE, hi: C_BLUE_HI, tint: C_VISITED_B, emissive: 0x3c4d5c },
];

export function createMazeView(container) {
  const reducedMotion =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------- renderer / cena / câmara ----------
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  const canvas = renderer.domElement;
  canvas.style.display = 'block';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  container.appendChild(canvas);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(C_BG);

  const camera = new THREE.PerspectiveCamera(45, 1, 0.5, 600);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.075;
  controls.enablePan = false;                 // tabuleiro sempre centrado
  controls.minPolarAngle = 0.18;              // clamp: nunca roda por baixo / nunca flipa
  controls.maxPolarAngle = 1.38;              // (polo < π/2 => chão sempre visível)
  let autoRotateWanted = false;               // E3: órbita automática DESLIGADA por defeito
  controls.autoRotate = false;                // gate: autoRotateWanted && !reducedMotion (ver syncAutoRotate)
  controls.autoRotateSpeed = 0.45;

  // luz: chave branca + fill fria + hemisférica (sem shadow maps, ver blob abaixo)
  const hemi = new THREE.HemisphereLight(0x39404e, 0x0b0b0d, 0.9);
  const key = new THREE.DirectionalLight(0xffffff, 1.45);
  key.position.set(9, 15, 7);
  const fill = new THREE.DirectionalLight(0x7f93b8, 0.5);
  fill.position.set(-10, 7, -8);
  scene.add(hemi, key, fill);

  // scratch reutilizado (zero alocações no estado estacionário)
  const _m4 = new THREE.Matrix4();
  const _c1 = new THREE.Color();
  const _c2 = new THREE.Color(C_WALL_HI);
  const _c3 = new THREE.Color();              // scratch p/ cor personalizada de agente
  const _c4 = new THREE.Color();              // scratch p/ derivados (ponta clara)
  const _cBlack = new THREE.Color(0x000000);
  const _cWhite = new THREE.Color(0xffffff);
  const _cGray = new THREE.Color(0x969696);   // neutro p/ dessaturar tint de memória

  // ---------- chão + grelha ----------
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshStandardMaterial({ color: C_FLOOR, roughness: 0.96, metalness: 0 })
  );
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);

  // buffer p/ (MAX_DIM+1) linhas por eixo, 2 vértices cada; setMaze escolhe quantas desenhar
  const gridGeom = new THREE.BufferGeometry();
  const gridPos = new THREE.BufferAttribute(new Float32Array((MAX_DIM + 1) * 2 * 2 * 3), 3);
  gridPos.setUsage(THREE.DynamicDrawUsage);
  gridGeom.setAttribute('position', gridPos);
  const gridLines = new THREE.LineSegments(
    gridGeom,
    new THREE.LineBasicMaterial({ color: C_GRID, transparent: true, opacity: 0.55 })
  );
  gridLines.position.y = 0.008;
  gridLines.frustumCulled = false;
  scene.add(gridLines);

  // ---------- paredes: UM InstancedMesh, capacidade máxima fixa ----------
  const walls = new THREE.InstancedMesh(
    new THREE.BoxGeometry(WALL_SIZE, WALL_H, WALL_SIZE),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.82, metalness: 0.05 }),
    MAX_INST
  );
  walls.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  // instanceColor pré-criado: setColorAt nunca aloca e o tamanho não depende de count
  walls.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_INST * 3).fill(1), 3);
  walls.instanceColor.setUsage(THREE.DynamicDrawUsage);
  walls.count = 0; // nada desenhado até setMaze
  walls.frustumCulled = false;
  scene.add(walls);

  // ---------- saída: anel + feixe verde (SEMÂNTICA partilhada por ambos os agentes) ----------
  const ringGeom = new THREE.TorusGeometry(0.42, 0.055, 12, 40);
  ringGeom.rotateX(Math.PI / 2); // torus deitado no chão
  const exitRing = new THREE.Mesh(
    ringGeom,
    new THREE.MeshBasicMaterial({ color: C_GREEN, transparent: true, opacity: 0.92 })
  );
  exitRing.position.y = 0.05;
  const exitBeam = new THREE.Mesh(
    new THREE.CylinderGeometry(0.3, 0.44, 2.0, 24, 1, true),
    new THREE.MeshBasicMaterial({
      color: C_GREEN, transparent: true, opacity: 0.13,
      depthWrite: false, side: THREE.DoubleSide
    })
  );
  exitBeam.position.y = 1.0;
  exitBeam.renderOrder = 1;
  scene.add(exitRing, exitBeam);

  // LOS verde SEMÂNTICO (linha de visão à saída): UM material partilhado por todas as
  // linhas de visão (cada agente tem as SUAS 4 geometrias — olham de posições diferentes).
  const losMat = new THREE.LineBasicMaterial({
    color: C_GREEN, transparent: true, opacity: 0.3, depthWrite: false
  });

  // ---------- slots de agente (A e B): recursos independentes, todos pré-alocados ----------
  // Cada slot tem: marcador (esfera) + sombra (disco), rasto (400 pts, ring buffer próprio),
  // 4 raios + 4 pontas (tingidos com a cor do agente), 4 LOS (verde semântico, geometria
  // própria) e UM InstancedMesh de memória (visited) 31x31 com snapshot próprio. O slot B
  // nasce escondido; em modo single nada disto renderiza => comportamento idêntico ao de
  // sempre.
  function makeAgentSlot(id) {
    const pal = SLOT_PALETTE[id];

    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(AGENT_R, 28, 20),
      new THREE.MeshStandardMaterial({
        color: pal.base, roughness: 0.4, metalness: 0.15,
        emissive: pal.emissive, emissiveIntensity: 0.35
      })
    );
    mesh.position.y = AGENT_Y;
    scene.add(mesh);

    const blob = new THREE.Mesh(
      new THREE.CircleGeometry(AGENT_R * 1.6, 28),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.34, depthWrite: false })
    );
    blob.rotation.x = -Math.PI / 2;
    blob.position.y = 0.035;
    blob.renderOrder = 1;
    scene.add(blob);

    // rasto do caminho: polyline com janela deslizante de TRAIL_CAP pontos sobre
    // Float32Array pré-alocado (por slot)
    const trailGeom = new THREE.BufferGeometry();
    const trailPos = new THREE.BufferAttribute(new Float32Array(TRAIL_CAP * 3), 3);
    trailPos.setUsage(THREE.DynamicDrawUsage);
    trailGeom.setAttribute('position', trailPos);
    trailGeom.setDrawRange(0, 0);
    const trail = new THREE.Line(
      trailGeom,
      new THREE.LineBasicMaterial({ color: pal.base, transparent: true, opacity: 0.65, depthWrite: false })
    );
    trail.frustumCulled = false;
    trail.renderOrder = 2;
    scene.add(trail);

    // raios dos sensores (4) + pontas + linhas de visão à saída
    // Materiais por direção => alpha variável por raio sem tocar em shaders nem alocar.
    const rayLines = [], rayCaps = [], losLines = [], rayMats = [], capMats = [];
    for (let d = 0; d < 4; d++) {
      const rg = new THREE.BufferGeometry(); // 2 vértices: origem (agente) -> ponta do raio
      rg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3).setUsage(THREE.DynamicDrawUsage));
      const rm = new THREE.LineBasicMaterial({
        color: pal.base, transparent: true, opacity: 0.6, depthWrite: false
      });
      const rl = new THREE.LineSegments(rg, rm);
      rl.frustumCulled = false;
      rl.renderOrder = 3;
      scene.add(rl);
      rayLines.push(rl);
      rayMats.push(rm);

      const cm = new THREE.MeshBasicMaterial({
        color: pal.hi, transparent: true, opacity: 0.85, depthWrite: false
      });
      const cap = new THREE.Mesh(new THREE.SphereGeometry(0.075, 12, 8), cm);
      cap.frustumCulled = false;
      cap.renderOrder = 3;
      scene.add(cap);
      rayCaps.push(cap);
      capMats.push(cm);

      const lg = new THREE.BufferGeometry(); // LOS verde: agente -> centro da saída
      lg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3).setUsage(THREE.DynamicDrawUsage));
      const ll = new THREE.LineSegments(lg, losMat); // material verde partilhado (semântica)
      ll.frustumCulled = false;
      ll.visible = false;
      ll.renderOrder = 3;
      scene.add(ll);
      losLines.push(ll);
    }

    // ---------- memória de onde já esteve: UM InstancedMesh de quadrados planos POR SLOT ----------
    // (EMENDA v2 · E2) Ténue tingimento por célula visitada, SEMPRE por baixo do agente,
    // rasto e raios: y entre chão e grelha, renderOrder -1 (primeiro dos transparentes),
    // depthWrite off (nunca oclui nada) e depthTest on (paredes continuam a silhuetar).
    // Capacidade pré-alocada fixa 31x31; as matrizes são só translações (geometria já deitada).
    // (EMENDA v5 · E14: máximo 2 meshes — um por agente — nunca mais.)
    const visitGeom = new THREE.PlaneGeometry(VISIT_SIZE, VISIT_SIZE);
    visitGeom.rotateX(-Math.PI / 2); // quadrado deitado no chão (normal +Y)
    const visitMat = new THREE.MeshBasicMaterial({
      color: pal.tint, transparent: true, opacity: VISITED_ALPHA, depthWrite: false
    });
    const visitMesh = new THREE.InstancedMesh(visitGeom, visitMat, MAX_INST);
    visitMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    visitMesh.count = 0; // nada desenhado até haver visited
    visitMesh.frustumCulled = false;
    visitMesh.renderOrder = VISITED_OP;
    scene.add(visitMesh);

    return {
      id, pal, mesh, blob,
      trailGeom, trailPos, trail,
      trailPathRef: null, trailPathLen: -1,
      rayLines, rayCaps, losLines, rayMats, capMats,
      visitMesh,
      visitSnap: new Uint8Array(MAX_INST), // espelho do que está desenhado (pré-alocado)
      visitRef: null, visitCount: 0,
      active: id === 0,    // A visível desde o arranque (como sempre); B até haver 2º agente
      colorRaw: undefined  // última `color` aplicada (comparação === => zero escritas em steady state)
    };
  }

  const slots = [makeAgentSlot(0), makeAgentSlot(1)];

  // ---------- estado global ----------
  let cols = 11, rows = 11;      // dimensões até setMaze
  let ox = 5, oz = 5;            // centragem: mundo x = gx-ox, z = oz-gy (y grelha desce = -z)
  let exitX = 0, exitZ = 0;
  let raf = 0;
  let disposed = false;

  function fitCamera() {
    // vista inclinada: az ~32°, elevação ~53°; distância calculada para enquadrar o tabuleiro
    const dist = Math.max(cols, rows) * 1.15 + 4;
    const az = 0.56, el = 0.92;
    camera.position.set(
      Math.sin(az) * Math.cos(el) * dist,
      Math.sin(el) * dist,
      Math.cos(az) * Math.cos(el) * dist
    );
    controls.target.set(0, 0, 0);
    controls.minDistance = Math.max(cols, rows) * 0.35;
    controls.maxDistance = Math.max(cols, rows) * 3;
    camera.updateProjectionMatrix();
    controls.update();
  }

  function resize() {
    const w = container.clientWidth || 1;
    const h = container.clientHeight || 1;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2)); // DPR capado em 2
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  function setMaze(maze) {
    if (!maze) return;
    cols = maze.cols | 0;
    rows = maze.rows | 0;
    ox = (cols - 1) / 2;
    oz = (rows - 1) / 2;
    floor.scale.set(cols + 1, rows + 1, 1);

    // grelha do chão: buffer máximo, drawRange escolhe as linhas deste maze
    const gp = gridPos.array;
    let v = 0;
    for (let gx = 0; gx <= cols; gx++) {
      const wx = gx - ox - 0.5;
      gp[v++] = wx; gp[v++] = 0; gp[v++] = oz + 0.5;
      gp[v++] = wx; gp[v++] = 0; gp[v++] = -oz - 0.5;
    }
    for (let gy = 0; gy <= rows; gy++) {
      const wz = oz - gy + 0.5;
      gp[v++] = -ox - 0.5; gp[v++] = 0; gp[v++] = wz;
      gp[v++] = ox + 0.5; gp[v++] = 0; gp[v++] = wz;
    }
    gridGeom.setDrawRange(0, v / 3);
    gridPos.needsUpdate = true;

    // paredes: preencher com count no máximo (setColorAt usa instanceMatrix.count),
    // depois aparar count ao número real => um só draw call com exatamente N cubos
    walls.count = MAX_INST;
    const gridArr = maze.grid;
    const isWall = typeof maze.isWall === 'function'
      ? (x, y) => maze.isWall(x, y)
      : (x, y) => gridArr[y * cols + x] === 1;
    let n = 0;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        if (!isWall(x, y)) continue;
        _m4.makeTranslation(x - ox, WALL_H / 2, oz - y);
        walls.setMatrixAt(n, _m4);
        // tom neutro determinístico dentro de #232329..#2E2E36 (hash barato de x,y)
        const h = (((x * 73856093) ^ (y * 19349663)) >>> 0) % 1024;
        _c1.setHex(C_WALL_LO).lerp(_c2, h / 1023);
        walls.setColorAt(n, _c1);
        n++;
      }
    }
    walls.count = n;
    walls.instanceMatrix.needsUpdate = true;
    walls.instanceColor.needsUpdate = true;

    // saída e agentes no arranque (updateAgent(s) sobrepõe os agentes logo a seguir)
    const sx = maze.start ? maze.start.x - ox : 0;
    const sz = maze.start ? oz - maze.start.y : 0;
    exitX = maze.exit ? maze.exit.x - ox : 0;
    exitZ = maze.exit ? oz - maze.exit.y : 0;
    exitRing.position.set(exitX, 0.05, exitZ);
    exitBeam.position.set(exitX, 1.0, exitZ);

    for (let i = 0; i < N_SLOTS; i++) {
      const s = slots[i];
      s.mesh.position.set(sx, AGENT_Y, sz);
      s.blob.position.set(sx, 0.035, sz);
      // rasto reiniciado
      s.trailGeom.setDrawRange(0, 0);
      s.trailPathRef = null;
      s.trailPathLen = -1;
      // memória reiniciada (labirinto novo: sem estado residual)
      s.visitRef = null;
      s.visitCount = 0;
      s.visitSnap.fill(0);
      s.visitMesh.count = 0;
    }
    fitCamera();
  }

  function trailWrite(arr, i, p) {
    const o = i * 3;
    arr[o] = p.x - ox;
    arr[o + 1] = TRAIL_Y;
    arr[o + 2] = oz - p.y;
  }

  function updateTrail(s, path) {
    const n = path ? path.length : 0;
    if (path === s.trailPathRef && n === s.trailPathLen) return; // steady state: zero escritas
    const arr = s.trailPos.array;
    const delta = n - s.trailPathLen;
    if (path && path === s.trailPathRef && delta > 0 && n <= TRAIL_CAP) {
      for (let i = s.trailPathLen; i < n; i++) trailWrite(arr, i, path[i]); // só a cauda nova
    } else if (path && path === s.trailPathRef && delta > 0 && delta < TRAIL_CAP && s.trailPathLen >= TRAIL_CAP) {
      arr.copyWithin(0, delta * 3, TRAIL_CAP * 3); // anel: desliza e descarta o ponto mais antigo
      for (let i = n - delta; i < n; i++) trailWrite(arr, i - n + TRAIL_CAP, path[i]);
    } else if (n > 0) {
      const from = n > TRAIL_CAP ? n - TRAIL_CAP : 0; // reconstroi ficando com os mais recentes
      for (let i = from; i < n; i++) trailWrite(arr, i - from, path[i]);
    }
    s.trailGeom.setDrawRange(0, n > TRAIL_CAP ? TRAIL_CAP : n);
    s.trailPos.needsUpdate = true;
    s.trailPathRef = path;
    s.trailPathLen = n;
  }

  // ---------- memória de onde já esteve (visited, EMENDA v2 · E2) ----------
  // v: Uint8Array(cols*rows) com 1 = já esteve, indexado como maze.grid.
  //  - objeto NOVO (episódio novo): rebuild do conjunto do zero, sem estado residual;
  //  - MESMO objeto: incremental por cima do estado anterior (o agente marca 1 célula nova
  //    por passo => exatamente 1 escrita); estado estacionário => ZERO escritas.
  // Cada slot tem o SEU conjunto (EMENDA v5 · E14): snapshot, contadores e mesh próprios.
  function visitWrite(s, i) {
    const x = i % cols, y = (i / cols) | 0;
    _m4.makeTranslation(x - ox, VISITED_Y, oz - y);
    s.visitMesh.setMatrixAt(s.visitCount, _m4);
    s.visitSnap[i] = 1;
    s.visitCount++;
  }

  function updateVisited(s, v) {
    const n = cols * rows;
    const fresh = v !== s.visitRef;
    if (fresh) {
      s.visitRef = v;
      s.visitSnap.fill(0, 0, n);
      s.visitCount = 0;
    }
    let added = 0;
    for (let i = 0; i < n && s.visitCount < MAX_INST; i++) {
      if (v[i] && !s.visitSnap[i]) { visitWrite(s, i); added++; }
    }
    if (fresh || added > 0) {
      s.visitMesh.count = s.visitCount;
      s.visitMesh.instanceMatrix.needsUpdate = true;
    }
  }

  // ---------- cor de identidade por agente (EMENDA v5 · E14) ----------
  // raw: número / '#hex' / nome CSS / THREE.Color; undefined/null => paleta do slot.
  // Aplicada só quando o valor muda (===) => estado estacionário não escreve nem aloca.
  function applySlotColor(s, raw) {
    if (raw === s.colorRaw) return;
    s.colorRaw = raw;
    const pal = s.pal;
    if (raw == null) {
      s.mesh.material.color.setHex(pal.base);
      s.mesh.material.emissive.setHex(pal.emissive);
      s.trail.material.color.setHex(pal.base);
      s.visitMesh.material.color.setHex(pal.tint);
      for (let d = 0; d < 4; d++) {
        s.rayMats[d].color.setHex(pal.base);
        s.capMats[d].color.setHex(pal.hi);
      }
      return;
    }
    _c3.set(raw); // THREE.Color-compatible; guarda já em working space como os defaults
    s.mesh.material.color.copy(_c3);
    s.mesh.material.emissive.copy(_c3).lerp(_cBlack, 0.62);
    s.trail.material.color.copy(_c3);
    s.visitMesh.material.color.copy(_c3).lerp(_cGray, 0.45); // tint derivado (aproximação)
    _c4.copy(_c3).lerp(_cWhite, 0.5);                        // ponta mais clara derivada
    for (let d = 0; d < 4; d++) {
      s.rayMats[d].color.copy(_c3);
      s.capMats[d].color.copy(_c4);
    }
  }

  // ---------- atualização de UM slot (a mesma disciplina incremental de sempre) ----------
  function updateSlot(s, a) {
    const ax = a.x - ox;
    const az = oz - a.y; // y da grelha cresce para baixo => -z no mundo
    s.mesh.position.x = ax;
    s.mesh.position.z = az;
    s.blob.position.x = ax;
    s.blob.position.z = az;

    applySlotColor(s, a.color);
    updateTrail(s, a.path);
    if (a.visited) updateVisited(s, a.visited); // memória (opcional); null/ausente não muda nada

    const sens = a.sensors;
    const maxDim = cols > rows ? cols : rows; // normalização de core/sensors.mjs
    for (let d = 0; d < 4; d++) {
      const line = s.rayLines[d], cap = s.rayCaps[d], los = s.losLines[d];
      if (!sens) { line.visible = false; cap.visible = false; los.visible = false; continue; }
      let nrm = sens[d];
      nrm = nrm > 1 ? 1 : (nrm > 0 ? nrm : 0); // clip [0,1] por segurança
      const dist = nrm * maxDim;               // volta a unidades de célula
      const len = dist > RAY_MIN ? dist : RAY_MIN; // comprimento ~ distância medida
      const dx = DIR_W[d][0], dz = DIR_W[d][2];
      const ex = ax + dx * len, ez = az + dz * len;

      const attr = line.geometry.attributes.position;
      const p = attr.array;
      p[0] = ax; p[1] = AGENT_Y; p[2] = az;
      p[3] = ex; p[4] = AGENT_Y; p[5] = ez;
      attr.needsUpdate = true;

      const alpha = 0.3 + 0.55 * nrm;          // alpha por distância
      s.rayMats[d].opacity = alpha;
      const capA = alpha + 0.28;
      s.capMats[d].opacity = capA > 1 ? 1 : capA; // ponta mais clara no fim do raio
      cap.position.set(ex, AGENT_Y, ez);
      line.visible = true;
      cap.visible = true;

      const on = sens[4 + d] > 0.5; // EXIT_SIGNAL nesta direção
      los.visible = on;
      if (on) {
        const la = los.geometry.attributes.position;
        const q = la.array;
        q[0] = ax; q[1] = AGENT_Y; q[2] = az;
        q[3] = exitX; q[4] = AGENT_Y; q[5] = exitZ; // linha de visão reta até à saída
        la.needsUpdate = true;
      }
    }
  }

  // ativa/desativa todos os recursos de um slot (transições apenas; steady state não escreve)
  function setSlotVisible(s, on) {
    s.active = on;
    s.mesh.visible = on;
    s.blob.visible = on;
    s.trail.visible = on;
    s.visitMesh.visible = on;
    for (let d = 0; d < 4; d++) {
      s.rayLines[d].visible = on;
      s.rayCaps[d].visible = on;
      s.losLines[d].visible = false; // LOS reavaliado em updateSlot (ou escondido)
    }
  }
  setSlotVisible(slots[1], false); // B nasce escondido (reprodução simples: como sempre)

  // núcleo comum: a0 => slot A, a1 => slot B (null/undefined esconde o slot). Zero alocações.
  function applySlots(a0, a1) {
    for (let i = 0; i < N_SLOTS; i++) {
      const s = slots[i];
      const a = i === 0 ? a0 : a1;
      if (a == null) {
        if (s.active) setSlotVisible(s, false);
      } else {
        if (!s.active) setSlotVisible(s, true);
        updateSlot(s, a);
      }
    }
  }

  // EMENDA v5 · E14: reprodução dupla — 1 ou 2 estados de agente no mesmo labirinto.
  // Extras além do 2º são ignorados; ver "Regras da lista" no cabeçalho do módulo.
  function updateAgents(list) {
    if (!Array.isArray(list)) return; // não-array: no-op
    const n = list.length > N_SLOTS ? N_SLOTS : list.length;
    applySlots(n > 0 ? list[0] : null, n > 1 ? list[1] : null);
  }

  // açúcar de updateAgents([a]) com o slot A (cor por omissão âmbar) — comportamento
  // EXATO do passado, incluindo no-op para null/ausente.
  function updateAgent(a) {
    if (!a) return;
    applySlots(a, null);
  }

  function tick(now) {
    raf = requestAnimationFrame(tick);
    if (!reducedMotion) {
      const t = now * 0.001;
      const bob = Math.sin(t * 2.2);           // hover subtil do agente (ambos os slots ativos)
      for (let i = 0; i < N_SLOTS; i++) {
        const s = slots[i];
        if (!s.active) continue;
        s.mesh.position.y = AGENT_Y + bob * 0.05;
        s.blob.scale.setScalar(1 - bob * 0.07);
      }
      exitRing.scale.setScalar(1 + Math.sin(t * 2.6) * 0.05); // pulso discreto da saída
      exitBeam.material.opacity = 0.1 + (Math.sin(t * 2.6) * 0.5 + 0.5) * 0.05;
    }
    controls.update(); // damping + auto-orbit
    renderer.render(scene, camera);
  }

  // ---------- rotação automática (EMENDA v2 · E3): OFF por defeito ----------
  function syncAutoRotate() {
    // prefers-reduced-motion recusa sempre ligar, mesmo com setAutoRotate(true)
    controls.autoRotate = autoRotateWanted && !reducedMotion;
  }

  // Assenta e anula a rotação pendente que o autoRotate deixou no sphericalDelta interno do
  // OrbitControls (com damping, um simples autoRotate=false deixaria a câmara a derivar ~0.5°
  // durante dezenas de frames). O delta assenta sem desenhar e a pose exata é reposta
  // => velocidade angular residual ZERO no momento do toggle.
  function stopOrbitCleanly() {
    const p = camera.position.clone();
    const t = controls.target.clone();
    for (let i = 0; i < 128; i++) controls.update(); // damping 0.075 => resíduo final ~5e-7 rad
    camera.position.copy(p);
    controls.target.copy(t);
    camera.lookAt(t);
  }

  // true: reativa a órbita suave; false: pára de imediato, sem velocidade residual.
  // O loop rAF do módulo é o loop de animação (hover dos agentes + pulso da saída + damping +
  // render) e não é iniciado/parado por este toggle: a rotação nunca é a sua única razão.
  function setAutoRotate(enabled) {
    if (disposed) return;
    const wasOn = controls.autoRotate;
    autoRotateWanted = !!enabled;
    syncAutoRotate();
    if (wasOn && !controls.autoRotate) stopOrbitCleanly(); // só na transição on -> off
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    if (observer) observer.disconnect();
    controls.dispose();
    // scene.traverse cobre TODOS os recursos, incl. os dos 2 slots (geometrias, materiais
    // e InstancedMesh de memória); materiais/LOS partilhados são disposados uma vez e as
    // repetições são no-ops seguros no three.
    scene.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      const m = o.material;
      if (Array.isArray(m)) { for (const mm of m) mm.dispose(); }
      else if (m) m.dispose();
    });
    renderer.dispose();
    if (renderer.forceContextLoss) renderer.forceContextLoss();
    if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
  }

  const observer = typeof ResizeObserver !== 'undefined'
    ? new ResizeObserver(() => resize())
    : null;
  if (observer) observer.observe(container);
  resize();
  fitCamera();
  raf = requestAnimationFrame(tick);

  return { setMaze, updateAgent, updateAgents, resize, dispose, setAutoRotate };
}
