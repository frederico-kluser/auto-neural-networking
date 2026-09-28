# 11. Métricas e verificação anti-loop: como provar que a punição de loops funciona

Pesquisa web sobre métricas de comportamento de navegação (cobertura, revisita, tortuosidade, SPL), métricas de oscilação/ciclos em trajetórias (reversões de ação, contagem de ciclos), metodologia A/B em neuroevolução (seeds, tamanhos de efeito, Mann-Whitney), verificação eficiente em amostras de mudanças de política (avaliação pareada em labirintos fixos) e benchmarks de navegação em labirintos com números publicados (Memory Maze, MiniGrid, hard maze de novelty search).

## 1. Síntese: como medir se a punição de loops funciona

A punição de loops entra na EVALUAÇÃO (fitness), por isso a verificação tem duas camadas e ambas são baratas:

1. **Verificação funcional do detector (milissegundos, determinística).** O detector tem de acusar loops em trajetórias sintéticas com loops conhecidos (oscilação de período 2 entre duas células, espiral fechada, regresso a beco) e não acusar em trajetórias sem loops (caminho BFS ótimo, caminho monótono com ruído). Reportar sensibilidade (100% nos casos sintéticos) e taxa de falsos positivos (< 5% em caminhos limpos). Sem isto, qualquer melhoria métrica é ambígua.
2. **Verificação de efeito A/B com orçamento fixo (minutos).** Comparar fitness com punição vs sem punição em avaliação pareada: mesmos labirintos, mesmas seeds de RNG (mulberry32), mesmos agentes congelados, registando métricas de trajetória por episódio antes e depois. A literatura é unânime: comparar políticas em conjuntos de teste fixos e pareados reduz a variância e permite detetar efeitos com poucos episódios; e em neuroevolução a unidade de análise são as seeds independentes, não os episódios de uma só corrida.

A leitura correta do resultado não é "o fitness subiu" (a punição altera o próprio fitness e torna a comparação direta de valores inválida), mas sim: **as métricas de trajetória independentes (revisita, ciclos, reversões, SPL, sucesso) melhoram de forma estatisticamente significativa e com efeito não desprezável, sem degradar a taxa de sucesso**. Os números publicados servem como ordens de grandeza: no hard maze enganoso a otimização objetiva precisa de ~72 427 avaliações contra ~27 167 do novelty search (Gravina et al.); no Memory Maze o humano marca 26.4 a 67.7 alvos (conforme o tamanho) contra máximos de 34.8 a 87.7, e os RL state-of-the-art ficam abaixo do humano já no 15x15. Não há benchmark publicado com taxas de revisita comparáveis às do demo, por isso as comparações de referência são internas (antes vs depois) e as externas servem só de escala.

## 2. Métricas (6) com referência e fórmulas

Notação comum: episódio de T passos, trajetória de células da grelha c_0..c_T (o motor conhece a célula para gerar os sensores; 31x31 tem 961 células), ações a_1..a_T, C_dist = nº de células distintas visitadas, l* = comprimento do caminho ótimo por BFS (já existe em `demo/core/maze.mjs`), p = comprimento percorrido, S = 1 se chegou à saída.

**M1. Taxa de cobertura (coverage rate).** Fração do espaço acessível visitada e velocidade de cobertura.
- `Cov = C_dist / C_acessíveis` e `CovRate(t) = C_dist(t) / t` (células novas por passo).
- Loop = CovRate colapsa: o agente anda mas não descobre nada. Referência: métricas de exploração em navegação e recompensas por contagem de visitas (Tang et al., 2017, contagens/estado como sinal de exploração).

**M2. Taxa de revisita (revisitation rate).** Fração de passos gastos em células já visitadas; é a métrica-alvo mais direta da punição de loops.
- `Rev = (T - C_dist) / T = 1 - C_dist/T` (variação em [0,1]); complementar: `VisitasMedias = T / C_dist`.
- Alternativa robusta a trajetórias longas: revisitas por 100 passos, `Rev100 = 100 * (T - C_dist) / T`.
- Os sensores de "fração do percurso percorrido por direção" do demo são precisamente sinais anti-revisita; M2 mede se a punição os faz usar.

**M3. Taxa de reversões de ação (action reversal rate).** Oscilação de período 2 (vai-e-vem entre duas células) é o modo de loop dominante em grelhas com simetria de corredor.
- `ARR = (1/(T-1)) * Σ_t 1[a_t = oposto(a_{t-1})]`, com pares opostos (cima, baixo) e (esquerda, direita).
- ARR > 0.1 em trajetória que não progride é oscilação; ARR ≈ 0 com Rev alto indica loop de período maior (M4). Referência: deteção de loops/oscilação em trajetórias de robótica (loop closure verification, onde falsos positivos de reversão são métrica padrão).

**M4. Ciclos por episódio (cycle count) e passos em ciclo.** Deteção direta de subsequências repetidas, independente da posição absoluta (adequado a agente sem coordenadas).
- Definição operacional: um ciclo ocorre em t quando existe k ∈ [2, K] (K = 8 por omissão) tal que `(c_{t-k}, a_{t-k+1..t}) = (c_t, a_{t-k+1..t})`, isto é, o agente regressa a uma célula executando a mesma subsequência de ações; eventos sobrepostos contam como um só.
- `Ciclos/episódio` = nº de eventos; `LoopOcc` = fração de passos cobertos por algum evento (métrica de severidade).
- Forma equivalente barata: hash deslizante dos últimos k pares (célula, ação) e contagem de colisões de hash. É exatamente este sinal que a punição deve fazer descer; se LoopOcc não desce, a punição não está a atuar onde se supõe.

**M5. SPL (Success weighted by Path Length).** Métrica de consenso para eficiência de navegação; penaliza caminhos longos só quando há sucesso, evitando confundir "rápido mas falhado" com "eficiente".
- `SPL = (1/N) * Σ_i S_i * l*_i / max(p_i, l*_i)` (Anderson et al., 2018; fórmula canónica do grupo de trabalho de avaliação de navegação).
- No demo: l* vem do BFS do gerador de labirintos (labirintos perfeitos, logo caminho ótimo único), p = passos do episódio. Uma punição de loop saudável **aumenta** SPL; se SPL desce com Rev, a punição está a trocar loops por paralisia.

**M6. Tortuosidade / straightness (eficiência de caminho sem sucesso binário).** Mede zigzag mesmo em episódios falhados, onde SPL é zero e não informa.
- Straightness `S_idx = D / L` com D = deslocamento em linha reta entre início e fim da trajetória e L = comprimento acumulado (Benhamou, 2004; índice de retitude fiável para caminhos orientados); tortuosidade `τ = L / D = 1 / S_idx`.
- Variante orientada ao objetivo: `Eff = d(início, saída) / p` (porção do percurso que representou progresso direto). Em loops fechados D ≈ 0 logo τ explode, o que torna M6 o melhor alarme de loop total.

Regra de ouro de interpretação: loops reais sobem M2, M3, M4 e M6 em simultâneo e descem M1 e M5. Um anti-loop que só desce M3 mas mantém M4 está apenas a mudar a forma do loop.

## 3. IMPLICAÇÕES PARA O MOTOR: protocolo A/B barato (teto de 10 min de CPU)

**A. Verificação funcional primeiro (obrigatória, < 1 s).**
Adicionar a `demo/tests/unit-net.mjs` (ou a `validate.mjs`) casos sintéticos: (1) trajetória oscilação A-B-A-B por 50 passos, esperado ≥ 1 ciclo e ARR ≈ 1; (2) caminho BFS ótimo com 5% de ruído, esperado 0 ciclos e ARR < 0.05; (3) espiral fechada de 40 passos, esperado 1 ciclo com LoopOcc ≈ 1. Falhar o build se sensibilidade < 100% ou falsos positivos > 5%. Isto isola bugs do detector de variação estatística.

**B. A/B pareado com avaliação congelada (minutos; não exige treino).**
1. **Conjunto de teste fixo:** 3 tamanhos (5x5, 15x15, 31x31) x 20 labirintos fixos por tamanho (seeds de geração fixas, registadas em JSON). Usar exatamente os mesmos labirintos nas duas condições.
2. **Agentes:** 5 seeds de evolução já existentes (agentes congelados do estado atual) x 2 condições de avaliação (fitness sem punição de loops vs com punição), avaliando os mesmos indivíduos com as mesmas seeds de ruído de ação.
3. **Métricas por episódio:** M1 a M6 + taxa de sucesso + passos. Gravar em `demo/tests/last-validation.json` ou ficheiro dedicado `anti-loop-ab.json`.
4. **Estatística:** Mann-Whitney U (Wilcoxon rank-sum) por métrica e tamanho entre as distribuições de episódios das duas condições, com correção de Holm-Bonferroni para as 6 métricas x 3 tamanhos; reportar efeito (r de bisseerial `r = 1 - 2U/(n1*n2)` ou delta de Cliff: desprezável < 0.147, pequeno < 0.33, médio < 0.474, grande ≥ 0.474) e intervalo de confiança por bootstrap. **Armadilha de potência:** com 5 pares, o teste pareado (Wilcoxon signed-rank) não consegue p < 0.05 bicaudal (mínimo = 0.0625); por isso a unidade de análise deve ser o episódio/ labirinto (5 seeds x 20 labirintos = 100 observações por condição e tamanho, com a seed como bloco), ou então usar ≥ 10 seeds. Colas et al. mostram que a norma em RL é < 5 seeds e que isso quase não tem poder estatístico; Demšar (2006) recomenda ≥ 10 conjuntos de dados para comparações pareadas de algoritmos.
5. **Orçamento de CPU:** o piso de desempenho atual do `validate.mjs` (≥ 20 000 ticks/s de rede, ≥ 50 episódios/s em 5x5) dá margem enorme: 3 tamanhos x 2 condições x 5 seeds x 20 labirintos = 600 episódios, com limites de 500/1500/2500 passos, cerca de 1.1M de ticks ≈ 60 s a 20 000 ticks/s. Mesmo com folga de 5x, cabe em 10 min de CPU. Impor timeout por episódio e teto global com saída parcial + relatório JSON (nunca correr "até convergir").

**C. A/B de treino curto (opcional, quando se quiser provar efeito no aprendizado).**
2 condições x 5 seeds x corridas de 60 s (ou de N gerações x população fixa, para comparabilidade independente da máquina) = 10 min no pior caso. Critério de sucesso do treino: a curva de melhor fitness **em métrica independente** (SPL ou sucesso) atinge o limiar em menos avaliações do que no braço de controlo. Referência de escala: no hard maze de novelty search, novelty resolve em ~27 167 avaliações e a pesquisa objetiva em ~72 427 (Gravina, Liapis e Yannakakis), logo diferenças de 2x a 3x no orçamento de avaliações são o tamanho de efeito esperável quando a punição mexe na dinâmica de exploração, não 10%.

**D. Critérios de decisão pré-registados (para não interpretar à posteriori).**
Punição considerada efetiva quando, por tamanho: (i) mediana de Rev cai ≥ 30% e Ciclos/episódio caem ≥ 50%; (ii) SPL sobe ou mantém-se (tolerância -2%); (iii) taxa de sucesso não cai mais de 5 pontos percentuais; (iv) p < 0.05 com Holm nas métricas M2 e M4 e efeito médio (|r| ≥ 0.3 ou |delta de Cliff| ≥ 0.33). Se Rev desce mas sucesso desce, a punição está a induzir paralisia (castiga exploração legítima); calibrar a penalidade para passos em ciclo (LoopOcc) e não para revisita simples, porque revisitar é necessário em labirintos com becos.

**E. Números de referência publicados (ordens de grandeza, não alvos).**
- SPL: métrica canónica de navegação embutida, definida por Anderson et al. (2018); valores de referência só fazem sentido dentro do mesmo benchmark.
- Hard maze (decepção): 21 390 avaliações (surprise search, σ = 14 519) vs 27 167 (novelty, σ = 18 510) vs 72 427 (objetivo, σ = 10 587).
- Memory Maze (humanos vs máximos possíveis): 9x9 26.4/34.8; 11x11 44.3/58.0; 13x13 55.5/74.5; 15x15 67.7/87.7; o 15x15 está fora do alcance dos RL atuais.
- MiniGrid Memory: recompensa `1 - 0.9 * (step_count / max_steps)`, ou seja, penalidade por passo embutida na recompensa, a mesma família de anti-loop por custo temporal.
- Seeds: norma publicada < 5 seeds; recomendação de análise de poder para ≥ 10 quando o efeito não é grande.

## 4. Fontes

- On Evaluation of Embodied Navigation Agents (SPL, fórmula canónica, protocolo de avaliação; Anderson et al., 2018): https://arxiv.org/abs/1807.06757
- SPL explicado com a fórmula (alphaXiv): https://www.alphaxiv.org/abs/1807.06757
- Success Weighted by Path Length em navegação (síntese e usos): https://www.emergentmind.com/topics/success-weighted-by-path-length-spl
- How to reliably estimate the tortuosity of an animal's path (straightness index S = D/L; Benhamou, 2004): https://www.sciencedirect.com/science/article/abs/pii/S0022519304001353 e https://pubmed.ncbi.nlm.nih.gov/15207476
- Tortuosity (definições e fórmulas em 2D): https://en.wikipedia.org/wiki/Tortuosity
- A Study of Count-Based Exploration for Deep Reinforcement Learning (Tang et al., contagens de visitas como sinal de exploração): https://papers.neurips.cc/paper/6868-exploration-a-study-of-count-based-exploration-for-deep-reinforcement-learning.pdf
- Statistical Comparisons of Classifiers over Multiple Data Sets (Wilcoxon signed-rank, N ≥ 10 conjuntos; Demšar, JMLR 2006): https://www.jmlr.org/papers/volume7/demsar06a/demsar06a.pdf
- How Many Random Seeds? Statistical Power Analysis in Deep RL (Colas et al., 2018; norma < 5 seeds e por que isso falha): https://arxiv.org/abs/1806.08295 e https://inria.hal.science/hal-01890154/file/1806.08295.pdf
- Two-sample Mann-Whitney U Test e tamanhos de efeito (delta de Cliff, r): https://rcompanion.org/handbook/F_04.html
- wilcox_effsize (r de bisseerial para Mann-Whitney/Wilcoxon): https://rpkgs.datanovia.com/rstatix/reference/wilcox_effsize.html
- Surprise Search: Beyond Objectives and Novelty (números do hard maze: 21 390 / 27 167 / 72 427 avaliações): https://antoniosliapis.com/papers/surprise_search_beyond_objectives_and_novelty.pdf
- Evolution Through the Search for Novelty Alone (Lehman e Stanley, hard maze enganoso): https://gwern.net/doc/reinforcement-learning/exploration/2011-lehman.pdf
- Recombination and Novelty in Neuroevolution: A Visual Analysis (replicação do advantage do novelty em maze): https://link.springer.com/article/10.1007/s42979-022-01064-6
- Memory Maze (README, tabela de tamanhos e scores humanos; Pasukonis et al.): https://github.com/jurgisp/memory-maze
- Evaluating Long-Term Memory in 3D Mazes (arXiv:2210.13383): https://arxiv.org/abs/2210.13383
- MiniGrid Memory (recompensa com penalidade por passo): https://minigrid.farama.org/environments/minigrid/MemoryEnv
- Memory Gym (limites dos benchmarks com estado terminal para medir eficiência): http://jmlr.org/papers/volume26/24-0043/24-0043.pdf
- Maze benchmark for testing evolutionary algorithms (benchmark multi-labirinto para comparação justa): https://dl.acm.org/doi/10.1145/3205651.3208285
- A Brief Survey of Loop Closure Detection (verificação de loops em trajetórias, falsos positivos como métrica): https://ml-retrospectives.github.io/neurips2020/camera_ready/21.pdf
- Revisiting Constant Negative Rewards for Goal-Reaching (penalidade por passo evita ciclos): https://arxiv.org/html/2407.00324v1
