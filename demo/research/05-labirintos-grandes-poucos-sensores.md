# 05. Labirintos grandes com poucos sensores: navegação, memória interna e anti-loop

Pesquisa web sobre navegação POMDP com observações pequenas, horizontes de memória necessários em grelhas grandes, mapas topológicos sem coordenadas, algoritmos clássicos de labirinto, benchmarks (Memory Maze, POPGym, NEAT/novelty search, AntMaze/D4RL, MineRL) e modos de falha conhecidos (loops, corredores, simetrias).

## 1. Síntese: o que funciona para navegação em labirintos grandes com poucos sensores

O problema do demo (31x31, 12 sinais, sem coordenadas) é um POMDP de memória longa com aliasing perceptual severo: células diferentes produzem assinaturas sensoriais idênticas (4 distâncias a paredes + 4 linhas de visão da saída + 4 frações de visitas), e a única forma de se localizar é integrar informação ao longo do tempo. A literatura converge em quatro pontos:

1. **A memória exigida escala com o tamanho do labirinto, não com o número de sensores.** Tarefas tipo corredor de n salas exigem profundidade de memória proporcional a n (Gomez, Schmidhuber e Wierstra, "deep memory POMDPs"). No benchmark Memory Maze, o 9x9 (episódios de 1000 passos) é resolvido por RL atual, mas o 15x15 (episódios de 4000 passos, humano 67.7 de máximo 87.7) está fora de alcance dos métodos state-of-the-art, mesmo com imagens ricas. Um labirinto 31x31 tem caminhos com comprimento O(n²), logo o horizonte útil de memória está nas centenas de passos, não nas dezenas.
2. **A memória tem de guardar três coisas em simultâneo:** o layout das paredes já vistas, a posição dos alvos e a posição do próprio agente (dead reckoning). Um estado recorrente "genérico" sem pressão para guardar isto não chega; arquiteturas com recorrência explícita (GRU, Elman, fast weights) superam consistentemente as sem memória, e treinar com backpropagation truncada (TBTT) com janelas longas é o que mais melhora os resultados nos labirintos maiores (POPGym, Memory Maze).
3. **Sem coordenadas, a desambiguação faz-se por assinaturas locais + agenda de exploração.** Os mapas topológicos clássicos (Kuipers, Spatial Semantic Hierarchy) resolvem o aliasing perceptual mantendo nós com assinaturas sensoriais, detetando fechos de loop e, quando há duas hipóteses de localização, executando movimentos de sondagem para recolher mais evidência. Uma agenda de "arestas por explorar" garante mapa completo e dá os candidatos para desambiguar. As frações de visitas do demo são exatamente o tipo de assinatura que estes mapas usam.
4. **Os algoritmos clássicos mostram o que a rede tem de aprender e onde falha a heurística simples.** Seguir paredes só funciona se início e saída estiverem na mesma componente de parede (falha com paredes-ilha ou saída interior); Trémaux resolve qualquer labirinto mas exige marcar passagens visitadas (memória de estado por passagem); dead-end filling e flood-fill exigem mapa. Um agente aprendido que não implemente uma forma de "marcar e não reentrar em becos sem saída" reinventa um random mouse e entra em loops.
5. **A principal causa de insucesso em labirintos enganosos não é a memória mas a deceção do fitness.** No "hard maze" de Stanley e Lehman, becos que levam o agente perto do objetivo atraem o fitness e prendem-no em ótimos locais; novelty search (recompensar comportamentos novos, não a distância ao objetivo) encontra caminhos quase ótimos onde a otimização objetiva falha. É o resultado mais replicado em neuroevolução para labirintos.
6. **Recompensas esparsas em grelhas grandes exigem exploração dirigida.** AntMaze large (D4RL) tem scores normalizados muito abaixo dos mazes pequenos (large-diverse ~58 vs umaze ~84 em RL offline), e no MineRL Navigate (sparse) demonstrações humanas são praticamente necessárias porque exploração aleatória não encontra recompensa. Recompensas de contagem de visitas (pseudo-contagens, Tang et al.) e penalização de revisita são as mitigações padrão.

## 2. Mecanismos e constatações (6)

### 2.1 Horizonte de memória necessário: proporcional ao diâmetro, tipicamente 4x a 10x o diâmetro em passos
As tarefas de memória profunda clássicas são corredores de n salas em que a decisão certa depende de um sinal visto n passos antes: a profundidade de memória necessária cresce linearmente com n e os métodos que evoluem topologia e pesos em conjunto (co-evolution de neurons recorrentes, Gomez et al. 2005; recurrent policy gradients, Wierstra et al. 2007) resolvem, enquanto RNNs superficiais falham. No Memory Maze, o tamanho define o comprimento do episódio (1000 passos em 9x9, 4000 em 15x15) e o rendimento dos agentes cai drasticamente do 9x9 para o 15x15, com Dreamer (TBTT) à frente de IMPALA mas todos abaixo do humano. Regra prática da literatura: o horizonte de crédito (BPTT ou tamanho de loop de recorrência) tem de cobrir o trecho entre a observação e a decisão que dela depende, e num labirinto NxN esse trecho é o comprimento de caminho entre bifurcações, que escala com N e, em espirais, com N². Para N=31, um horizonte inferior a ~100 passos não cobre sequer um contorno de espiral; 256 a 1024 passos é a ordem de grandeza usada implicitamente nos benchmarks que funcionam.

### 2.2 Memória de trabalho vs memória de mapa: são coisas diferentes
O Memory Maze isola o desafio e mostra que o agente tem de reter múltiplos itens (posições de objetos, layout de paredes, posição própria), não um bit. O DM Memory Suite, que precisa de 1 bit (T-Maze) ou 1 coordenada (Watermaze), está resolvido, e o DMLab tem um skyline que resolve a localização e por isso não testa memória real. Conclusão transferível: sinais de "fração visitada" ajudam, mas a rede precisa de um estado que acumule mapa, não apenas de contadores de curto prazo. Os probes do Memory Maze (sondar a representação interna para prever layout e posições) são o método recomendado para verificar se a memória evoluída guarda mesmo mapa.

### 2.3 Arquiteturas de memória: GRU como melhor geral, Elman como melhor custo-benefício, TBTT como fator de treino
No POPGym (15 ambientes parcialmente observáveis, 13 arquiteturas de memória), o GRU é o melhor modelo de memória general-purpose, as Elman networks dão o melhor equilíbrio entre desempenho e eficiência, e há um desfasamento entre o que as memórias conseguem em supervised learning e em RL (as RNNs clássicas superam as transformers lineares em RL). Para neuroevolução, isto traduz-se em: recorrência com portas ou mecanismo de decaimento (fast weights com constante de tempo longa) resolve; recorrência pura sem gating decai rápido demais para horizontes de 100+ passos.

### 2.4 Aliasing perceptual: assinaturas locais + sondagem + agenda de exploração
Os mapas híbridos metral/topológicos de Kuipers detetam aliasing perceptual e fechos de loop, e quando a localização tem duas hipóteses executam movimento físico para obter mais evidência. A Spatial Semantic Hierarchy mantém uma agenda de edge-ends por explorar que (a) garante exploração completa do mapa e (b) fornece o conjunto restrito de candidatos para desambiguar lugares parecidos. Assinaturas de vistas (Fourier signatures em mapeamento visual topológico) organizam a memória sem coordenadas. No demo, a assinatura de um lugar é o vetor de 12 sinais; o mecanismo anti-aliasing tem de vir da história (últimos k movimentos + frações visitadas) ou de movimentos de sondagem (olhar para os quatro eixos antes de decidir).

### 2.5 Seguir paredes vs Trémaux vs flood-fill vs políticas aprendidas
Seguir paredes é O(1) em memória mas só resolve labirintos onde início e objetivo estão na mesma parede contínua; falha com paredes-ilha e saídas interiores. O algoritmo de Pledge acrescenta um contador de ângulo para recuperar desses casos. Trémaux marca cada passagem (1x ou 2x) e garante saída em qualquer labirinto, incluindo não simplesmente conexos, à custa de memória por passagem e sem garantia de caminho curto. Dead-end filling e flood-fill/shortest path exigem o mapa completo, ou seja, exploração prévia. Implicação direta: o "estado ideal" que uma rede evoluída tem de aproximar é um Trémaux comprimido (marcar becos visitados e não os reentrar), e o flood-fill é o que a saída por linha de visão permite fazer barato quando há visibilidade.

### 2.6 Modos de falha e mitigações com evidência
Falhas documentadas: (a) loops e ciclagem (o agente reentra em estados já visitados porque a observação local não diz "já cá estive"), (b) becos enganosos no hard maze (deception: becos que aproximam do objetivo sem progresso real), (c) simetrias de corredor que prendem políticas determinísticas em ciclos de período 2. Mitigações com resultados: novelty search com caracterização de comportamento (posição final ou cobertura de células) resolve o hard maze enganoso onde fitness por distância falha (Lehman e Stanley; replicado em deep neuroevolution com GA: "GA with novelty search found the goal while all reward-maximizing algorithms failed"); recompensas por exploração baseadas em contagem (pseudo-contagens de modelos de densidade, Tang et al. 2017) funcionam em espaços grandes; penalização de revisita e custo por passo impedem o vai-e-vem entre duas células; ruído de ação nos dados do Memory Maze foi usado deliberadamente para criar loops espaciais e ensinar fechos de loop.

## 3. IMPLICAÇÕES PARA O MOTOR (ajustes concretos e acionáveis)

**A. Horizonte de memória vs diâmetro (o mais importante).**
Dimensionar a memória em função do diâmetro do labirinto: `H_mem >= 8 x N` passos para um labirinto NxN, com piso em 256. Para 31x31, alvo `H_mem` de 256 a 512 passos. Na prática: (1) se houver BPTT/unroll de fitness por passos, alargar o unroll (ou o credit horizon) para >= 256 passos; (2) dar à rede mecanismos de memória com decaimento longo (fast weights com constante de tempo ~ 30 a 100 passos, ou memory neurons com self-loop reforçável), porque recorrência sem gating perde informação antes do horizonte útil; (3) penalizar topologias puramente feedforward ou dar-lhes fitness negativo em tarefas de labirinto grande, para que a evolução não colete soluções sem memória que funcionam só nos tamanhos pequenos.

**B. Sinais anti-loop (a partir dos 12 sinais atuais).**
Os 4 sinais de fração visitada por direção são o começo certo, mas são estáticos. Acrescentar ou compensar com: (1) um sinal de "passos desde a última visita a esta célula" (ou binário "revisitou nos últimos K passos"), que quebra ciclos de período 2 em corredores simétricos; (2) penalidade de fitness por reentrada em célula já visitada nesta passagem do episódio, decrescente (ex. primeira visita +0, segunda 0, terceira em diante negativo), para imitar Trémaux sem exigir mapa; (3) detetor explícito de loop: se a assinatura de 12 sinais atual coincide com a de há k passos e o agente fez um ciclo, aplicar bónus negativo e forçar aleatoriedade ou viragem (equivalente à recuperação do algoritmo de Pledge).

**C. Recompensa de exploração.**
Substituir ou temperar qualquer shaping por distância do objetivo por recompensa de novidade: contagem de visitas por célula (o ambiente sabe a célula; o agente não a vê, logo o bónus é dado pelo motor, não é um sensor novo) com `bonus = c / sqrt(n_visitas)`, que decai e evita que o agente fique a pastar numa zona nova. Complementar com novelty search em neuroevolução: caracterização de comportamento = conjunto/cobertura de células visitadas (ou posição final), arquivo de novidade e, se possível, speciation por comportamento. Isto é a mitiga com evidência mais forte contra becos enganosos e ótimos locais.

**D. Curriculum por tamanho e anti-simetria.**
Escalar 7x7 -> 11x11 -> 15x15 -> 21x21 -> 31x31 (o Memory Maze usa exatamente stepping stones porque o 15x15 direto não aprende). Aleatorizar início e saída por episódio e incluir layouts assimétricos no treino; adicionar ruído pequeno às ações durante a evolução (como no dataset do Memory Maze) para ensinar fechos de loop e evitar políticas determinísticas presas em simetrias.

**E. Fitness anti-decepção.**
Não usar distância euclidiana à saída como shaping principal em labirintos com becos: é o caso canónico de deceção no hard maze. Preferir (1) recompensa esparsa de saída + novidade, ou (2) shaping potencial baseado em progresso de flood-fill calculado pelo motor (distância real em passagens, não euclidiana), que nunca recompensa aproximação sem progresso real. A linha de visão da saída (4 sinais) pode ser usada como gating do bónus: reforçar movimentos que mantêm ou ganham LOS só quando a distância real diminui.

**F. Verificação da memória evoluída (probe).**
Antes de aumentar gerações, sondar o estado interno das melhores redes: consegue um classificador linear simples prever (1) fração de células visitadas, (2) direção da saída quando fora de LOS, (3) se a célula atual já foi visitada? Se não, a memória não está a ser usada e os ajustes acima têm de entrar antes de mais capacidade.

**G. Referência de escala para expectativas.**
Nem a indústria resolve 15x15 de memória longa com RL atual (Memory Maze, 2022-2023). 31x31 com 12 sinais é, portanto, um alvo exigente: o caminho realista é combinar memória estruturada (recorrência + fast weights), anti-loop por contagem de visitas, novidade como motor de exploração e curriculum, em vez de procurar um único truque de fitness.

## 4. Fontes

- Memory Maze (README, tabela de tamanhos, scores humanos, baselines): https://github.com/jurgisp/memory-maze
- Evaluating Long-Term Memory in 3D Mazes (Pasukonis, Lillicrap, Hafner, arXiv:2210.13383): https://arxiv.org/abs/2210.13383
- POPGym: Benchmarking Partially Observable Reinforcement Learning (Morad et al., ICLR 2023): https://arxiv.org/abs/2303.01859 e https://openreview.net/forum?id=chDrutUTs0K
- POPGym (repositório, 15 ambientes, 13 arquiteturas de memória): https://github.com/proroklab/popgym
- Co-Evolving Recurrent Neurons Learn Deep Memory POMDPs (Gomez, Schmidhuber, Wierstra, GECCO 2005): https://sferics.idsia.ch/pub/juergen/gecco05gomez.pdf
- Solving Deep Memory POMDPs with Recurrent Policy Gradients (Wierstra et al., ICANN 2007), citado em: https://camallen.net/files/lambda_discrepancy.pdf
- Influence-aware memory architectures for deep RL in POMDPs (memória focada em subconjunto de variáveis): https://pmc.ncbi.nlm.nih.gov/articles/PMC12204899
- Maze-solving algorithm (wall follower, Pledge, Trémaux, dead-end filling, condições de sucesso): https://en.wikipedia.org/wiki/Maze-solving_algorithm
- Autonomous Maze Solving Robotics: Algorithms and Comparisons: https://pdfs.semanticscholar.org/6b98/f778b96af9de3b7c0ce34dcb5b84b5bb52de.pdf/1000
- Maze Solving Algorithm (Encyclopedia MDPI, Trémaux garantido mas não ótimo): https://encyclopedia.pub/entry/33079
- The Spatial Semantic Hierarchy (Kuipers): https://www.cs.cmu.edu/~motionplanning/papers/sbp_papers/k/Kuipers-aij-00-elsevier.pdf
- Local Metrical and Global Topological Maps in the Hybrid Spatial Semantic Hierarchy (detetar aliasing e fechos de loop): https://www.cs.utexas.edu/~ai-lab/pubs/Kuipers-icra-04.pdf
- Vision-based topological mapping and localization methods (Fourier signatures, aliasing): https://emiliofidalgo.github.io/publication/garcia-2015-vision/garcia-2015-vision.pdf
- Evolution Through the Search for Novelty Alone (Lehman e Stanley, hard maze enganoso): https://gwern.net/doc/reinforcement-learning/exploration/2011-lehman.pdf
- A Study of Count-Based Exploration for Deep Reinforcement Learning (Tang et al., pseudo-contagens): https://papers.neurips.cc/paper/6868-exploration-a-study-of-count-based-exploration-for-deep-reinforcement-learning.pdf
- goNEAT_NS (novelty search vs fitness no hard maze, com resultados): https://github.com/yaricom/goNEAT_NS
- Deep Neuroevolution (GA + novelty search resolve a maze enganosa onde algoritmos por recompensa falham): https://www.alphaxiv.org/abs/1712.06567
- D4RL Tasks (maze2d e AntMaze, recompensa esparsa 0/1): https://github.com/Farama-Foundation/d4rl/wiki/Tasks
- D4RL AntMaze benchmarks (scores normalizados por tamanho): https://www.sota2.com/research/dataset/d4rl-antmaze
- D4RL: Datasets for Deep Data-Driven Reinforcement Learning (desafio de stitching em AntMaze): https://openreview.net/pdf/dd471beb05746ae8e58163f595af26abeaeb120b.pdf
- NeurIPS 2020 Competition: The MineRL Competition (Navigate sparse, demonstrações necessárias): https://ar5iv.labs.arxiv.org/html/2101.11071
- Memory Gym (tarefas de memória sem fim, Mortar Mayhem, S17): http://jmlr.org/papers/volume26/24-0043/24-0043.pdf
- Hippocampal representations emerge when training RL agents on goal-based maze tasks: https://arxiv.org/html/2012.01328v2
- Recurrent neural networks with transient trajectory explain working memory encoding (RNN vanilla vs com memória de trajetória em maze): https://www.nature.com/articles/s42003-024-07282-3
- Revisiting Constant Negative Rewards for Goal-Reaching (penalidade por passo, ciclos evitados): https://arxiv.org/html/2407.00324v1
- Growing an AI with NEAT (NEAT em mazes, 98.52% de sucesso em 1M de mazes treinados em 100): https://vbstudio.hu/en/blog/20190317-Growing-an-AI-with-NEAT
- Maze Benchmark for Testing Evolutionary Algorithms: http://www.cmap.polytechnique.fr/~nikolaus.hansen/proceedings/2018/GECCO/companion/companion_files/wksp174s2-file1.pdf
