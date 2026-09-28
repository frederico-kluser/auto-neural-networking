# 04 · Treino com limite de tempo: como obter o máximo de aprendizagem dentro de um orçamento N minutos

> Investigação de suporte à exigência do utilizador: "coloque um limite de tempo" e otimize
> TODO o pipeline para extrair o melhor resultado possível dentro desse orçamento.
> Domínio: aprendizagem sob orçamento de tempo/cómputo (anytime learning, Hyperband/successive
> halving, racing, extrapolação de curvas de aprendizagem, população vs gerações, currículo sob
> orçamento fixo, subamostragem de avaliação em neuroevolução).
> Nota terminológica: este documento não usa travessões longos.

## 1. Síntese

Com um teto de tempo, o objetivo deixa de ser "convergir" e passa a ser "maximizar a qualidade do
melhor indivíduo no instante T". Quatro ideias resumem toda a literatura da área:

1. **Nem todos os candidatos merecem o mesmo orçamento.** O resultado final depende de poucos
   indivíduos promissores; o resto é ruído que se deve eliminar cedo e barato (successive halving,
   Hyperband, racing). Empregar o mesmo esforço de avaliação em todos os indivíduos em todas as
   gerações é o desperdício dominante do nosso loop atual.
2. **Avaliar barato primeiro, caro só para quem chega ao fim.** A fidelidade da avaliação
   (quantos labirintos, quantos passos, quantas repetições) deve crescer ao longo do torneio, e não
   ser constante. A subamostragem de avaliação é o alavanca mais direta de ganho de tempo em
   neuroevolução.
3. **Uma curva de aprendizagem é previsível.** Os primeiros pontos de uma geração dizem muito sobre
   o valor final; extrapolar a curva (fitness do melhor por geração) e parar/promover cedo liberta
   orçamento para exploração. Também é o que permite decidir quando subir de nível no currículo.
4. **O algoritmo tem de ser "anytime":** a qualquer instante deve existir um incumbente (melhor até
   agora) pronto a devolver, com checkpoint e verificação exata; quando o relógio acaba, a resposta
   é o incumbente validado, nunca uma geração pela metade nem um "deu erro".

Regra prática transversal: **orquestrar o tempo em vez de o gastar**. Orçamento em wall-clock
repartido por níveis do currículo (40/35/25, por exemplo), margem reservada para validação final
(2 a 5%), e dentro de cada nível um torneio multi-fidelidade em vez de avaliação exaustiva.

O custo dominante do nosso motor é a avaliação, e ela é quadrática no lado do labirinto:

| Nível | maxSteps por episódio (cols × rows × 2) | Custo relativo por episódio |
| --- | --- | --- |
| 5×5 | 50 | 1× |
| 9×9 | 162 | 3,2× |
| 15×15 | 450 | 9× |
| 31×31 | 1922 | 38,4× |

Ou seja: **uma geração no topo do currículo custa dezenas de gerações no início**. Subamostrar e
racing valem muito mais nos níveis grandes, e é aí que o limite de tempo aperta primeiro.

## 2. Mecanismos (com referência)

### M1 · Alocação progressiva de orçamento: successive halving e Hyperband

Dado um orçamento total B, em vez de dar B/n a cada um de n candidatos, avalia-se muitos candidatos
com um orçamento mínimo e promove-se apenas a fração superior (tipicamente metade, ou 1/η),
aumentando o orçamento dos sobreviventes por um fator η. O **successive halving** garante que, ao
fim de cada escalão ("rung"), o esforço está concentrado nos candidatos indistinguivelmente
melhores. O **Hyperband** (Li et al., JMLR 2018) resolve o dilema "muitos candidatos com pouco
orçamento vs poucos candidatos com muito orçamento" correndo vários sucessive halvings com
diferentes pontos de partida (brackets), e relata acelerações acima de uma ordem de grandeza sobre
os métodos concorrentes. O **ASHA** (Li et al., 2019) torna a promoção assíncrona, o que evita que o
mais lento de cada escalão segure os restantes; ideia diretamente aproveitável quando os indivíduos
têm custos diferentes (labirintos grandes vs pequenos).

Aplicação genérica: o orçamento não é distribuído uniformemente; é distribuído em carreiras de
promoção com eliminação antecipada.

### M2 · Racing estatístico: F-Race e irace

O **F-Race** (Birattari, Stützle, Paquete e Varrentrapp, GECCO 2002) elimina configurações que,
avaliadas nas mesmas instâncias, são estatisticamente piores que as rivais; só as sobreviventes
recebem mais avaliações. O **irace** (López-Ibáñez et al., 2016) generaliza para corridas iteradas,
e a sua documentação traz duas lições diretamente transferíveis: (a) com orçamento em tempo
(`maxTime`), o próprio custo de uma execução deve ser estimado antes de gastar o resto (o irace
reserva 2% do orçamento para estimativa e recalcula-a depois de cada iteração); (b) o orçamento
adequado depende da dificuldade do cenário, por isso deve ser calibrado em execuções de aquecimento
e não fixado às cegas.

Aplicação genérica: dentro de uma geração, avaliar primeiro todos os candidatos no mesmo teste
barato e descartar os que ficam para trás com margem estatística (ou por regra determinista
equivalente), reservando os testes caros para o topo.

### M3 · Subamostragem e avaliação parcial (fitness aproximado)

A aproximação de fitness é uma área consolidada em computação evolutiva: ver o levantamento de
Jin (2005) sobre aproximação de fitness em computação evolutiva e Jin, Olhofer e Sendhoff (2002)
sobre otimização com funções de fitness aproximadas. Em neuroevolução, avaliar num subconjunto de
episódios/labirintos é um caso particular: o fitness torna-se ruidoso, mas o ruído é controlável e
conhecido (variância entre labirintos). Duas regras práticas da literatura: (a) subamostrar para
selecionar, mas **validar por amostragem completa** quem vai reproduzir ou ser campeão; (b) quando
há ruido, aumentar a amostragem só para os candidatos cuja diferença é menor que o ruido (que é
exatamente a ideia do racing do M2). O incremental evolution ("shaping") documentado em
neuroevolução (Lehman e Miikkulainen, Scholarpedia 2013) reforça que a avaliação pode começar
tarefa a tarefa (labirinto a labirinto, nível a nível) em vez de tudo de uma vez.

### M4 · Curvas de aprendizagem: extrapolação e paragem antecipada

Domhan, Springenberg e Hutter (IJCAI 2015) modelam a curva de aprendizagem como combinação de
funções paramétricas e antecipam o valor final de cada configuração, terminando cedo as que não
podem ganhar; relatam acelerações da ordem de 2× no ajuste de hiperparâmetros. Klein et al. (2017)
e Adriaensen et al. (NeurIPS 2023) melhoram a previsão com redes neurais Bayesianas e redes
ajustadas a dados anteriores (PFNs), e o benchmark de Adriaensen et al. (2024) mostra que a
extrapolação é fiável o suficiente para decidir paragens e alocações. A versão minimalista, que não
precisa de modelo nenhum, é a **paragem antecipada por estagnação**: se a melhoria das últimas k
gerações for estatisticamente nula, cortar a perda ou mudar de regime (no nosso caso: disparar
neurogénese ou subir de nível).

### M5 · Tamanho de população vs gerações sob orçamento fixo

Com orçamento fixo de avaliações B = P × G, população (P) e gerações (G) são intercambiáveis, mas
não equivalentes. A análise clássica de dimensionamento de populações (Goldberg, 1989) mostra que P
tem de ser suficiente para que a seleção distinga estruturas boas de más; populações pequenas
convergem depressa mas perdem diversidade (convergência prematura); populações grandes preservam
diversidade mas "gastam" avaliações em indivíduos que nunca serão promissores. Alander (1992)
encontrou óptimos empíricos de população relativamente baixos para muitos problemas, e trabalhos
recentes de dimensionamento em voo (population size on-the-fly) mostram que P deve variar ao longo
da corrida: crescer quando há estagnação, encolher quando há progresso rápido. Em orçamentos
curtos, a regra prática da área é: **preferir mais gerações com população moderada** para paisagens
suaves, e **aumentar P** quando o problema é multimodal/enganador ou quando a diversidade cai.

### M6 · Currículo sob orçamento fixo e avaliação subsamplada por nível

O currículo (Bengio et al., ICML 2009: começar pelo fácil melhora generalização e convergência;
Graves et al., ICML 2017: currículo automatizado) é particularmente valioso quando o orçamento é
limitado, porque converte um problema difícil em sucessões de problemas baratos. O trabalho empírico
recente em RL com currículo mostra que o ganho está em "alocar um orçamento fixo" por dificuldade e
que o maior benefício aparece nos níveis mais difíceis que ainda são aprendíveis. Para um limite de
tempo, isto traduz-se em duas decisões: (a) **quanto tempo gastar por nível** (fixar quotas, por
exemplo 40/35/25 do orçamento, com o último nível a herdar o que sobrar); (b) **quando subir**: subir
apenas quando o nível atual está resolvido (regra atual do motor) ou quando a curva estagna, nunca
por relógio cego, porque subir cedo demais desperdiça o que já foi aprendido.

## 3. IMPLICAÇÕES PARA O MOTOR

O nosso loop (demo/core/evolution.mjs e demo/web/src/worker/trainer.worker.js) já tem peças que a
literatura recomenda: avaliação rotativa de 1 labirinto por indivíduo (E18, `selectionOpts()`),
verificação exata do campeão em todos os labirintos (`evalSolved`), currículo 5→7→…→31 com
transferência de população e burst de neurogénese (`promoteLevel`), e um orçamento em gerações
(`remaining`). O que falta é o **orçamento em tempo** e a **alocação desigual do esforço de
avaliação**. Abaixo, itens acionáveis por ordem de impacto.

### I1 · Avaliação rotativa escalonada com racing (subamostragem multi-fidelidade)

Generalizar a E18 de "1 labirinto para todos" para um torneio por escalões dentro de cada geração:

- Escalão 1: cada indivíduo é avaliado em `k1 = 1..2` labirintos rotativos (barato; já existe).
- Escalão 2: só os indivíduos acima do limiar (ex.: melhor que a média, ou top 1/η com η = 2) são
  avaliados em mais `k2` labirintos.
- Escalão 3: só o top 2 ou 3 e o incumbente são avaliados em TODOS os labirintos do nível
  (`evalSolved` já faz isto para o campeão).
- A nota de seleção passa a ser a média dos labirintos que cada indivíduo viu, e o ranking é só
  usado para decidir quem recebe mais amostras; quem tem menos amostras nunca é descartado por
  diferença menor que a variância observada (regra de racing simplificada).

Ganho esperado: com P = 60 e M = 6 labirintos, a avaliação exaustiva custa 360 episódios por
geração; o esquema em escalões custa cerca de 60 + 20 + 6 = 86, ou seja, 4 a 5 gerações pelo mesmo
preço. Nos níveis 21×21 e 31×31, onde cada episódio custa até 38× o de 5×5, este mecanismo é o que
mais tempo devolve.

### I2 · Limite de tempo em wall-clock com paragem "melhor até agora"

- Acrescentar ao `tick()`/`runOneGeneration()` um `deadlineAt = Date.now() + budgetMs` (pedido
  também como mensagem `{ type:'run', budgetMs }`), verificado **entre indivíduos e entre gerações**,
  nunca a meio de um episódio (assim não se perde coerência do fitness).
- Reservar uma margem final (2 a 5% do orçamento) para: reavaliar o incumbente em todos os
  labirintos do nível atual, gravar checkpoint e emitir `done`.
- Quando o tempo acaba: parar no limite de geração seguinte, emitir `done` com
  `summary.solved`, `summary.best`, `summary.finalLevel`, `summary.reason: 'time'` e devolver o
  **melhor até agora** (a mensagem `best` já clona o campeão, portanto o estado válido existe).
- Checkpoint contínuo: gravar `{ net, fitness, gen, level, seed, timestamp }` a cada melhoria do
  melhor global (localStorage/IndexedDB via training-store), para retomar a corrida num segundo
  orçamento sem perder o que foi aprendido.

### I3 · Orçamento por nível do currículo e subida de nível consciente do tempo

- Repartir N minutos pelos níveis do currículo por quotas, com herança: ex. 40% para 5..9, 35% para
  11..19, 25% para 21..31, e o tempo não gasto acumula para o nível seguinte (o último nível tem
  direito a todo o excedente).
- Regra de subida (mantendo a atual "resolve todos os labirintos do nível"): acrescentar uma saída
  de emergência por estagnação. Se o melhor não melhorar durante k gerações OU a curva extrapolar
  para baixo, subir de nível com o que existe, e deixar o burst de neurogénese (`promoteLevel`)
  cobrir a transição.
- Regra inversa: se o tempo restante não chegar para um número mínimo de gerações no nível seguinte
  (calibrado pelo custo médio de geração desse nível), **não subir**; consolidar, validar o campeão
  nos maiores labirintos já conquistados e terminar.

### I4 · População vs gerações adaptativos ao tempo e ao nível

- Fixar o orçamento em **avaliações** e derivar G: `G = floor(avaliacoesDisponiveis / (P × k_medio))`.
- Começar com P moderada (ex. 40 a 60) e crescer P (ex. +25%, até um teto) quando o melhor global
  estagnar por j gerações (diversidade), reduzindo P quando a melhoria for rápida (mais gerações no
  mesmo tempo). Isto é o "population sizing em voo" adaptado ao nosso banco de operadores.
- Custo por geração deve ser estimado numa fase de aquecimento (2% do orçamento, à semelhança do
  irace) e reestimado a cada nível, porque o custo por episódio cresce com o quadrado do lado.

### I5 · Extrapolação da curva de aprendizagem para decisões de tempo

- Usar o histórico que já produzimos (`history`/`stats` com `best` e `mean` por geração) para
  estimar a tendência: regressão simples sobre as últimas j gerações, ou ajuste de uma potência.
- Três decisões automáticas a partir daí: (a) disparar o burst de neurogénese mais cedo quando a
  projeção for plana (encolher `STALL_K` de 25 para o valor que o tempo restante permite); (b) subir
  de nível; (c) mudar de regime de avaliação (aumentar k1 quando houver folga de tempo, reduzir
  quando faltar).
- Cuidado: não parar cedo demais em fases de "platô" naturais; exigir j gerações mínimas (ex. 10 a
  15) e melhoria relativa abaixo de um limiar antes de qualquer decisão de corte.

### I6 · Custo consciente da topologia e do modo de memória

- O episódio também fica mais caro com a rede crescer (mais neurónios/arestas, modo 'mapa' com
  `nIn = 12 + células`). Um teto de tempo deve penalizar o tamanho: dar menos gerações a indivíduos
  muito grandes ou exigir que o ganho de fitness compense o custo (fitness líquido = fitness −
  λ_tempo × custoEstimado).
- Antes de exportar o campeão, validá-lo sempre no nível alvo em todos os labirintos com o mesmo
  `evalSolved` atual: é a garantia de que o "melhor até agora" é realmente utilizável.

Ordem de implementação sugerida: I2 (paragem e checkpoint) → I1 (racing) → I3 (orçamento por
nível) → I4 → I5 → I6. I2 sozinho já cumpre a exigência do utilizador; I1 é o que mais qualidade
acrescenta dentro do mesmo tempo.

## 4. Fontes

- Hyperband: Li, Jamieson, DeSalvo, Rostamizadeh, Talwalkar. *Hyperband: A Novel Bandit-Based
  Approach to Hyperparameter Optimization*. JMLR 18 (2018).
  https://arxiv.org/abs/1603.06560 · https://www.jmlr.org/papers/volume18/16-558/16-558.pdf
- Successive halving/Hyperband explicado (brackets, rungs): https://2020blogfor.github.io/posts/2020/04/hyperband
- ASHA (promoção assíncrona, early stopping agressivo): Li et al., *A System for Massively Parallel
  Hyperparameter Tuning* (MLSys 2020). https://arxiv.org/pdf/1810.05934
- BOHB (Hyperband + otimização Bayesiana): Falkner, Klein, Hutter.
  https://ml.informatik.uni-freiburg.de/wp-content/uploads/papers/17-BayesOpt-BOHB.pdf
- F-Race: Birattari, Stützle, Paquete, Varrentrapp. *A Racing Algorithm for Configuring
  Metaheuristics* (GECCO 2002). https://www.semanticscholar.org/paper/A-Racing-Algorithm-for-Configuring-Metaheuristics-Birattari-St%C3%BCtzle/64247308dd5d534d37174feb6315043b233e49a8
  · visão geral F-Race e Iterated F-Race: https://link.springer.com/chapter/10.1007/978-3-642-02538-9_13
- irace (Iterated Racing, orçamento em tempo com estimativa de 2%): https://iridia.ulb.ac.be/irace/README.html
  · guia do utilizador: https://cran.r-project.org/package=irace/vignettes/irace-package.pdf
  · López-Ibáñez et al. 2016: https://doi.org/10.1016/j.orp.2016.09.002
- Domhan, Springenberg, Hutter. *Speeding up Automatic Hyperparameter Optimization of Deep Neural
  Networks by Extrapolation of Learning Curves* (IJCAI 2015).
  https://www.ijcai.org/Abstract/15/487
- Adriaensen et al. *Efficient Bayesian Learning Curve Extrapolation using Prior-Data Fitted
  Networks* (NeurIPS 2023). https://proceedings.neurips.cc/paper_files/paper/2023/file/3f1a5e8bfcc3005724d246abe454c1e5-Paper-Conference.pdf
- Adriaensen et al. *Learning Curve Extrapolation Methods: An Extensive Benchmark and a Promising
  Approach* (2024). https://ada.liacs.nl/papers/KieEtAl24.pdf
- Jin, Y. *A Comprehensive Survey of Fitness Approximation in Evolutionary Computation* (Soft
  Computing, 2005). https://www.tech.dmu.ac.uk/~syang/TF-ECiDUE/Jin-SC05.pdf
  · Jin, Olhofer, Sendhoff (IEEE TEVC 2002): https://www.honda-ri.de/pubs/pdf/1116.pdf
- Lehman, Miikkulainen. *Neuroevolution* (Scholarpedia, 2013): incremental evolution/shaping e
  avaliação por tarefas. http://www.scholarpedia.org/article/Neuroevolution
- Goldberg, D. E. *Sizing Populations for Serial and Parallel Genetic Algorithms* (ICGA 1989);
  Alander, J. T. *On Optimal Population Size of Genetic Algorithms* (1992).
  http://ieeexplore.ieee.org/iel2/405/5732/00218485.pdf
  · dimensionamento em voo: https://repository.ubn.ru.nl/bitstream/handle/2066/84529/1/84529.pdf
  · revisão (população vs custo computacional): https://pmc.ncbi.nlm.nih.gov/articles/PMC7599983
- Bengio, Louradour, Collobert, Weston. *Curriculum Learning* (ICML 2009).
  https://icml.cc/Conferences/2009/abstracts.html · https://doi.org/10.1145/1553374.1553380
- Graves et al. *Automated Curriculum Learning for Neural Networks* (ICML 2017).
  https://proceedings.mlr.press/v70/graves17a/graves17a.pdf
- Curriculum RL sob orçamento fixo (GRADIENT, NeurIPS 2022):
  https://papers.neurips.cc/paper_files/paper/2022/file/4556f5398bd2c61bd7500e306b4e560a-Paper-Conference.pdf
  · quando o currículo ajuda (CS224R):
  https://cs224r.stanford.edu/projects/pdfs/Louis%20de%20Germay%20de%20Cirfontaine%20Arthur%20Gontier%20submission_416269959/CS224R_Final_Report.pdf
- Algoritmos anytime: Fukunaga. *Genetic Algorithm Portfolios* (CEC 2000).
  https://metahack.org/Fukunaga-CEC-2000.pdf
  · seleção de algoritmos anytime (o incumbente é sempre devolvível):
  https://inria.hal.science/hal-02898962/document
  · definição e propriedades: https://www.opentrain.ai/glossary/anytime-algorithm
- Configuração de algoritmos anytime com AGGA (Schede et al., 2025):
  https://www.sciencedirect.com/science/article/pii/S0377221725005491
