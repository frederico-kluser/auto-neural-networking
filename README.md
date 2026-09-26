# Rede neural que evolui sozinha: design, construção em TensorFlow.js, testes e métricas

**Dá para construir isso, e quase todas as peças já existem na literatura. A abordagem que recomendo é um sistema híbrido: um grafo recorrente sem camadas, guardado como uma matriz N×N com máscara de adjacência, com pesos treinados por gradiente (BPTT truncado em K "ticks"), crescimento estrutural por mutações cuja probabilidade se ajusta pelo sucesso histórico (seleção adaptativa de operadores, do tipo *adaptive pursuit*) e parada automática pelos critérios de early stopping de Prechelt.** O que é novo é a combinação, não os componentes. O NEAT já cresce redes recorrentes a partir de uma estrutura mínima. O Cascade-Correlation já adiciona um neurônio por vez. As Echo State Networks já estudaram quando um grafo recorrente fica estável ou caótico. E a seleção adaptativa de operadores já resolve o "aprender quais mutações funcionam". O maior risco não está na implementação, e sim na avaliação: com ruído, o mecanismo de seleção acaba sobreajustado à validação, e sem pressão de parcimônia a rede incha.

## TL;DR

- **Viável e recomendado:** um grafo com capacidade pré-alocada (64–256 slots) e máscaras. Crescer é "ligar" slots e conexões, sem realocar tensores. Os pesos são treinados com `tf.variableGrads` + Adam do TensorFlow.js 4.22.0. Cada mutação é aceita ou rejeitada numa comparação pareada contra um controle sem mutação. A probabilidade de cada operação se atualiza por *adaptive pursuit*, sempre com um mínimo de exploração.
- **Parada e estabilidade:** a rede para de crescer sozinha por uma combinação de GL/PQ de Prechelt num conjunto de validação separado, paciência e estagnação estrutural. A oscilação é contida por integração com vazamento, `tanh`, raio espectral efetivo abaixo de 1 e uma penalidade de suavidade temporal. Ela é medida por amplitude pico-a-pico, taxa de troca de classe, tempo até estabilizar e expoente de Lyapunov.
- **Como saber o que evoluiu:** registre cada mutação como um evento (tipo, Δ perda vs. controle, custo, aceita ou não), guarde snapshots e a linhagem, e compare com baselines (MLP, reservatório aleatório) e ablações usando pelo menos 10 seeds. Uma mutação "ajudou" quando melhora a validação além do ruído medido entre seeds.

## Key Findings

1. **O que já existe.**
   - O NEAT (Stanley & Miikkulainen, *Evolutionary Computation* 10(2):99–127, 2002) atribui seu desempenho a três coisas: crossover entre topologias via números de inovação, especiação para proteger inovações e crescimento a partir de uma estrutura mínima. No *double pole balancing* sem velocidade, o NEAT precisou de 33.184 avaliações, contra 169.466 do ESP e 840.000 do Cellular Encoding (Stanley & Miikkulainen, CEC 2002, Tabela 1). O artigo de 2002 resume isso como "25 times faster than Cellular Encoding and 5 times faster than ESP".
   - O Cascade-Correlation (Fahlman & Lebiere, 1990) começa só com as saídas. Treina até um platô, congela, treina um candidato para maximizar a correlação com o erro residual e o adiciona.
   - A versão recorrente (Fahlman, "The Recurrent Cascade-Correlation Architecture", *NIPS 3*, pp. 190–196, 1991) mostra que isso também funciona com memória.
2. **Crescer sem destruir o que foi aprendido já tem solução.**
   - Net2Net (Chen, Goodfellow & Shlens, 2015): transformações que preservam a função.
   - GradMax (Evci et al., ICLR 2022): adiciona neurônios sem mudar a saída e maximiza o gradiente dos pesos novos.
   - Splitting Steepest Descent (Liu, Wu & Wang, NeurIPS 2019): decide qual neurônio dividir.
   - Self-Expanding Neural Networks (Mitchell et al., 2023): decidem quando, onde e o quê expandir e limitam a taxa de adição.
   - Lição prática: **toda estrutura nova nasce com peso de saída zero.**
3. **Um grafo recorrente arbitrário tem regimes dinâmicos conhecidos.**
   - Em redes `tanh`, a *echo state property* é violada, para entrada zero, quando o raio espectral passa de 1 (Jaeger, Scholarpedia).
   - Sompolinsky, Crisanti & Sommers (PRL 61:259, 1988) mostraram uma transição de fase estacionária para caótica num ganho crítico.
   - Isso corresponde exatamente ao seu "bom" (oscilação baixa) e "ruim" (mudança sem parar), e pode ser medido e controlado.
4. **"Aprender quais operações funcionam" é o problema de *Adaptive Operator Selection*.**
   - Probability Matching: `P_i = P_min + (1 − K·P_min)·Q_i/ΣQ`.
   - O *Adaptive Pursuit* (Thierens, GECCO 2005) converge mais rápido para o melhor operador.
   - Num estudo de reparo automático de programas (arXiv 2306.05792, com 30.080 tentativas de reparo em 353 bugs reais do Defects4J), o texto relata a ordem PM < AP < UCB na taxa de sucesso. O próprio resumo, porém, ressalva que a seleção por RL "does not exhibit a noticeable improvement in the number of bugs patched in comparison with the baseline, which uses random selection". Ou seja, a seleção adaptativa não é garantia de ganho.
5. **Early stopping tem custo conhecido.** Prechelt ("Automatic early stopping using cross validation: quantifying the criteria", *Neural Networks* 11(4):761–767, 1998) testou 14 critérios em 12 tarefas com MLPs treinados por RPROP. A conclusão foi que "slower stopping criteria allow for small improvements in generalization (in the order of 4%), but cost about a factor of 4 longer in training time".
6. **O TensorFlow.js tem lacunas que mudam o design.**
   - A versão estável é a **4.22.0** (21/10/2024), que continua marcada como "Latest" nos releases do GitHub. A issue #8609 (dez/2025) registra que "no new release has been cut" desde a correção de abril e que a "latest release (4.22.0) tfjs-node is broken with node 24". Use uma versão LTS anterior do Node.
   - `tf.linalg` tem só `qr`, `gramSchmidt` e `bandPart`. Não existem `solve`, `inv`, `eig` nem `svd`, e também não há `clipByGlobalNorm`.
   - Por isso o raio espectral tem de ser estimado iterativamente e o clipping global tem de ser implementado à mão.

## Details

### 1. Requisito → técnica → referência → o que aproveitar

| Requisito | Técnica | Referência | O que aproveitar |
|---|---|---|---|
| Começar com 1 neurônio e crescer | Complexificação mínima; cascata | NEAT (2002); Cascade-Correlation (1990) | Estrutura mínima; um neurônio por vez; consolidar antes de crescer |
| Sem camadas, saída para vários neurônios, ciclos | Grafo recorrente; reservatório | ESN (Jaeger); Lukoševičius, "A Practical Guide to Applying ESNs" (LNCS 7700, 2012); Randomly Wired NNs (Xie et al., ICCV 2019) | Matriz N×N mascarada; limitar o raio espectral; grafos aleatórios já são competitivos |
| Informação circulando e resposta mudando no tempo | Sistemas dinâmicos | CTRNN (Beer); Liquid Time-constant Networks (Hasani et al., AAAI 2021); CfC (Nature Machine Intelligence, 2022) | Vazamento/constante de tempo, `tanh`, leitura ao longo dos ticks |
| Mutação aleatória que passa a ser guiada pelo sucesso | Adaptive Operator Selection | Thierens (2005); Fialho et al. (bandits dinâmicos); arXiv 2306.05792 | Banco de operadores, crédito = melhora na validação, `P_min` |
| Crescer sem perder o aprendido | Preservação de função | Net2Net; GradMax; Splitting; SENN | Pesos de saída novos = 0; divisão com saídas pela metade |
| Detectar overfitting e parar | Early stopping | Prechelt, "Early Stopping — But When?" | GL, PQ, UP, paciência |
| Não escolher "sortudos" | Evolução regularizada | Real et al., AAAI 2019 | Reavaliar antes de confirmar; val_sel ≠ val_stop ≠ teste |
| A topologia importa? | WANN | Gaier & Ha, NeurIPS 2019 | Teste com peso compartilhado |
| Referências em JS | NEAT em JS | neataptic (não mantido); NeatapticTS; TensorNEAT (arXiv 2404.01817) | Baseline sem gradiente |

Existem preprints de 2025–2026 com o mesmo objetivo: arXiv 2501.12690 (crescimento em DAGs arbitrários), 2608.16409 ("SoftModel") e 2512.12713. Não li o texto completo deles, então nenhum resultado desses trabalhos é usado aqui.

### 2. Design proposto

#### 2.1 Entidades

```
┌──────────────────────── Runner contínuo (start/stop) ───────────────────────┐
│  ┌────────┐  treina K passos  ┌─────────┐  propõe op  ┌──────────────┐      │
│  │ Grafo  │◄──────────────────│ Trainer │◄────────────│ OperatorBank │      │
│  │(W,M,..)│                   │(Adam,   │  crédito    │(probabilid.  │      │
│  └───┬────┘                   │ BPTT-K) │────────────►│ adaptativas) │      │
│      │ snapshot/restore       └────┬────┘             └──────────────┘      │
│  ┌───▼──────┐ Δ vs controle ┌──────▼─────┐  GL/PQ/UP  ┌──────────────────┐  │
│  │Avaliador │──────────────►│ Aceitação  │───────────►│ Controlador de   │  │
│  │(val_sel) │               │ de mutação │            │ parada (val_stop)│  │
│  └──────────┘               └────────────┘            └──────────────────┘  │
│   sonda dinâmica (amplitude, Lyapunov, ρ) → logger JSONL / tfjs-vis         │
└─────────────────────────────────────────────────────────────────────────────┘
```

- **Neurônio:** um slot `j` de capacidade `C`, com `alive[j]`, viés e `tanh`.
- **Conexão:** `M[i][j] = 1` com peso `W[i][j]`. Linha = origem, coluna = destino. Autoconexões e ciclos são permitidos.
- **Entradas e opções de output:** as features entram por `W_in` com máscara `M_in`, e as K classes são lidas por `W_out` com máscara `M_out`. No início só o neurônio 0 existe: recebe todas as features e se liga a todas as saídas.
- **Supervisão:** um gabarito ou um oráculo `f(x)`. O oráculo funciona como gerador de dados. Se ele existir, gere dados novos a cada época, o que deixa o conjunto de treino efetivamente infinito e reduz muito o overfitting.
- **Mutação:** `(grafo, rng) → boolean`, com inicialização que preserva a função.
- **Avaliador:** usa val_sel. **Controlador de parada:** usa val_stop. **Runner:** um loop assíncrono com as fases `GROW → CONSOLIDATE → OBSERVE`.

#### 2.2 A rede como sistema dinâmico

```
drive   = x·(W_in ⊙ M_in) + b
h_{t+1} = [(1−α)·h_t + α·tanh(h_t·(W ⊙ M) + drive)] ⊙ alive
y_t     = h_t·(W_out ⊙ M_out) + b_out
```

- `α` é a taxa de vazamento: menor significa dinâmica mais lenta e suave.
- A saída oficial é `y_K`, mas a trajetória inteira fica guardada para medir a oscilação.
- Como `∂(W⊙M)/∂W = M`, o gradiente é exatamente zero nas conexões inexistentes.
- Em tarefas temporais, cada elemento da sequência é injetado por `k` ticks, então a informação precisa circular para ser lembrada.
- Perto de `h = 0` o Jacobiano é `J = (1−α)I + α·(W⊙M)ᵀ`. Com `ρ(J) < 1` a rede tende a um ponto fixo. Bem acima de 1, podem surgir ciclos-limite ou caos. Isso é uma **heurística** de linearização: a saturação do `tanh` pode estabilizar mesmo com ρ > 1. Por isso a estabilidade também é medida empiricamente.

#### 2.3 Ciclo de execução

```
repita (enquanto RUN ativa):
  A – consolidação: treinar T_w passos (BPTT-K, clipping)
  B – mutação (estado GROW):
     op ← banco.sortear(); base ← snapshot()
     controle: treinar T_a passos sem mutação      → L_ctl (val_sel)
     restaurar(base); aplicar op; treinar T_a passos → L_mut (mesmos batches)
     score = (L_ctl − L_mut)/L_ctl − λ_c·Δcomplexidade
     aceitar se score > δ, senão ficar com o ramo controle
     banco.atualizar(op, max(0, score))
  C – parada: GL/PQ/UP em val_stop
  D – sonda dinâmica a cada N ciclos; log
```

O ponto central, que é sugestão minha, é **comparar contra um controle que também treinou T_a passos**. Sem isso, qualquer mutação parece ajudar, porque a rede continuaria melhorando de qualquer jeito.

#### 2.4 Banco de operações

| Operação | Efeito | Inicialização |
|---|---|---|
| `addNeuron` | Liga um slot com entrada de 1 neurônio e de 1 feature, e saída para o readout ou para outro neurônio | Entrada aleatória; saída = 0 |
| `addConn` | Cria `i→j` (inclui autoconexão e ciclos) | Peso = 0 |
| `removeConn` | Remove a conexão de menor \|w\| | — |
| `rewire` | Move o destino `i→j` para `i→k` | Peso novo = 0 |
| `pruneNeuron` | Desliga o neurônio de menor contribuição por ablação | — |
| `changeLeak` | α × 0,8 ou × 1,25 | — |
| `splitNeuron` (v0.5) | Duplica um neurônio (Net2Net) | Copia as entradas; divide as saídas por 2 |

*Adaptive pursuit* (Thierens, 2005):

```
Q_op ← (1−a)·Q_op + a·recompensa          (a ≈ 0.3: memória curta)
P_best ← P_best + β·(P_max − P_best),  P_max = 1 − (K−1)·P_min
P_outros ← P_outros + β·(P_min − P_outros) (P_min ≈ 0.05, β ≈ 0.3)
```

`P_min > 0` garante que nenhuma operação some de vez. Isso importa porque a operação útil muda com a fase: `addNeuron` tende a ganhar no começo, e `removeConn`/`pruneNeuron` depois. Como a recompensa não é estacionária, UCB com janela deslizante é uma alternativa melhor que UCB puro.

#### 2.5 Overfitting e parada autônoma

Use **treino**, **val_sel** (para aceitar mutações), **val_stop** (para parar) e um teste que só é aberto no fim. O mecanismo de aceitação faz milhares de escolhas com base em val_sel e acaba sobreajustado a ele. A evolução regularizada de Real et al. nasceu do mesmo problema: com envelhecimento, só sobrevivem arquiteturas que "retreinam bem".

Critérios de Prechelt (janela k = 5):
- `GL(t) = 100·(E_va(t)/E_opt(t) − 1)`. Para quando `GL > α`.
- `P_k(t) = 1000·(Σ E_tr/(k·min E_tr) − 1)`. PQ para quando `GL/P_k > α`, e serve quando o overfitting é leve.
- `UP_s`: para quando a validação sobe em `s` janelas seguidas.

```
GROW ──(PQ OU 30 rejeições seguidas)──► CONSOLIDATE
CONSOLIDATE ──(GL OU UP OU paciência)──► OBSERVE (restaura o melhor snapshot)
OBSERVE: sem treino; só roda a dinâmica e mede, até o usuário parar
```

"Parar sozinha" quer dizer parar de **aprender**. A RUN continua viva. A pressão de parcimônia soma `λ_c·(Δconexões + 3·Δneurônios)` ao critério e aplica L1 leve em W. É a lógica de AIC/BIC/MDL: cada parâmetro precisa pagar a si mesmo. Os valores de λ são hipóteses.

#### 2.6 RUN contínua e controle de oscilação

Em OBSERVE, a rede roda `T_obs` ≈ 200 ticks sobre uma sonda fixa. A oscilação é contida por três mecanismos:
1. A perda de suavidade `λ_s·‖y_K − y_{K−1}‖²`.
2. Vazamento e `tanh`.
3. Um "termostato espectral" (sugestão minha): se `ρ̂ > 0,95`, escalar `W⊙M` por `0,95/ρ̂`, como na normalização padrão das ESNs.

### 3. Construção passo a passo em TensorFlow.js

#### 3.1 Setup

```bash
mkdir rede-evolutiva && cd rede-evolutiva && npm init -y
npm i @tensorflow/tfjs-node@4.22.0   # backend nativo 'tensorflow'
# navegador: npm i @tensorflow/tfjs@4.22.0 @tensorflow/tfjs-vis
```

Adicione `"type": "module"` ao `package.json`. Arquivos: `src/tf.js`, `rng.js`, `graph.js`, `train.js`, `ops.js`, `bank.js`, `stopping.js`, `probe.js`, `runner.js`, `tasks.js`, `main.js`.

Armadilhas da API 4.22.0, verificadas na documentação e no código-fonte:
- `tf.variableGrads` retorna `{value, grads}` (e não `val`), com `grads` indexado pelo nome da variável. Esse mapa pode ir direto para `optimizer.applyGradients`.
- `tf.oneHot` devolve int32: use `.toFloat()`.
- `tf.losses.softmaxCrossEntropy(labels, logits)` recebe os rótulos primeiro e logits crus.
- `tf.util.shuffle` não aceita seed. Em `randomNormal`/`randomUniform` a seed é o 5º argumento, e em `randomUniform` seed 0 significa aleatório.
- `tf.memory().unreliable` pode vir `true` no Node.
- `tf.io.fileSystem` só existe no tfjs-node.
- `tf.tidy` exige uma função síncrona.

#### 3.2 `tf.js` e `rng.js`

```js
// src/tf.js — no navegador troque por '@tensorflow/tfjs'
import * as tf from '@tensorflow/tfjs-node';
export default tf;
```

```js
// src/rng.js — PRNG determinístico (mulberry32)
export function makeRng(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0; let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
```

#### 3.3 `graph.js`: o grafo sem camadas

```js
import tf from './tf.js';

export class Graph {
  constructor({ nIn, nOut, capacity = 64, leak = 0.5, ticks = 6, seed = 1 }) {
    Object.assign(this, { nIn, nOut, cap: capacity, leak, ticks });
    this.alive = new Uint8Array(capacity);
    this.mRec = new Float32Array(capacity * capacity);   // linha = origem
    this.mIn = new Float32Array(nIn * capacity);
    this.mOut = new Float32Array(capacity * nOut);
    this.alive[0] = 1;                                    // começa com UM neurônio
    for (let i = 0; i < nIn; i++) this.mIn[i * capacity] = 1;
    for (let c = 0; c < nOut; c++) this.mOut[c] = 1;
    const rn = (shape, s) => tf.randomNormal(shape, 0, s, 'float32', seed++);
    this.W = tf.variable(rn([capacity, capacity], 0.1));  // nomes automáticos (únicos)
    this.Win = tf.variable(rn([nIn, capacity], 0.5));
    this.b = tf.variable(tf.zeros([capacity]));
    this.Wout = tf.variable(rn([capacity, nOut], 0.5));
    this.bout = tf.variable(tf.zeros([nOut]));
    this.syncMasks();
  }
  vars() { return [this.W, this.Win, this.b, this.Wout, this.bout]; }

  syncMasks() {                                           // chamar após toda mutação
    tf.dispose([this.MR, this.MI, this.MO, this.A].filter(Boolean));
    this.MR = tf.tensor2d(this.mRec, [this.cap, this.cap]);
    this.MI = tf.tensor2d(this.mIn, [this.nIn, this.cap]);
    this.MO = tf.tensor2d(this.mOut, [this.cap, this.nOut]);
    this.A = tf.tensor1d(Float32Array.from(this.alive));
  }
  step(h, drive, Wm) {                                    // um tick
    const pre = h.matMul(Wm).add(drive);
    return h.mul(1 - this.leak).add(tf.tanh(pre).mul(this.leak)).mul(this.A);
  }
  forward(x, ticks = this.ticks) {                        // x:[B,nIn]
    const Wm = this.W.mul(this.MR), Wo = this.Wout.mul(this.MO);
    const drive = x.matMul(this.Win.mul(this.MI)).add(this.b);
    let h = tf.zeros([x.shape[0], this.cap]); const traj = [];
    for (let t = 0; t < ticks; t++) { h = this.step(h, drive, Wm); traj.push(h.matMul(Wo).add(this.bout)); }
    return { logits: traj[traj.length - 1], traj, h };
  }
  forwardSeq(xSeq, k = 2) {                               // xSeq:[B,T,nIn]
    const Wm = this.W.mul(this.MR), Wo = this.Wout.mul(this.MO), Wi = this.Win.mul(this.MI);
    let h = tf.zeros([xSeq.shape[0], this.cap]); const traj = [];
    for (const xt of tf.unstack(xSeq, 1)) {
      const drive = xt.matMul(Wi).add(this.b);
      for (let t = 0; t < k; t++) { h = this.step(h, drive, Wm); traj.push(h.matMul(Wo).add(this.bout)); }
    }
    return { logits: traj[traj.length - 1], traj, h };
  }
  editVar(v, fn) {                                        // edição pontual O(N²)
    const arr = v.dataSync().slice(); fn(arr);
    tf.tidy(() => v.assign(tf.tensor(arr, v.shape)));
  }
  aliveIdx() { const r = []; this.alive.forEach((a, i) => a && r.push(i)); return r; }
  nNeurons() { return this.aliveIdx().length; }
  nConns() { let s = 0; for (const m of [this.mRec, this.mIn, this.mOut]) for (const v of m) s += v; return s; }
  snapshot() {
    return { masks: [this.alive, this.mRec, this.mIn, this.mOut].map(a => a.slice()),
             leak: this.leak, vals: this.vars().map(v => tf.keep(v.clone())) };
  }
  restore(s) {
    [this.alive, this.mRec, this.mIn, this.mOut] = s.masks.map(a => a.slice());
    this.leak = s.leak; this.vars().forEach((v, i) => v.assign(s.vals[i])); this.syncMasks();
  }
  toJSON() {
    return { config: { nIn: this.nIn, nOut: this.nOut, cap: this.cap, leak: this.leak, ticks: this.ticks },
             masks: { alive: [...this.alive], mRec: [...this.mRec], mIn: [...this.mIn], mOut: [...this.mOut] },
             weights: this.vars().map(v => ({ shape: v.shape, data: [...v.dataSync()] })) };
  }
}
```

**Por que capacidade pré-alocada.** Realocar a cada neurônio obrigaria a recriar variáveis e resetar o Adam. Com máscara, crescer é trocar um bit, e o custo por tick fica constante em O(B·C²), o que é trivial para C = 128. Quando os slots acabarem, amplie a capacidade com `tf.pad(v, [[0,d],[0,d]])` e novas `tf.variable`, preservando os pesos, e recrie o otimizador. Para carregar um modelo, faça o inverso de `toJSON`: construa o `Graph`, copie as máscaras e use `v.assign(tf.tensor(data, shape))`. O formato `LayersModel` do `tf.io` pressupõe camadas, por isso o JSON próprio é a opção mais simples. Acima de alguns milhares de neurônios, passe para uma lista de arestas (`tf.gather` + `tf.unsortedSegmentSum`).

#### 3.4 `train.js`: perda, clipping global, avaliação

```js
import tf from './tf.js';

export function lossFn(g, x, yOH, { lSmooth = 0.01, lL1 = 1e-4, seq = false } = {}) {
  const { logits, traj } = seq ? g.forwardSeq(x) : g.forward(x);
  const ce = tf.losses.softmaxCrossEntropy(yOH, logits);
  const n = traj.length;
  const smooth = traj[n - 1].sub(traj[n - 2] ?? traj[n - 1]).square().mean(); // resposta ainda mudando
  const l1 = g.W.mul(g.MR).abs().sum();                                       // parcimônia
  return ce.add(smooth.mul(lSmooth)).add(l1.mul(lL1));
}

export function trainStep(g, opt, x, yOH, { clip = 1.0, ...lo } = {}) {
  return tf.tidy(() => {
    const { value, grads } = tf.variableGrads(() => lossFn(g, x, yOH, lo), g.vars());
    const keys = Object.keys(grads);
    const gn = tf.sqrt(tf.addN(keys.map(k => grads[k].square().sum())));   // norma global
    const scale = tf.minimum(tf.scalar(1), tf.scalar(clip).div(gn.add(1e-8)));
    const clipped = {}; for (const k of keys) clipped[k] = grads[k].mul(scale);
    opt.applyGradients(clipped);
    return { loss: value.dataSync()[0], gradNorm: gn.dataSync()[0] };
  });
}

export function evaluate(g, x, yIdx, seq = false) {
  return tf.tidy(() => {
    const { logits } = seq ? g.forwardSeq(x) : g.forward(x);
    const yOH = tf.oneHot(yIdx, g.nOut).toFloat();
    return { loss: tf.losses.softmaxCrossEntropy(yOH, logits).dataSync()[0],
             acc: logits.argMax(1).equal(yIdx).toFloat().mean().dataSync()[0] };
  });
}
export const makeOpt = (lr = 0.01) => tf.train.adam(lr);
```

Depois de restaurar um snapshot, os momentos do Adam pertencem ao ramo descartado. O mais simples é recriar o otimizador após cada decisão estrutural.

#### 3.5 `ops.js`: mutações

```js
const pick = (arr, rng) => arr[Math.floor(rng() * arr.length)];

export const OPS = {
  addNeuron(g, rng) {
    const j = g.alive.indexOf(0); if (j < 0) return false;
    const src = pick(g.aliveIdx(), rng);
    g.alive[j] = 1; g.mRec[src * g.cap + j] = 1;
    g.mIn[Math.floor(rng() * g.nIn) * g.cap + j] = 1;
    g.editVar(g.W, a => { a[src * g.cap + j] = rng() - 0.5; });
    if (rng() < 0.5) {                                   // saída para o readout...
      const c = Math.floor(rng() * g.nOut);
      g.mOut[j * g.nOut + c] = 1; g.editVar(g.Wout, a => { a[j * g.nOut + c] = 0; });
    } else {                                             // ...ou para um neurônio (pode fechar ciclo)
      const dst = pick(g.aliveIdx(), rng);
      g.mRec[j * g.cap + dst] = 1; g.editVar(g.W, a => { a[j * g.cap + dst] = 0; });
    }
    return true;
  },
  addConn(g, rng) {
    const al = g.aliveIdx(), i = pick(al, rng), j = pick(al, rng);
    if (g.mRec[i * g.cap + j]) return false;
    g.mRec[i * g.cap + j] = 1; g.editVar(g.W, a => { a[i * g.cap + j] = 0; }); return true;
  },
  removeConn(g) {
    const w = g.W.dataSync(); let best = -1, bw = Infinity;
    g.mRec.forEach((m, k) => { if (m && Math.abs(w[k]) < bw) { bw = Math.abs(w[k]); best = k; } });
    if (best < 0) return false; g.mRec[best] = 0; return true;
  },
  rewire(g, rng) {
    const act = []; g.mRec.forEach((m, k) => m && act.push(k)); if (!act.length) return false;
    const k = pick(act, rng), i = Math.floor(k / g.cap), nj = pick(g.aliveIdx(), rng);
    if (g.mRec[i * g.cap + nj]) return false;
    g.mRec[k] = 0; g.mRec[i * g.cap + nj] = 1; g.editVar(g.W, a => { a[i * g.cap + nj] = 0; }); return true;
  },
  pruneNeuron(g, rng, ctx) {
    const al = g.aliveIdx().filter(i => i !== 0); if (!al.length || !ctx?.contrib) return false;
    const worst = al.reduce((a, b) => (ctx.contrib[a] < ctx.contrib[b] ? a : b));
    g.alive[worst] = 0;
    for (let k = 0; k < g.cap; k++) { g.mRec[worst * g.cap + k] = 0; g.mRec[k * g.cap + worst] = 0; }
    return true;
  },
  changeLeak(g, rng) { g.leak = Math.min(1, Math.max(0.05, g.leak * (rng() < 0.5 ? 0.8 : 1.25))); return true; },
};
```

#### 3.6 `bank.js`: banco de métodos adaptativo

```js
export class OperatorBank {
  constructor(names, { pMin = 0.05, a = 0.3, beta = 0.3 } = {}) {
    Object.assign(this, { names, pMin, a, beta });
    this.p = Object.fromEntries(names.map(n => [n, 1 / names.length]));  // começa uniforme
    this.q = Object.fromEntries(names.map(n => [n, 0]));
    this.stats = Object.fromEntries(names.map(n => [n, { tries: 0, accepts: 0, sumReward: 0 }]));
  }
  pick(rng) { let r = rng(); for (const n of this.names) { r -= this.p[n]; if (r <= 0) return n; } return this.names.at(-1); }
  update(name, reward, accepted) {
    const s = this.stats[name]; s.tries++; s.sumReward += reward; if (accepted) s.accepts++;
    this.q[name] = (1 - this.a) * this.q[name] + this.a * reward;
    const best = this.names.reduce((x, y) => (this.q[x] >= this.q[y] ? x : y));
    const pMax = 1 - (this.names.length - 1) * this.pMin;
    for (const n of this.names) this.p[n] += this.beta * ((n === best ? pMax : this.pMin) - this.p[n]);
  }
}
```

#### 3.7 `stopping.js`: Prechelt + máquina de estados

```js
export class StopController {
  constructor({ glAlpha = 5, pqAlpha = 0.75, upS = 4, k = 5, patience = 20, maxRejects = 30 } = {}) {
    Object.assign(this, { glAlpha, pqAlpha, upS, k, patience, maxRejects });
    this.state = 'GROW'; this.best = Infinity; this.bestEpoch = 0;
    this.trHist = []; this.vaStrips = []; this.rejects = 0; this.epoch = 0;
  }
  observe({ trainLoss, valStopLoss, accepted }) {
    this.epoch++; this.trHist.push(trainLoss);
    if (accepted === false) this.rejects++; else if (accepted) this.rejects = 0;
    const bestNow = valStopLoss < this.best;
    if (bestNow) { this.best = valStopLoss; this.bestEpoch = this.epoch; }
    const GL = 100 * (valStopLoss / this.best - 1);
    const win = this.trHist.slice(-this.k);
    const Pk = 1000 * (win.reduce((a, b) => a + b, 0) / (win.length * Math.min(...win)) - 1);
    const PQ = GL / Math.max(Pk, 1e-6);
    if (this.epoch % this.k === 0) this.vaStrips.push(valStopLoss);
    const s = this.vaStrips.slice(-(this.upS + 1));
    const UP = s.length > this.upS && s.every((v, i) => i === 0 || v > s[i - 1]);
    const stale = this.epoch - this.bestEpoch > this.patience;
    let changed = false;
    if (this.state === 'GROW' && (PQ > this.pqAlpha || this.rejects >= this.maxRejects)) { this.state = 'CONSOLIDATE'; changed = true; }
    else if (this.state === 'CONSOLIDATE' && (GL > this.glAlpha || UP || stale)) { this.state = 'OBSERVE'; changed = true; }
    return { GL, PQ, UP, stale, state: this.state, changed, bestNow };
  }
}
```

#### 3.8 `probe.js`: oscilação, Lyapunov, raio espectral, contribuição

```js
import tf from './tf.js';

export function dynamicsProbe(g, xProbe, { T = 200, win = 50, eps = 1e-3 } = {}) {
  return tf.tidy(() => {
    const { traj } = g.forward(xProbe, T);
    const probs = tf.stack(traj.map(l => tf.softmax(l)));             // [T,B,K]
    const tail = probs.slice([T - win, 0, 0], [win, -1, -1]);
    const amp = tail.max(0).sub(tail.min(0)).max(-1).mean().dataSync()[0];
    const cls = tail.argMax(-1).arraySync();
    let flips = 0; for (let t = 1; t < win; t++) cls[t].forEach((c, b) => { if (c !== cls[t - 1][b]) flips++; });
    const d = probs.slice([1, 0, 0]).sub(probs.slice([0, 0, 0], [T - 1, -1, -1])).abs().max([1, 2]).arraySync();
    let settle = 1; for (let t = d.length - 1; t >= 0; t--) if (d[t] >= 0.01) { settle = t + 2; break; }
    // Lyapunov máximo (Benettin): duas trajetórias com renormalização
    const Wm = g.W.mul(g.MR), drive = xProbe.matMul(g.Win.mul(g.MI)).add(g.b);
    let h = tf.zeros([xProbe.shape[0], g.cap]);
    for (let t = 0; t < 100; t++) h = g.step(h, drive, Wm);
    let hp = h.add(tf.randomNormal(h.shape, 0, eps, 'float32', 7).mul(g.A)), sumLog = 0;
    for (let t = 0; t < 100; t++) {
      h = g.step(h, drive, Wm); hp = g.step(hp, drive, Wm);
      const diff = hp.sub(h), dist = diff.norm().dataSync()[0] + 1e-12;
      sumLog += Math.log(dist / eps); hp = h.add(diff.mul(eps / dist));
    }
    return { amp, flipRate: flips / ((win - 1) * xProbe.shape[0]), settleTick: settle,
             lyapunov: sumLog / 100, rho: spectralRadius(g) };
  });
}

// ρ(J) por ‖J^k v‖^(1/k) (Gelfand) — funciona com autovalores complexos; não há eig no tfjs
export function spectralRadius(g, k = 60) {
  return tf.tidy(() => {
    const Wm = g.W.mul(g.MR);
    let v = tf.randomNormal([1, g.cap], 0, 1, 'float32', 3).mul(g.A); v = v.div(v.norm());
    let lg = 0;
    for (let i = 0; i < k; i++) {
      v = v.mul(1 - g.leak).add(v.matMul(Wm).mul(g.leak)).mul(g.A);
      const n = v.norm().dataSync()[0] + 1e-20; lg += Math.log(n); v = v.div(n);
    }
    return Math.exp(lg / k);
  });
}

export function neuronContrib(g, x, yIdx, evaluate) {   // Δ perda ao desligar cada neurônio
  const base = evaluate(g, x, yIdx).loss, contrib = {};
  for (const i of g.aliveIdx()) { g.alive[i] = 0; g.syncMasks(); contrib[i] = evaluate(g, x, yIdx).loss - base; g.alive[i] = 1; }
  g.syncMasks(); return contrib;
}
```

Para o baseline de reservatório, a ridge regression não tem `solve` no tfjs. Treine o readout com Adam + L2 (o problema é convexo) ou implemente Cholesky em JS.

#### 3.9 `runner.js`: RUN contínua com start/stop

```js
import fs from 'node:fs';
import tf from './tf.js';
import { trainStep, evaluate, makeOpt } from './train.js';
import { OPS } from './ops.js';
import { OperatorBank } from './bank.js';
import { StopController } from './stopping.js';
import { dynamicsProbe, neuronContrib } from './probe.js';
import { makeRng } from './rng.js';

const free = s => tf.dispose(s.vals);
const yieldLoop = () => new Promise(r => setImmediate(r));    // navegador: tf.nextFrame()

export class Runner {
  constructor(g, data, cfg = {}) {
    this.g = g; this.d = data;   // {xTr,yTr,xSel,ySel,xStop,yStop,xProbe}; y = índices int32
    this.cfg = { lr: 0.01, Tw: 50, Ta: 30, batch: 64, delta: 0.002, lamC: 0.0005, probeEvery: 5, seed: 1, log: 'run.jsonl', ...cfg };
    this.rng = makeRng(this.cfg.seed); this.bank = new OperatorBank(Object.keys(OPS));
    this.stop = new StopController(); this.opt = makeOpt(this.cfg.lr);
    this.running = false; this.cycle = 0; this.bestSnap = null; this.lineage = [];
  }
  start() { if (!this.running) { this.running = true; this.loop(); } }
  stopRun() { this.running = false; }
  resetOpt() { this.opt.dispose(); this.opt = makeOpt(this.cfg.lr); }
  train(steps, offset) {                           // batches determinísticos → pareamento
    let last = 0; const n = this.d.xTr.shape[0], B = Math.min(this.cfg.batch, n);
    for (let s = 0; s < steps; s++) {
      const r = makeRng(1000 + offset + s);
      const idx = tf.tensor1d(Array.from({ length: B }, () => Math.floor(r() * n)), 'int32');
      const x = tf.gather(this.d.xTr, idx), y = tf.oneHot(tf.gather(this.d.yTr, idx), this.g.nOut).toFloat();
      last = trainStep(this.g, this.opt, x, y).loss; tf.dispose([idx, x, y]);
    }
    return last;
  }
  mutationTrial() {
    const g = this.g, name = this.bank.pick(this.rng), off = this.cycle * 1000;
    const base = g.snapshot(), c0 = g.nNeurons() + g.nConns();
    this.train(this.cfg.Ta, off);                                  // ramo CONTROLE
    const Lctl = evaluate(g, this.d.xSel, this.d.ySel).loss, ctl = g.snapshot();
    g.restore(base); this.resetOpt();
    const ctx = name === 'pruneNeuron' ? { contrib: neuronContrib(g, this.d.xSel, this.d.ySel, evaluate) } : null;
    const ok = OPS[name](g, this.rng, ctx); g.syncMasks();
    let accepted = false, score = 0, Lmut = Lctl;
    if (ok) {
      this.train(this.cfg.Ta, off);                                // ramo MUTADO, mesmos batches
      Lmut = evaluate(g, this.d.xSel, this.d.ySel).loss;
      score = (Lctl - Lmut) / Math.max(Lctl, 1e-8) - this.cfg.lamC * (g.nNeurons() + g.nConns() - c0);
      accepted = score > this.cfg.delta;
    }
    if (!accepted) g.restore(ctl);
    this.resetOpt(); free(base); free(ctl);
    this.bank.update(name, Math.max(0, score), accepted);
    const ev = { cycle: this.cycle, op: name, applied: ok, accepted, score, Lctl, Lmut,
                 neurons: g.nNeurons(), conns: g.nConns(), parent: this.lineage.at(-1)?.cycle ?? null };
    if (accepted) this.lineage.push(ev);
    return ev;
  }
  async loop() {
    while (this.running) {
      const t0 = Date.now(), st = this.stop.state; let ev = null, sc = { state: st };
      if (st !== 'OBSERVE') this.train(this.cfg.Tw, this.cycle * 1000 + 500);
      if (st === 'GROW') ev = this.mutationTrial();
      const tr = evaluate(this.g, this.d.xTr, this.d.yTr), vs = evaluate(this.g, this.d.xStop, this.d.yStop);
      if (st !== 'OBSERVE') sc = this.stop.observe({ trainLoss: tr.loss, valStopLoss: vs.loss, accepted: ev?.accepted });
      if (sc.bestNow) { if (this.bestSnap) free(this.bestSnap); this.bestSnap = this.g.snapshot(); }
      if (sc.changed && sc.state === 'OBSERVE' && this.bestSnap) this.g.restore(this.bestSnap);
      const dyn = this.cycle % this.cfg.probeEvery === 0 ? dynamicsProbe(this.g, this.d.xProbe) : null;
      fs.appendFileSync(this.cfg.log, JSON.stringify({ t: Date.now(), cycle: this.cycle, state: sc.state,
        trLoss: tr.loss, trAcc: tr.acc, valLoss: vs.loss, valAcc: vs.acc, GL: sc.GL, PQ: sc.PQ, ev, dyn,
        probs: { ...this.bank.p }, neurons: this.g.nNeurons(), conns: this.g.nConns(),
        ms: Date.now() - t0, tensors: tf.memory().numTensors }) + '\n');
      this.cycle++; await yieldLoop();                            // permite stopRun()
    }
  }
}
```

#### 3.10 `tasks.js` e `main.js`

```js
// src/tasks.js
import tf from './tf.js';
import { makeRng } from './rng.js';

export function spiralsOracle(n, seed, noise = 0.1) {            // oráculo: gera quantos quiser
  const r = makeRng(seed), X = [], Y = [];
  for (let i = 0; i < n; i++) {
    const c = i % 2, t = r() * 3 * Math.PI, s = c ? -1 : 1;
    X.push([s * t * Math.cos(t) / 10 + noise * (r() - 0.5), s * t * Math.sin(t) / 10 + noise * (r() - 0.5)]); Y.push(c);
  }
  return { x: tf.tensor2d(X), y: tf.tensor1d(Y, 'int32') };
}
export function spirals() {
  const [tr, se, st, pr] = [[400, 1], [300, 2], [300, 3], [16, 4]].map(([n, s]) => spiralsOracle(n, s));
  return { nIn: 2, nOut: 2, xTr: tr.x, yTr: tr.y, xSel: se.x, ySel: se.y, xStop: st.x, yStop: st.y, xProbe: pr.x };
}
export function parityOracle(n, T, seed) {                        // memória: XOR de T bits
  const r = makeRng(seed), X = [], Y = [];
  for (let i = 0; i < n; i++) { const b = Array.from({ length: T }, () => (r() < 0.5 ? 1 : 0));
    X.push(b.map(v => [v])); Y.push(b.reduce((a, v) => a ^ v, 0)); }
  return { x: tf.tensor3d(X), y: tf.tensor1d(Y, 'int32') };
}
```

```js
// src/main.js
import tf from './tf.js';
import fs from 'node:fs';
import { Graph } from './graph.js';
import { Runner } from './runner.js';
import { spirals } from './tasks.js';

await tf.ready();
console.log('backend:', tf.getBackend());                         // tfjs-node → 'tensorflow'
const data = spirals();
const g = new Graph({ nIn: data.nIn, nOut: data.nOut, capacity: 64, seed: 42 });
const run = new Runner(g, data, { seed: 42, log: 'spirals_seed42.jsonl' });
run.start();
process.on('SIGINT', () => {                                      // Ctrl+C = usuário encerra
  run.stopRun(); fs.writeFileSync('model.json', JSON.stringify(g.toJSON()));
  console.log('neurônios:', g.nNeurons(), 'conexões:', g.nConns());
  setTimeout(() => process.exit(0), 200);
});
```

Rode com `node src/main.js` e acompanhe com `tail -f spirals_seed42.jsonl`. Para tarefas temporais, repasse `seq: true` para `lossFn`/`evaluate`. No navegador:
- troque o import e use `await tf.nextFrame()`;
- ligue botões a `start()`/`stopRun()`;
- plote com `tfvis.render.linechart`;
- desenhe o grafo com cytoscape.js a partir das máscaras (espessura = |w|, cor = sinal, nó colorido pelo ciclo de nascimento).

#### 3.11 Memória e performance

- Todo trabalho com tensores fica em `tf.tidy`. Só `snapshot()` usa `tf.keep`, e todo snapshot descartado precisa de `tf.dispose`.
- **`numTensors` crescendo no log indica vazamento.**
- Para C ≤ 256, o backend `tensorflow` na CPU é o mais simples. `webgl`/`webgpu` só compensam com batches grandes, porque cada tick pequeno é dominado por overhead, e `dataSync()` em loop força sincronização.

### 4. Plano de testes

**Tarefas em ordem de dificuldade.**
1. **XOR:** um único `tanh` com readout linear não resolve, então a rede *precisa* crescer para 2–3 neurônios.
2. **Espirais / moons / Iris:** não-linearidade com ruído. Com treino pequeno (cerca de 100 pontos), o overfitting aparece.
3. **Paridade sequencial (T = 4…10) e recordação atrasada:** justificam a recorrência. A ablação "sem recorrência" tem de falhar aqui. Se não falhar, a tarefa não está exigindo memória.
4. **Senoide / Mackey-Glass:** regressão com `tf.losses.meanSquaredError(labels, preds)`, comparável com ESNs.
5. **MNIST reduzido (14×14, 5–10 mil exemplos):** teste de escala. O objetivo não é bater uma CNN, e sim ver se o crescimento continua ordenado.

**Protocolo.**
- Use 10 seeds por configuração. Reporte mediana e intervalo interquartil de acurácia de teste, tamanho final, tempo até OBSERVE e métricas dinâmicas.
- Compare configurações com Mann-Whitney ou IC por bootstrap.
- Calibre `δ` (sugestão minha): rode cerca de 50 tentativas com uma operação nula e use `δ` perto do percentil 95 do score nulo.

**Baselines.**
- (a) MLP `tf.sequential` do mesmo tamanho, com early stopping.
- (b) ESN com W esparsa normalizada para ρ ≈ 0,9 e só o readout treinado.
- (c) Rede de capacidade máxima totalmente conectada.
- (d) NEAT puro (NeatapticTS).

**Ablações.**
- Banco adaptativo × uniforme.
- Com × sem recorrência (máscara triangular = DAG).
- Parada automática × ciclos fixos.
- Com × sem suavidade e com × sem parcimônia.
- Aceitação pareada × ingênua. A ingênua deve mostrar aceitação inflada e bloat.

**Teste WANN.** Substitua todos os pesos ativos por um valor compartilhado w ∈ {±0,5, ±1, ±2}. Se a acurácia ficar acima do acaso, a topologia em si carrega estrutura útil.

### 5. Métricas

| Métrica | Como calcular | Bom | Ruim | O que fazer |
|---|---|---|---|---|
| Perda treino × val_stop | `evaluate` por ciclo | Caem juntas | val sobe, treino cai | Confiar no GL; aumentar λ_c; mais dados do oráculo |
| GL / PQ / UP | seção 2.5 | GL < 2 em GROW | GL > 5 cedo | Reduzir `T_a`/lr; mais regularização |
| Taxa de aceitação | aceitas/tentadas (janela de 50) | 5–30%, caindo | > 50% ou 0% por muito tempo | Recalibrar `δ`; checar pareamento |
| Probabilidade por operação | `bank.p` | Muda de fase (add → prune) | Uma operação travada desde o início | Aumentar `P_min`; reduzir β |
| Neurônios / conexões | `nNeurons`, `nConns` | Cresce e estabiliza | Cresce sem ganho (bloat) | Aumentar λ_c; habilitar `prune` |
| Norma do gradiente | `gradNorm` | Clipping raro | Clipping sempre ou NaN | Reduzir lr, K ou ρ; α menor |
| Raio espectral ρ̂ | `spectralRadius` | 0,7–0,98 | > 1,05 persistente | Termostato; L1 em W |
| Amplitude pico-a-pico | `amp` (últimos 50 ticks) | < 0,01 | > 0,1 | Aumentar λ_s; reduzir ρ |
| Troca de classe | `flipRate` | ≈ 0 | > 0,01 | Idem; verificar exemplos ambíguos na sonda |
| Tempo até estabilizar | `settleTick` | ≤ 2–3× K | Nunca (= T) | K aleatório no treino; suavidade em vários ticks |
| Lyapunov | Benettin | < 0 | > 0 (caos) | Reduzir ganho e autoconexões positivas |
| Contribuição por neurônio | `neuronContrib` | Maioria > 0 | Muitos ≈ 0 | Podar |
| ms/ciclo, nº de tensores | log | Estável | Tensores crescendo | Procurar vazamento |

As faixas são pontos de partida propostos por mim, a calibrar com os baselines. As métricas devem ser lidas em conjunto. ρ̂ > 1 com Lyapunov < 0 e amplitude baixa é aceitável, porque a saturação estabiliza. ρ̂ < 1 com amplitude alta indica exemplos ambíguos na sonda ou uma região sensível.

### 6. Como entender o que evoluiu ou não

1. **Livro-razão de mutações.** Cada `ev` no JSONL é um experimento controlado. Agregue por operação (taxa de aceitação, recompensa média, fase) para ver quais métodos de crescimento funcionaram.
2. **Linhagem.** Plote `lineage` numa linha do tempo (x = ciclo, y = perda val) com marcadores por operação. Degrau para baixo após uma aceitação é evolução real. Aceitação sem degrau seguida de piora é ruído aceito.
3. **Snapshot N × N−1.** Salve `toJSON()` a cada aceitação e compare a diferença de máscaras, a perda e a trajetória na mesma sonda. Uma mutação ajudou se a melhora em val_sel **persiste em val_stop**. Se só val_sel melhora, é sobreajuste da seleção.
4. **Contribuição.** A ablação por neurônio e por aresta mostra o que carrega a solução. Em tarefas temporais, neurônios em ciclo com contribuição alta indicam que a recorrência está servindo de memória.
5. **Curvas por mutação.** Compare controle × mutado nos `T_a` passos. Um ganho que cresce ao longo do trecho sugere uma nova direção de otimização, como argumenta o GradMax. Um ganho imediato que some é sorte.
6. **Reprodutibilidade estrutural.** Motivos que reaparecem em várias seeds (autoconexões, ciclos de 2 nós) são evolução robusta.

Padrões típicos:
- Neurônios subindo com val estável é bloat.
- Aceitação alta com val oscilando é ruído sendo "aprendido".
- `addNeuron` dominando até o fim indica rede subdimensionada.
- Amplitude que cresce depois de uma mutação específica indica que ela criou um ciclo com ganho > 1. Compare ρ̂ antes e depois.

## Recommendations

**Roadmap.**
1. **MVP:** `graph.js` + `train.js`, capacidade 16, sem mutações. Valide XOR e espirais, e confira que os pesos com M = 0 não mudam.
2. **v0.2:** `addNeuron`/`addConn`/`removeConn` com aceitação pareada e probabilidades uniformes. Calibre `δ` pela distribuição nula.
3. **v0.3:** `OperatorBank`, `StopController`, três conjuntos de dados e a ablação adaptativo × uniforme.
4. **v0.4:** `probe.js`, perda de suavidade, termostato espectral, OBSERVE e start/stop.
5. **v0.5:** tarefas temporais, `splitNeuron`, `pruneNeuron`, ampliação de capacidade via `tf.pad` e visualização no navegador.
6. **v1.0:** 10 seeds, baselines, relatório automático do JSONL e MNIST reduzido.
7. **Extensões:** ativação por neurônio, constante de tempo por neurônio (estilo LTC/CfC), UCB com janela, população com envelhecimento (Real et al.) e representação esparsa.

**Decisões.**
- Gradiente para os pesos, evolução só para a estrutura.
- K entre 4 e 10 ticks, aleatório por batch a partir da v0.4.
- Peso de saída zero em toda estrutura nova.
- Com oráculo, dados novos continuamente.

**Riscos.**

| Risco | Mitigação |
|---|---|
| Bloat | λ_c, `prune`, `δ` calibrado, `maxRejects` |
| Gradientes explodindo/sumindo em ciclos | Clipping global, vazamento, `tanh`, ρ̂ < 1, K moderado |
| Custo N×N | Capacidade pequena; esparso só para C grande |
| Ruído na avaliação | Pareamento, distribuição nula, confirmação em val_stop |
| Sobreajuste a val_sel | Três conjuntos + teste intocado; população com envelhecimento |
| Vazamento de memória | `tidy`, liberar snapshots, monitorar `numTensors` |
| tfjs sem release estável desde out/2024 (issue #8609: tfjs-node 4.22.0 "broken with node 24") | Isolar o tfjs em `tf.js`; fixar uma versão LTS anterior do Node; o núcleo é JS puro |

## Caveats

- A combinação proposta não foi validada como um todo na literatura, só os componentes isolados. Os hiperparâmetros (`δ`, λ_c, λ_s, `P_min`) e as faixas de métricas são sugestões minhas.
- A estabilidade por ρ̂ é heurística. Lyapunov e amplitude medidos são os critérios decisivos.
- Os números da literatura (25× e 5× do NEAT; cerca de 4% e 4× de Prechelt; PM < AP < UCB) vêm de contextos específicos e não garantem o mesmo efeito aqui.
- Os preprints de 2025–2026 citados não foram lidos na íntegra.
- O código segue a API documentada do TensorFlow.js 4.22.0 (verificada na documentação e no código-fonte do otimizador), mas não foi executado nesta pesquisa. Escreva testes unitários para máscaras e snapshots antes de confiar nos resultados.

# auto-neural-networking

Repositório de pesquisa. A pasta [`docs/`](docs/) reúne as referências
acadêmicas do relatório de pesquisa sobre neuroevolução, crescimento de
topologias e temas correlatos, organizadas por sessão:

- [`docs/A-neuroevolucao-e-crescimento-de-redes/`](docs/A-neuroevolucao-e-crescimento-de-redes/) — NEAT e afins (24 PDFs)
- [`docs/B-redes-recorrentes-reservatorio-e-dinamica/`](docs/B-redes-recorrentes-reservatorio-e-dinamica/) — ESN/LSM/LTC/CfC (7 PDFs)
- [`docs/C-selecao-adaptativa-de-operadores/`](docs/C-selecao-adaptativa-de-operadores/) — AOS/bandits (8 PDFs)
- [`docs/D-early-stopping/`](docs/D-early-stopping/) — parada antecipada (3 PDFs)
- [`docs/E-referencias-tecnicas/`](docs/E-referencias-tecnicas/) — referências web verificadas (TF.js, neataptic, TensorNEAT)

Cada subpasta tem um `README.md` com a ficha de cada trabalho (link oficial,
DOI, status de acesso e observações). Índice completo em
[`docs/README.md`](docs/README.md); correções de citação em
[`docs/correcoes-citacoes.md`](docs/correcoes-citacoes.md).

Os PDFs podem ser rebaixados com:

```bash
bash scripts/baixar-pdfs.sh        # tudo
bash scripts/baixar-pdfs.sh C      # só uma seção
```

o manifesto de origem está em [`docs/manifest-downloads.tsv`](docs/manifest-downloads.tsv).
