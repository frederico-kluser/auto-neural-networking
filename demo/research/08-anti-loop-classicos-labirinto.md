# 08. Anti-loop clássico de labirintos: garantias algorítmicas e sinais para moldar fitness

Pesquisa web sobre algoritmos clássicos de exploração de labirintos (wall following, Pledge, Trémaux, Tarry, flood-fill/BFS, dead-end filling, micromouse) e sobre como os seus sinais internos (marcação de passagens, contagem de viragens, gradiente de distância, contagens de visita) podem ser reutilizados como shaping de fitness no motor de avaliação, para punir loops e forçar novos caminhos, sem acrescentar entradas à rede.

## 1. Síntese: o que os algoritmos clássicos garantem (e o que não garantem)

A literatura clássica organiza-se em três famílias consoante o que o solucionador tem de guardar: (a) sem memória (random mouse, wall following, Pledge), (b) com marcação no terreno (Trémaux, Tarry, recursive backtracker), (c) com mapa completo (dead-end filling, flood-fill/BFS, A*). As garantias diferem muito entre elas e são o ponto de partida para o shaping:

1. **Wall following (mão na parede) só garante em labirintos simply connected** (todas as paredes ligadas entre si ou ao contorno). Nesse caso é uma travessia DFS in-order e nunca se perde; em labirintos com ilhas (paredes desconetadas) ou com saída/entrada interiores, dá voltas ao redor da ilha e regressa ao início sem nunca ver a saída. Detetor útil: se o solucionador regressa ao ponto onde começou a seguir a parede, o labirinto não é simply connected e a heurística falhou.
2. **Pledge garante saída exterior de qualquer ponto de um labirinto 2D finito**, mesmo atravessando ilhas, à custa de apenas um contador de ângulos (sem marcas, sem mapa). Não resolve o problema inverso (entrar de fora e encontrar um objetivo interior), nem garante caminho curto, e pode revisitar passagens (sempre com totais de viragens diferentes). Não é garantido quando o objetivo está dentro de uma ilha.
3. **Trémaux garante saída em qualquer labirinto com passagens bem definidas**, incluindo labirintos com loops (não simplesmente conexos), marcando cada entrada de passagem 0, 1 ou 2 vezes. Não garante caminho curto. A sua regra de "voltar atrás" transforma efetivamente qualquer labirinto com loops num labirinto simply connected, e sem saída termina no início com todas as passagens marcadas 2x (cada passagem percorrida exatamente 2 vezes). Historicamente antecedeu o depth-first search em cerca de um século.
4. **Tarry (1895) garante travessia completa e terminação** sem conhecimento prévio: "não sair de uma interseção por onde se entrou até todas as outras saídas estarem exploradas"; cada aresta é percorrida no máximo 2 vezes, uma em cada sentido.
5. **Flood-fill/BFS e dead-end filling exigem mapa completo** (visão de cima ou exploração prévia). O BFS garante caminho curto; dead-end filling nunca corta a solução porque preserva a topologia, e em labirintos perfeitos deixa apenas a solução. São a "solução ótima" contra a qual os métodos on-line são medidos.
6. **Nenhum sinal é grátis**: os métodos com garantia pagam com memória por passagem (Trémaux, Tarry, DFS) ou por mapa (BFS); os métodos sem memória não têm garantia geral. O random mouse é a referência negativa: encontra a solução com probabilidade 1 mas sem garantia de terminação, e é exatamente onde converge um agente aprendido sem pressão anti-loop. A paralela em RL é direta: penalização de revisita (o "marcar" Trémaux), bónus de contagem/novidade (forçar outros caminhos) e shaping por gradiente de distância (o flood-fill), com o cuidado de que o gradiente puro cai em becos enganosos (deception).

## 2. Mecanismos (6)

### 2.1 Wall following (regra da mão na parede): O(1) memória, garantia condicionada
Seguir sempre a parede da direita (ou da esquerda) nas bifurcações. Garantido apenas se início e fim estiverem na mesma componente de parede; falha com paredes-ilha, saídas interiores e atravessamentos (weave). Não produz o caminho mais curto. O seu único sinal de loop é o regresso ao ponto de partida, que serve de diagnóstico ("esta heurística não chega") e não de solução. Topologicamente funciona porque paredes conetadas podem ser deformadas num círculo, e andar ao redor de um círculo leva de um ponto a outro.

### 2.2 Pledge (contador de viragens): saltar ilhas com uma única variável
Escolhe-se uma direção preferencial; ao bater numa parede segue-se a parede contando viragens (direita +90 graus, esquerda -90 graus) e só se abandona a parede quando o rumo volta ao preferencial E a soma de viragens é 0. Isto resolve armadilhas em forma de "G" (onde um contador só de rumo entra em loop infinito ao largar a parede com 360 graus acumulados) e permite saltar de ilha em ilha até ao contorno. Sinais ricos para reutilizar: (a) a soma de viragens é um acumulador de "quanto estou a contornar sem progredir"; (b) revisitas são legítimas no Pledge, mas sempre com somas de viragens diferentes, logo "mesma célula + mesmo ângulo acumulado" é evidência forte de loop; (c) soma que cresce sem limite é o único sinal de labirinto irresolvível sem marcas.

### 2.3 Trémaux (marcação de passagens 0/1/2) e Tarry: o anti-loop com garantia
Cada entrada de passagem é marcada ao passar; numa bifurcações escolhe-se uma entrada não marcada se existir; se a única não marcada é por onde se veio, volta-se atrás (regra que impede fechar loops); passagens com marca dupla são becos definitivos. Garante saída em qualquer labirinto, com custo de memória por passagem e trajetória "bidirecional double tracing" quando não há saída. Tarry exprime a mesma lógica numa regra única (não sair pela entrada até as outras saídas estarem exploradas) e garante cada aresta no máximo 2 vezes. O conceito transferível é exatamente o de "marca dupla": a segunda visita a um trecho sem progresso converte-o em beco e obriga a procurar outro caminho.

### 2.4 Flood-fill/BFS e dead-end filling: o gradiente ideal e a eliminação de becos
O flood-fill propaga distâncias desde a saída (ou desde o início) e o solucionador desce o gradiente; o BFS garante o caminho curto; o "shortest paths finder" marca todos os caminhos curtos comparando distâncias de duas ondas. Dead-end filling elimina becos (e o cul-de-sac filler elimina laços terminais em forma de nó), preservando a topologia e nunca isolando início de fim. Limitação comum: exigem ver o labirinto todo, ou seja, uma fase de exploração/mapeamento antes de correr. Comparativamente, em labirintos grandes o BFS é mais robusto e o flood-fill tabular clássico paga-se em memória proporcional ao labirinto.

### 2.5 Micromouse: exploração, mapa de paredes e corrida em gradiente
Nas competições de micromouse o robô parte sem mapa: explora célula a célula, regista paredes detetadas, recalcula as distâncias de flood-fill (valores de "distância até ao objetivo" por célula) e segue o trilho de números decrescentes até zero; quando bate numa parede prevista errada, atualiza o mapa e repropaga. A estratégia padrão é de duas fases: exploração (com tolerância a desvios e retorno ao início para calibrar) e depois "speed run" pelo caminho mais curto conhecido. O algoritmo de Bellman/wavefront subjacente é o mesmo do flood-fill. Sinais reutilizáveis: mapa de paredes incremental, número de células ainda não visitadas, e o valor de distância ao objetivo como medida de progresso.

### 2.6 Sinais anti-loop na RL moderna: contagens, pseudo-contagens e penalização de revisita
O shaping contemporâneo reproduz os mesmos três sinais clássicos: bónus de exploração proporcional a 1/sqrt(N(s)) (contagem de visitas; pseudo-contagens de modelos de densidade para espaços contínuos, Bellemare et al.; Ostrovski et al.), penalização de revisita e custo por passo para impedir vai-e-vem entre estados, e recompensas de progresso (distância ao objetivo) com risco conhecido de deception. A contagem de visitas é precisamente a "marca de Trémaux" contabilizada pelo ambiente em vez de pelo agente.

## 3. IMPLICAÇÕES PARA O MOTOR: sinais derivados para punir loops e forçar novos caminhos

Todos os sinais abaixo são calculados pelo motor a partir do mapa e da trajetória e entram apenas no fitness (shaping da avaliação). Nenhum acrescenta entradas à rede: a rede continua a ver os mesmos 12 sensores e é a pressão de seleção que a obriga a "tentar outros caminhos".

**A. Penalidade de revisita escalonada tipo Trémaux (o mais imediato).**
O motor mantém v(c) = número de visitas à célula (ou aresta) c da trajetória. Aplicar penalidade crescente: 2ª passagem em c sem novo máximo de progresso: -lambda1; 3ª e seguintes: -lambda2 com lambda2 ~ 3*lambda1; equivalente funcional às marcas 1x/2x de Trémaux. Versão por aresta (célula origem, célula destino) é mais robusta a corredores largos. Complementa as frações de visita já existentes como entradas, sem as alterar.

**B. Detetor de volta-invertida de período 2 (e ciclos curtos k>2).**
Se a posição em t repete a de t-2 com ação invertida (A, B, A, B, ...), incrementar um contador de oscilação e penalizar -lambda_osc * n_osc, com crescimento exponencial após k oscilações seguidas (ex. k=3). Generalização barata: hash das últimas 8 posições; se o mesmo hash de janela já ocorreu 2 vezes no episódio, é loop de período longo e recebe a mesma penalidade. Deteta exatamente os ciclos de simetria de corredor que prendem políticas determinísticas.

**C. Contagem de viragens tipo Pledge como medidor de "contornar sem progredir".**
Manter o ângulo acumulado A desde o último evento de progresso (novo máximo de distância de caminho à saída, ou nova cobertura). Se |A| >= 360 graus sem progresso, penalizar por passo proporcional a |A|/360; zerar A quando há progresso. Isto separa contorno legítimo de obstáculo (A retorna a 0) de loop em ilha (A não volta a 0, como na armadilha em "G"), e custa uma variável escalar por episódio.

**D. Gradiente de flood-fill como travão, não como recompensa.**
Como o motor conhece o labirinto, calcular D(c) = distância BFS à saída. Usar com peso baixo e apenas para desencadear as outras penalidades: passo que aumenta D face ao mínimo do episódio ativa o contador de Pledge (C) e conta como "sem progresso" para A e F. Evitar recompensa direta e forte por -D: becos que aproximam do objetivo atraem o fitness e prendem o agente em ótimos locais (deception documentada no hard maze de Stanley e Lehman).

**E. Bónus de cobertura e de caminho alternativo ("tentar outros caminhos").**
Bónus pequeno por primeira visita a uma célula (novidade), equivalente a bónus de contagem beta/sqrt(v(c)), e bónus extra quando o agente abandona um beco conhecido e escolhe uma bifurcação ainda não explorada (a regra 1 do Trémaux). Compensa a aversão natural à penalidade de revisita e impede que a seleção colete soluções que evitam o castigo parando de se mover.

**F. Corte de episódio por estagnação, com guarda anti-backtracking.**
Se nos últimos W passos (W ~ 4*N para labirinto NxN) não houve novo máximo de progresso nem aumento de cobertura, truncar o episódio com penalidade fixa e converter o orçamento restante em penalidade: elimina loops infinitos de avaliação e torna o loop antieconómico logo na seleção. Guarda importante: o primeiro retorno de um beco é backtracking legítimo (é o mecanismo que o Trémaux usa para resolver), portanto a penalidade só deve aplicar-se a revisitas sem progresso, e nunca ao primeiro retorno por uma aresta percorrida uma única vez; caso contrário pune-se exatamente o comportamento de exploração com garantia que se quer induzir.

## 4. Fontes

- Maze-solving algorithm (wall follower, Pledge, Trémaux, Tarry, dead-end filling, condições de falha com ilhas e saídas interiores): https://en.wikipedia.org/wiki/Maze-solving_algorithm
- Think Labyrinth: Maze Algorithms (tabela de garantias, memória, rapidez; Pledge, Chain, Trémaux, blind alley sealer): https://www.astrolog.org/labyrnth/algrithm.htm
- Pledge's Algorithm: How to Escape from a Dark Maze (contador de viragens, armadilha em "G"): https://zikaloai.medium.com/pledges-algorithm-8028f91748e7
- Tremaux's Algorithm (Jamis Buck, as 4 regras e a regra de voltar atrás): https://blog.jamisbuck.org/2014/05/12/tremauxs-algorithm.html
- Dictionary of Mathematical Eponymy: Trémaux's Algorithm (garantia de saída, sem garantia de caminho curto): https://www.flyingcoloursmaths.co.uk/dictionary-of-mathematical-eponymy-tremauxs-algorithm
- The Trick for Solving ANY Maze (wall following vs Trémaux, falhas com centro e não-simply-connected): https://www.curiositybox.com/blogs/inqs-corner/the-trick-for-solving-any-maze
- Maze-Solving Algorithms (Kids CodeCS, ilhas e pontes como modos de falha): https://kidscodecs.com/maze-solving-algorithms
- Exploring the Flood Fill Algorithm and Its Applications in Maze Solving (BFS garante caminho curto, uso em competições de robótica): https://dev.to/baloxhaziz/exploring-the-flood-fill-algorithm-and-its-applications-in-maze-solving-56nh
- Floodfill, Micromouse (IEEE UC Irvine, implementação flood-fill 16x16): https://ieee.ics.uci.edu/micromouse/floodfill.html
- Micromouse from scratch: Maze traversal (exploração, paredes, flood fill, caminho curto): https://medium.com/@minikiraniamayadharmasiri/micromouse-from-scratch-algorithm-maze-traversal-shortest-path-floodfill-741242e8510
- The Fastest Maze-Solving Competition On Earth (Veritasium, mapa de distâncias e atualização ao bater em paredes): https://www.youtube.com/watch?v=ZMQbHMgK2rw
- A Comprehensive and Comparative Study of Maze-Solving Algorithms (BFS vs flood fill por tamanho de labirinto): https://www.iosrjournals.org/iosr-jce/papers/Vol17-issue1/Version-4/E017142429.pdf
- Performance Comparison Robot Path Finding Uses Flood Fill (Wall Follower vs Pledge vs Flood Fill em robô): https://pdfs.semanticscholar.org/29ff/3a714d952c1fe22b25c2b205f96c4d2c948a.pdf
- A Review of Various Maze Solving Algorithms (BFS curto mas explora mais nós; DFS memória eficiente sem otimalidade): https://www.ijert.org/a-review-of-various-maze-solving-algorithms-ijertv15is020518
- Solving Mazes with AI Pathfinding Techniques: A* vs Tremaux (pré-condições do Trémaux): https://www.primaryobjects.com/2013/05/13/solving-mazes-with-ai-pathfinding-techniques-a-vs-tremaux
- Iterative deepening depth-first search (completude e otimalidade em grafos não pesados, eficiência de memória): https://en.wikipedia.org/wiki/Iterative_deepening_depth-first_search
- Count-Based Exploration with Neural Density Models (pseudo-contagens, bónus de exploração): https://proceedings.mlr.press/v70/ostrovski17a.html
- A Study of Count-Based Exploration for Deep Reinforcement Learning (Tang et al., bónus proporcional a 1/sqrt(N)): https://papers.neurips.cc/paper/6868-exploration-a-study-of-count-based-exploration-for-deep-reinforcement-learning.pdf
- Exploration-Guided Reward Shaping for Reinforcement Learning (NeurIPS 2022, bónus de contagem em shaping): https://proceedings.neurips.cc/paper_files/paper/2022/file/266c0f191b04cbbbe529016d0edc847e-Supplemental-Conference.pdf
- Comprehensive Overview of Reward Engineering and Shaping in RL (contagens em espaços discretos vs contínuos): https://arxiv.org/html/2408.10215v1
- Reinforcement Learning with Local Shaping Rewards (shaping local que não altera a política ótima): https://www.ifaamas.org/Proceedings/aamas2016/pdfs/p429.pdf
