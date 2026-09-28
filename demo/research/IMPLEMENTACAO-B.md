# IMPLEMENTACAO-B.md — OPÇÃO B: detetar + punir + tentar outros caminhos

Data: 2026-09-28 · Subagente B (escopo: `demo/core/evolution.mjs`, `demo/tests/unit-net.mjs`, este ficheiro).
Base: `demo/CONTRACTS.md` (EMENDA v6/v7), `demo/TRAVAS.md`, research `06/07/08/09` (fórmulas) e `11` (verificação).

## 1. O que mudou por ficheiro

### `demo/core/evolution.mjs` (runEpisode/fitnessOf + auxiliares novos)

**Constantes exatas (research 07/08/09)** — exportadas para auditoria/testes:
`REV_C=0.005`, `REV_RHO=1.6`, `REV_KAPPA=8`, `P_MAX=0.25`, `PAIR_H=0.002`, `PAIR_CAP=4`,
`CYCLE_P0=0.02`, `CYCLE_LAP_CAP=8`, `CYCLE_EXIT_REPEATS=4`, `BREAK_STEPS=8`,
`HYST_MARGIN=0.08`, `NOVELTY_ALPHA=0.005`, `BONUS_CAP=0.25`, `SOLVED_FLOOR=1.25`,
`UNSOLVED_CAP=1.2`, `BUMP_PENALTY=-0.04`.

1. **Deteção de ciclos (research 06)** — por episódio: `lastSeen = Int32Array(cols*rows*4)`
   + `keyTrace = Int32Array(maxSteps+1)`; chave `key_t = maze.idx(x,y)*4 + dir` (dir = ação
   tomada; o traço regista TODOS os passos, inclusive bumps). Repetição da chave com gap `p`
   ⇒ verificação do período completo contra os `p` pares anteriores (`verifyPeriod`):
   `for i=1..p: keyTrace[t-i] === keyTrace[t0-i]` (índices antes do início do traço são
   ignorados — ver §4 "tensões"). Confirmado ⇒ `cycleLen = p`, `repeats++`.
   **Anti-aliasing (06-E)**: 2.º detetor com `sigKey = hash(quantSig(buf))*4 + dir` sobre a
   assinatura dos 12 sensores quantizada a **4 bits/valor** (FNV-1a de 32 bits, `quantSig`)
   + ação; se a assinatura ciclar e o par (célula,ação) NÃO tiver ainda ciclado, conta como
   ciclo ALIADO (`aliased: true`) com a mesma escada de penalidade.
2. **Punições (research 07, fórmulas exatas)**:
   - Revisita marginal escalonada: `revisitCharge(n) = -0.005*min(1.6^(n-2), 8)` para a
     n-ésima visita (n ≥ 2), **em substituição** do −0.005 plano. Acumulador de revisita +
     bump + reversões com **tecto duro −0.25** (`P_MAX`).
   - **Isenção Trémaux (08/07-2.4)**: inversão imediata (`dir === prevDir ^ 1`; pares opostos
     da ordem canónica 0↔1, 2↔3 — ver §4) que entra em célula visitada UMA vez (`nPrior===1`)
     ou sai de região toda ≥2× visitada (`leavingAllTwice`) **custa 0**. Reincidência por par
     ORDENADO de células: 1.ª inversão gratuita; seguintes `0.002*min(m,4)` com m = n.º da
     inversão do par (cap 4×). A isenção aplica-se à 1.ª inversão de cada par; inversões
     posteriores no mesmo par pagam SEMPRE (a oscilação nunca é backtracking legítimo).
   - `BUMP_PENALTY = -0.04` (era −0.005): a batida em parede custa mais do que qualquer
     revisita não saturada e do que qualquer carga de reversão (0.008) — ver §4 sobre o
     empate com o piso saturado −0.04.
   - **Volta confirmada r**: `penaltyCycle -= 0.02*min(2^(r-1), 8)*cycleLen` (custo; SEM
     tecto, à parte do acumulador de revisita). **`repeats >= 4` ⇒ fim antecipado** do
     episódio como NÃO resolvido (`looped: true, cycleLen, repeats`; endDist medido na
     posição de rutura).
3. **Guarda lexicográfica (07-2.5)**: `fitnessOf` clampa o ramo resolvido a **≥ 1.25** e o
   não resolvido a **≤ 1.2**; `runEpisode` re-aplica o piso 1.25 à composição FINAL
   (base + penalty + penaltyCycle) para a guarda valer mesmo com penalidades de ciclo acima
   do tecto. Assim: `qualquer solved ≥ 1.25 > qualquer unsolved ≤ 1.2`, sempre.
4. **Bónus de novidade (07-2.3)**: por ENTRADA em célula com contagem prévia n ≥ 0,
   `bonus += 0.005/sqrt(n+1)` (a 1.ª entrada paga α = 0.005 = α/√1; forma fechada literal de
   07 §2.3 "a primeira visita paga α, a segunda α/√2"), total clampado a **+0.25**.
   **Escolha documentada (pedida no item 4)**: o bónus entra com coeficiente 1 nos DOIS
   ramos de `fitnessOf`, SUBSTITUINDO o termo linear de cobertura `0.25/0.5*visited/openCells`
   (o termo 0.5 do ramo solved era o alvo de "farm de cobertura" da research 07 §1.6c).
   Compatibilidade: quando `bonus` é OMITIDO, `fitnessOf` mantém a fórmula LEGADA de
   cobertura — é o que mantém `tests/validate.mjs` (ficheiro de OUTRO domínio, não editável
   por este subagente) a passar sem alterações nos seus spot-checks exatos.
5. **Quebra ativa de ciclos (research 09-B)**: na deteção, `k = 8` passos forçando a
   **2.ª melhor** direção da rede; se for parede, as restantes por ordem decrescente de
   saída; proibida a reentrada na célula que iniciou o ciclo (`forbiddenCell`). Re-armada a
   cada confirmação.
6. **Histerese anti-período-2 (research 09-D)**: para trocar da ação anterior para a melhor,
   a saída da melhor tem de superar a da anterior por uma margem de **8% do intervalo das
   saídas (max−min)**; senão mantém-se a ação anterior — **exceto se essa colidir** (aí a
   histerese é saltada).
7. **API estável + telemetria aditiva**: `runEpisode` mantém `{solved, steps, path, fitness,
   sensorTrace}` e acrescenta `looped, cycleLen, repeats, aliased, cycleDetectStep, penalty,
   penaltyCycle, bonus, revisits, bumps, reversals, visitedCells, actionTrace`. Novos opts
   (aditivos): `antiLoop: false` = modo LEGADO de controlo (penalidades planas −0.005,
   sem deteção/histerese/quebra/bónus) e `policy(yOut, ctx)` = gancho de testes/diagnóstico
   que substitui a seleção de ação (permite trajetórias sintéticas determinísticas).
   Novas exportações: `revisitCharge`, `pickDir`, `quantSig`, `verifyPeriod` + constantes.

### `demo/tests/unit-net.mjs`

- **Assertões legitimamente alteradas pelas fórmulas novas** (as ÚNICAS alteradas em testes
  existentes): no spot-check de `fitnessOf`, dois valores não resolvidos que davam
  1.6586 e 1.5025 passam a **1.2** (clamp da guarda lexicográfica) — os restantes
  valores (solved 2.657, stuck, deg, e o ramo solved) mantêm-se EXATOS; e a reconstrução
  exata do `E15: runEpisode usa distâncias BFS` foi reescrita como (a) valor exato num passo
  com bónus α=0.005 e discriminante BFS-vs-Manhattan e (b) decomposição exata
  `fitness == guarda(fitnessOf(bónus) + penalty + penaltyCycle)`.
- **Novos checks (OPÇÃO B)**: saturação de `p(n)`; detetor ABAB em ≤ 3 passos + caminho BFS
  limpo sem falso positivo; Trémaux (1.ª devolução de beco = penalty **exatamente 0**;
  oscilação significativamente mais cara); saída antecipada em `repeats ≥ 4` com
  `penaltyCycle = −0.02·(1+2+4+8)·cycleLen`; histerese (`pickDir`: mantém/troca/salta em
  colisão/quebra ativa com 2.ª melhor e célula proibida); guarda lexicográfica em
  `runEpisode` (25 seeds × 4 configs); anti-aliasing (`quantSig` 4 bits, campo `aliased`);
  modo legado `antiLoop: false`.

## 2. Verificação (research 11; TRAVAS.md: `timeout` em tudo, máx. 2 probes)

### 2.1 Testes unitários (`timeout 600 node demo/tests/unit-net.mjs`) — 67/67 PASS

Cauda relevante (todos os checks novos + os de aprendizagem pré-existentes):

```
  PASS  OPÇÃO B: fitnessOf — bónus de novidade substitui cobertura + guarda lexicográfica
  PASS  OPÇÃO B: revisita escalonada p(n) — saturação em 8× e primeira visita grátis
  PASS  OPÇÃO B: detetor — ABAB período 2 detetado em ≤ 3 passos; caminho BFS limpo sem falso positivo
  PASS  OPÇÃO B: Trémaux — 1.ª devolução de beco gratuita; oscilação cara
  PASS  OPÇÃO B: saída antecipada em repeats ≥ 4 (looped, cycleLen, repeats)
  PASS  OPÇÃO B: histerese anti-período-2 — margem de 8% do intervalo das saídas
  PASS  OPÇÃO B: guarda lexicográfica no runEpisode (solved ≥ 1.25 > unsolved ≤ 1.2)
  PASS  OPÇÃO B: anti-aliasing — quantização 4 bits + campo aliased (plumbing)
  PASS  OPÇÃO B: antiLoop:false = modo legado (plano, sem deteção/histerese)
  PASS  evolve 5×5 (config integração): resolve (best ≥ 1.2) e aprende (mean sobe)
  PASS  evolve 7×7 (config integração): best da última > best da 1ª
  PASS  E17: curriculum — 5×5 resolvido ⇒ promoção a 7×7 mantendo população e banco + burst
67 passed, 0 failed
```

Números-chave dos sintéticos: ABAB confirmado no **passo 3** (cycleLen 2; fim antecipado no
passo 6 com repeats=4 e `penaltyCycle = −0.6 = −0.02·(1+2+4+8)·2`); devolução de beco
`penalty === 0` exato; caminho BFS limpo `penalty === 0`, `repeats === 0`, `looped === false`.
A aprendizagem NÃO degradou: `evolve 5×5` passa (best 2.43→3.15), `7×7` passa (mean
0.91→2.77) e o curriculum **promove 5×5→7×7** dentro do orçamento (o mecanismo anti-loop
não destruiu a convergência — era o maior risco).

### 2.2 Testes existentes

- `demo/tests/validate.mjs` (NÃO editado, domínio integração): **28/28 PASS**, incluindo os
  spot-checks exatos de `fitnessOf` (2.475 e 1.055 — intactos pela compatibilidade §4.1) e a
  aprendizagem 5×5/7×7. Performance: **2 098 790 ticks/s** e **20 314 episódios/s** (5×5) —
  o detetor não paga overhead mensurável face ao piso de 50 ép/s.
- `demo/tests/unit-net.mjs` (existente): tudo verde; ÚNICAS assertões alteradas as duas
  descritas em §1 (clamps 1.2 legitimamente impostos pela fórmula nova).

### 2.3 Probe A/B (UMA execução, `timeout 600`, saída parcial por linha)

Desenho: 3 tamanhos (5×5, 15×15, 31×31) × 8 labirintos (seeds 100,107,...) × 3 seeds de
agentes aleatórios CONGELADOS (makeNetwork, sem treino); cada episódio corre nos DOIS
braços — `antiLoop: true` (OPÇÃO B: histerese + quebra + fim antecipado + punições) vs
`antiLoop: false` (legado: argmax puro, penalidades planas) — `maxSteps = 2·cols·rows`.
**31×31 coube inteiro no timeout** (probe terminou bem abaixo dos 600 s; n=24 episódios
por tamanho×braço). Métricas (research 11): revisita = (T − C_dist)/T (M2); ciclos/episódio
= eventos de período k∈[2,8] sobre (célula,ação) com sobreposições fundidas (M4);
reversões = ARR (M3); cobertura = C_dist/openCells (M1); SPL (M5); sucesso (S).

| tamanho | métrica | ON (OPÇÃO B) | OFF (legado) | Δ |
|---|---|---|---|---|
| 5×5 | revisita | 0.592 | 0.969 | **−38.9%** |
| 5×5 | ciclos/ep | 1.63 | 23.0 | **−92.9%** |
| 5×5 | reversões (ARR) | 0.487 | 0.000 | +∞ (ver nota) |
| 5×5 | cobertura | 0.661 | 0.220 | +200% |
| 5×5 | SPL | 0.245 | 0.000 | +∞ (OFF nunca resolve) |
| 5×5 | sucesso | 62.5% | 0.0% | **+62.5pp** |
| 15×15 | revisita | 0.687 | 0.995 | **−30.9%** |
| 15×15 | ciclos/ep | 1.96 | 199.8 | **−99.0%** |
| 15×15 | ARR | 0.563 | 0.106 | +431% |
| 15×15 | cobertura | 0.056 | 0.025 | +124% |
| 15×15 | SPL | 0.000 | 0.000 | 0% |
| 15×15 | sucesso | 0.0% | 0.0% | 0pp |
| 31×31 | revisita | 0.682 | 0.999 | **−31.8%** |
| 31×31 | ciclos/ep | 2.88 | 939.0 | **−99.7%** |
| 31×31 | ARR | 0.665 | 0.354 | +87.7% |
| 31×31 | cobertura | 0.013 | 0.004 | +253% |
| 31×31 | SPL | 0.000 | 0.000 | 0% |
| 31×31 | sucesso | 0.0% | 0.0% | 0pp |

Notas honestas sobre o A/B:
- **Fim antecipado confunde parcialmente o Δ de revisita/ciclos**: os episódios ON morrem
  cedo (15–27 passos em 31×31 com `looped=1`) enquanto os OFF queimam os 1922 passos
  presos em loops (rev≈0.999, 959 eventos de ciclo). As TAXAS (M2) são por passo, mas a
  redução de ciclos/episódio reflete em parte a menor duração. Os sinais independentes —
  cobertura +200%/+124%/+253% e sucesso 62.5% vs 0% em 5×5 — mostram que a diferença não
  é só contabilística: a quebra ativa empurra o agente para células novas.
- **Reversões SOBEM no braço ON** (contrário ao esperado pela M3): a ARR mede inversões de
  ação e a quebra ativa força explicitamente a 2.ª melhor direção (muitas vezes oposta à
  anterior) em episódios curtos; no braço OFF os agentes ficam a bater na mesma parede
  (ARR 0 ou 1.0, ambos degenerados). A oscilação funcional (ciclos M4 + revisita M2) cai
  ~93–99%; a ARR isolada não discrimina aqui — coerente com a regra de ouro da research 11
  ("loops sobem M2/M3/M4 em simultâneo"; aqui M2+M4 descem forte e M3 sobe por efeito da
  própria quebra).
- **SPL/sucesso**: com agentes aleatórios, o OFF nunca resolve (SPL 0); o critério
  "SPL ≥ −2%" e "sucesso ≥ −5pp" é portanto trivialmente cumprido e até superado (+62.5pp
  em 5×5 — a quebra de ciclos e o fim antecipado evitam o dead-end de loop infinito).
- **Agentes congelados**: as punições de fitness não alteram trajetórias sem treino; o A/B
  mede os mecanismos ATIVOS. O efeito das punições via seleção está nos testes de
  aprendizagem (§2.1/2.2: converge igual ou melhor) e nos unitários de fórmula.
- Amostra pequena (24 episódios/célula; sem Mann-Whitney/Holm — fora do orçamento de
  1 probe do pedido). Resultados são agregados por média; a variância por labirinto está
  nas linhas parciais do log.

## 3. Critérios pré-registados vs medidos

| critério (pré-registado) | 5×5 | 15×15 | 31×31 |
|---|---|---|---|
| revisita −30% | **−38.9% PASS** | **−30.9% PASS** | **−31.8% PASS** |
| ciclos −50% | **−92.9% PASS** | **−99.0% PASS** | **−99.7% PASS** |
| SPL ≥ −2% | **PASS** (0.245 vs 0) | **PASS** (0 vs 0) | **PASS** (0 vs 0) |
| sucesso ≥ −5pp | **PASS** (+62.5pp) | **PASS** (0pp) | **PASS** (0pp) |

**Os 4 critérios pré-registados passam nos 3 tamanhos.**

## 4. Tensões de contrato / desvios (sem desvios silenciosos)

1. **`tests/validate.mjs` (domínio INTEGRAÇÃO) não é editável por mim** e faz spot-checks
   exatos da fórmula ANTIGA (`1.5 + (1−s/m) + 0.5*(v/oc)` e `prog − s·0.002 + 0.25*(v/oc)`).
   Resolução sem o tocar: `fitnessOf` mantém a fórmula legada quando `bonus` é omitido
   (os valores de validate: 2.475 e 1.055 passam INALTERADOS — 1.055 < 1.2, o clamp não
   interfere). O motor (runEpisode) passa SEMPRE `bonus` ⇒ comportamento novo em execução.
2. **Sinal de "oposto"**: a research 07 §2.6a escreve `dir === (prevDir + 2) % 4`, o que
   assume ordem circular das direções; a ordem canónica do projeto (CONTRACTS: 0=up, 1=down,
   2=left, 3=right) tem opostos `0↔1, 2↔3` ⇒ implementado `dir === (prevDir ^ 1)` (o
   significado "direção oposta" da research prevalece sobre a sua expressão literal).
3. **BONUS com n=0**: a tarefa diz `0.005/sqrt(n)` com "prior count n (n>=0)" — literal seria
   divisão por zero na 1.ª entrada. Implementado `0.005/sqrt(n+1)` que é EXATAMENTE a forma
   fechada da research 07 §2.3 ("na entrada numa célula visitada n−1 vezes: a primeira
   visita paga α, a segunda α/√2").
4. **`BUMP_PENALTY = -0.04`**: pedido como "mais cara que qualquer revisita"; com a saturação
   `p(≥10) = -0.04` a batida EMPATA com o piso da revisita saturada (é estritamente mais cara
   que qualquer revisita não saturada e que qualquer reversão 0.008). Mantido o valor pedido.
5. **Verificação vacuamente verdadeira**: quando `t0 < p` (sem história suficiente), a
   comparação de período tem 0 elementos ⇒ confirma na 1.ª repetição (é isto que dá
   "ABAB detetado em ≤ 3 passos", literalmente pedido). Efeito colateral: um regresso pontual
   a uma chave com gap p sem história confirma como "ciclo" (ciclo de 1 volta: custa
   `0.02·p` e arma a quebra de 8 passos; só `repeats≥4` termina o episódio). Documentado;
   os testes de falso-positivo obrigatórios (caminho BFS limpo) passam.
6. **`repeats` conta CONFIRMAÇÕES** (cada repetição de chave verificada), como pedido
   ("confirmed cycle => cycleLen=p, repeats++"); num ciclo verdadeiro as confirmações surgem
   a cada passo, mas a quebra ativa de 8 passos interrompe-as — na prática `repeats` cresce
   ~1 por reentrada em ciclo, e o fim antecipado ocorre ao fim de poucas reentradas.
7. **Penalidades de ciclo e a guarda**: `penaltyCycle` não tem tecto (como pedido) e o piso
   1.25 do solved é aplicado à composição final — um solved com muitas voltas confirmadas
   pode empatar no piso 1.25 com um solved limpo (monotonia intra-solved sacrificada
   exatamente onde a guarda o exige; é a prioridade explícita do pedido).
8. **Anti-aliasing sem trajetória sintética dedicada**: o mecanismo está implementado
   (quantização 4 bits + 2.º detetor + campo `aliased`) e coberto por testes de plumbing
   (`quantSig`, ausência de falsos positivos aliados) + telemetria do probe A/B; não foi
   possível construir dentro do orçamento uma trajetória sintética em que a assinatura
   cicla e o par (célula,ação) não (exige geometria periódica com raios limitados em todas
   as direções). Limitação assumida, não escondida.
9. **Bónus de entropia de ações (07-2.6b), anti-camping (07-2.5c) e histerese-punição
   (07-2.6a como penalidade)** NÃO implementados: o pedido (item 5) substitui a histerese
   por persistência de política (implementada) e não os menciona; ficam como trabalho
   futuro documentado.
10. **A/B com agentes congelados**: com agentes aleatórios congelados as penalidades de
    fitness não alteram trajetórias (não há aprendizagem); o A/B mede portanto os
    mecanismos ATIVOS (histerese + quebra + fim antecipado). O efeito das punições via
    seleção está coberto pelos testes de unidade e pelos testes de aprendizagem
    (5×5/7×7/curriculum continuam a convergir).

## 5. Fecho (TRAVAS.md §1.5)

- Processos: `ps` verificado sem processos do projeto além do servidor da demo (probe e
  testes terminados; tudo correu com `timeout 600` como primeiro wrapper).
- Orçamento de tentativas: 1 ronda de implementação + 1 ronda de correção (4 falhas do 1.º
  run: `path.push` na saída antecipada, sinal do `penaltyCycle`, case de histerese com
  arredondamento float) + verificação final. Dentro das 3 rondas máximas do TRAVAS §2.
- Trabalho futuro documentado (não implementado, ver §4.9): bónus de entropia condicionado
  a estagnação (07-2.6b), anti-camping na saída (07-2.5c), reincidência de loops entre
  episódios no worker (06-H), teste sintético dedicado ao ramo aliado (§4.8), estatística
  inferencial do A/B (Mann-Whitney + Holm, research 11 §3-B.4).
