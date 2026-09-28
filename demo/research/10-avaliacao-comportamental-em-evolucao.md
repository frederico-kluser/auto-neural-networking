# 10. Avaliação comportamental em evolução: para além do fitness escalar, contra os ciclos

Pesquisa web sobre avaliação sensível a comportamento em computação evolutiva: novelty search e caracterização de comportamento, qualidade-diversidade (MAP-Elites, CVT-MAP-Elites), arquivos de novidade, métricas de distância comportamental em trajetórias (edit distance em sequências de ações, assinaturas de cobertura), seleção lexicase, fitness sharing e niching, e mecanismos anti-convergência (crowding, speciation) com efeito sobre loops comportamentais.

## 1. Síntese: como tornar a avaliação sensível a comportamentos cíclicos e a diversidade

O problema do demo: agentes neurais (até 31x31, 12 sensores, neuroevolução populacional com mutações estruturais) cuja avaliação tem de detetar loops e puni-los ("experimenta outros caminhos"), para que a seleção favoreça exploradores em vez de cicladores. Um fitness escalar não consegue fazer isto, por três razões documentadas na literatura:

1. **O fitness escalar colapsa comportamentos distintos no mesmo número, e o ciclo é um colapso que passa despercebido.** Um agente que oscila entre duas células com a saída em linha de visão mantém um valor de "distância ao objetivo" estável e aparentemente bom, embora zero de progresso. É a deceção do hard maze (Lehman e Stanley): a otimização objetiva é atraída para becos e atratores cíclicos locais. A avaliação tem de olhar para o que o agente fez (comportamento), não só para o quanto se aproximou do objetivo.
2. **A caracterização de comportamento (behavior characterization, BC) é o vocabulário da avaliação comportamental.** Novelty search define, para cada indivíduo, um descritor do comportamento executado (posição final, trajetória, cobertura de células, amostragens sensorimotoras ao longo do tempo) e mede novidade como distância aos k vizinhos mais próxidos num arquivo de comportamentos já vistos. Comportamentos cicladores têm descritores redundantes (revisitam as mesmas células, repetem as mesmas ações) e por isso são automaticamente "pouco novos": a punição de loops deixa de ser um termo ad hoc e passa a ser consequência da métrica.
3. **A diversidade tem de ser mantida por mecanismos de niching, não por sorte.** Sem partilha de fitness, crowding ou speciation, a população converge para o atrator cíclico dominante e a evolução estrutural passa a otimizar o loop em vez de o eliminar. Fitness sharing, MAP-Elites e seleção lexicase mantêm pressão seletiva sobre trajetórias diferentes, de modo que um mutante que quebra o ciclo (explorador) sobrevive e reproduz mesmo sendo pontualmente pior no fitness escalar.

Convergência prática da literatura: a avaliação deve ser vetorial ou baseada em casos (não um único escalar), o descritor de comportamento deve codificar explicitamente revisitas e periodicidade (para que loops sejam distinguíveis de exploração), e a seleção deve comparar indivíduos dentro de nichos comportamentais ou caso a caso, para que "experimentar outro caminho" seja o que a seleção recompensa.

## 2. Mecanismos (6)

### 2.1 Novelty search com arquivo de novidade (novelty archive)
A novidade de um indivíduo é a distância média aos k vizinhos mais próximos do seu descritor comportamental, quer na população atual, quer num arquivo persistente de comportamentos passados. O arquivo impede o retrocesso (redescoberta de comportamentos antigos) e é o mecanismo central para punir ciclos sem recompensa externa: um loop reproduz descritores já arquivados, logo tem novidade baixa. Os resultados clássicos mostram que novelty search resolve o hard maze enganoso onde o fitness por distância falha, e que o arquivo pode ter tamanho limitado sem perda significativa de desempenho (arquivo com substituição aleatória ou por célula). Extensões: novelty search com competição local (NSLC), que junta fitness dentro do nicho, e derivação sistemática de descritores (Gomes et al.; Meyerson et al. aprendem a caracterização).

### 2.2 MAP-Elites e CVT-MAP-Elites (niching comportamental por grelha)
O MAP-Elites discretiza o espaço de descritores comportamentais em células e guarda um único elite por célula (o melhor indivíduo daquele comportamento). Em vez de um ótimo único, "ilumina" o espaço: cobertura e QD-score substituem o fitness escalar como métrica de sucesso. É o modelo de niching comportamental mais simples de implementar e diretamente aplicável a loops: se o descritor incluir taxa de revisita ou contagem de ciclos, os cicladores ficam confinados a umas poucas células e os exploradores ocupam as restantes. O CVT-MAP-Elites (tesselação de Voronoi centroidal, centroides por k-means sobre amostras de comportamento) escala o mesmo princípio para descritores de dimensão maior sem grelha exponencial.

### 2.3 Distância comportamental em trajetórias (edit distance, assinaturas de cobertura)
Para comparar trajetórias é preciso uma métrica; Doncieux e Mouret (CEC 2010) sistematizam medidas genéricas baseadas só em valores sensorimotores e mostram que (a) sequências discretas de ações/estados comparam-se por edit distance (distância de Levenshtein) ou por variantes de custo, e (b) conjuntos de células visitadas comparam-se por medidas de cobertura (Jaccard, Hamming sobre grelha de visitas). As medidas genéricas classificam comportamentos de forma semelhante a juízes humanos e funcionam como objetivo de diversidade em NSGA-II. Também é documentado que a informação comportamental (behavioral information distance, Gomez 2009) sustenta diversidade melhor que distância genotípica. Para loops, a edit distance sobre sequências de ações e a autocorrelação/periodicidade da assinatura de visitas são exatamente os descritores que separam "explora" de "gira".

### 2.4 Seleção lexicase (e epsilon-lexicase)
A seleção lexicase escolhe pais filtrando a população caso a caso, em ordem aleatória de casos de fitness, mantendo só quem tem desempenho máximo (ou dentro de epsilon) no caso corrente. O resultado mais relevante aqui: lexicase produz diversidade comportamental excepcionalmente alta (superior a torneio e a seleção aleatória) e usa mais casos por seleção com epsilon-lexicase, com overhead computacional desprezável. Aplicação direta: cada caso é um episódio de labirinto (labirinto x tamanho x início/saída x semente) e um cíclico que só é bom num subconjunto de casos nunca domina a seleção; um explorador que resolve casos raros é sempre selecionável. É a forma mais barata de substituir um fitness agregado por avaliação multi-caso.

### 2.5 Fitness sharing e niching por similaridade
O fitness sharing divide o fitness de cada indivíduo pela densidade de vizinhos comportuais (partilha por similaridade fenotípica/comportamental dentro de um raio sigma), reduzindo o valor de soluções redundantes. Deterministic crowding e speciation (nichos por distância, como no NEAT) mantêm linhagens distintas vivas. Estes mecanismos atacam diretamente a convergência para atratores cíclicos: se muita população executa o mesmo loop, o fitness partilhado de cada cíclico cai e mutantes comportamentalmente distintos (mesmo que não melhores em escalar) ganham vantagem relativa. Custo típico O(P²) por geração em distância par a par, ou O(P·m) com amostragem.

### 2.6 Anti-convergência: competição local, surpresa e métricas de cobertura
A competição local do NSLC (comparar só indivíduos do mesmo nicho) premia qualidade sem sacrificar diversidade. A surprise search (otimizar o comportamento inesperado, não apenas o novo) mantém exploração quando a novidade satura, medindo entropia de posições visitadas. Métricas de exploração usadas em labirintos (Area Covered, Distance Traveled; entropia de posições visitadas) dão à avaliação um sinal de progresso verdadeiro que um loop não consegue inflacionar: um ciclo tem área coberta estagnada e distância percorrida alta, e a razão cobertura/distância é uma assinatura de loop por si só.

## 3. IMPLICAÇÕES PARA O MOTOR (concretas, com custo estimado)

**A. Caracterização de comportamento = assinatura de revisitas/loops (o núcleo).**
Substituir o fitness escalar por um descritor vetorial por episódio, calculado no motor durante a avaliação:
- `cobertura`: fração de células únicas visitadas / passos (ou histograma de visitas numa grelha grossa, ex. 8x8 sobre o 31x31);
- `taxa_de_revisita`: 1 - (células únicas / passos totais);
- `loop_score`: contagem de fechos de ciclo (detete quando a assinatura de 12 sinais + posição relativa repete com período k em 2..12, ou por sufixo repetido na sequência de ações discretizadas) e a razão comprimento_do_caminho / progresso_real (distância de flood-fill ao objetivo);
- `entropia_de_visitas`: entropia do histograma de visitas (posições visitadas com entropia baixa = pastagem/ciclo).
Custo: O(T) por episódio com tabelas hash de células e comparação de sufixos de comprimento limitado; T = passos do episódio (centenas). Desprezável face à simulação da rede.

**B. Arquivo de novidade com penalidade de ciclo (seleção sensível a loops).**
Novelty score = média das distâncias aos k=15 vizinhos mais próximos do descritor (A), na população atual mais um arquivo persistente (capacidade 1000 a 5000 descritores, substituição aleatória ou por célula de grelha grossa). Punição explícita: `f_ajustado = f_escalar * (1 - lambda * loop_score) + mu * novelty`, com lambda ~0.5 e mu calibrado para que novelty domine nas fases iniciais ("experimenta outros caminhos") e o escalar domine perto da convergência. Alternativa mais limpa: lexicar (ver C) em que loop_score é um caso negativo. Custo: O(P·k·A) por geração com força bruta (A limitado, P dezenas a centenas), ou O(P·log A) com kd-tree; tudo CPU, milissegundos.

**C. Seleção lexicase (ou epsilon-lexicase) sobre casos de labirinto.**
Casos de fitness = episódios distintos (labirinto, tamanho, par início/saída, semente de ruído), cada um com vetor de desempenhos: sucesso, progresso real (flood-fill), passos, cobertura, taxa_de_revisita. O lexicase filtra por caso em ordem aleatória, com epsilon adaptativo (mediana do desvio dos desempenhos do caso). Efeito esperado: cíclicos que só funcionam em casos fáceis são eliminados logo nos primeiros casos filtrados; exploradores consistentes em casos raros ganham linhagem. Custo: O(P·C) por seleção de pai (C = nº de casos por avaliação, ex. 8 a 32), linear e sem hiperparâmetros de pressão seletiva. É o mecanismo com melhor relação custo-benefício para "punir loops" sem termos de penalidade manuais.

**D. Nichos comportamentais para sobreviventes (crowding por descritor).**
Na substituição geracional, aplicar deterministic crowding ou torneio restrito por distância no descritor (A): um offspring só substitui o seu pai ou o vizinho comportual mais próximo. Efeito: duas variantes do mesmo loop não se eliminam mutuamente nem dominam; linhagens que quebram o ciclo sobrevivem mesmo sendo piores no escalar. Custo: O(P·m) com m adversários amostrados (m=5 a 10); alternativa de referência: fitness sharing O(P²) se P for pequeno.

**E. MAP-Elites leve como arquivo de elites (opcional, segunda fase).**
Grelha de comportamento com eixos (fração de cobertura x taxa_de_revisita), 10x10 células, elite = melhor f_escalar ajustado por célula. Dá um painel de "que comportamentos a evolução já encontrou" e um QD-score (soma dos elites + cobertura) como métrica de relatório em vez de "melhor fitness". Custo: O(1) por indivíduo (inserção em célula); CVT-MAP-Elites se a dimensão do descritor crescer (centroides por k-means prévio, custo único).

**F. Penalidades anti-loop na avaliação, não no sensor.**
Manter o agente com os 12 sensores atuais e impor as regras de ciclo no avaliador: (1) penalidade decrescente por revisita (1ª visita conta a favor, 2ª neutra, 3ª em diante negativa, imitando Trémaux sem mapa); (2) bónus de exploração por contagem de visitas `c / sqrt(n_visitas)` calculado pelo motor; (3) flag de episódio cíclico (loop_score acima de limiar) que rebaixa o indivíduo para o fundo do nicho, com mensagem de UI "experimenta outros caminhos". Custo: contadores por célula, O(T) total.

Ordem de implementação recomendada: A (descritor) e F (penalidades) primeiro, porque são avaliação pura e desbloqueiam tudo o resto; depois C (lexicase) que elimina a maior parte da pressão para ciclos a custo quase zero; B (arquivo de novidade) e D (crowding) para manter diversidade a médio prazo; E apenas para observabilidade e relatórios.

## 4. Fontes

- Lehman e Stanley, Abandoning Objectives: Evolution through the Search for Novelty Alone (hard maze, deceção, caracterização de comportamento): https://www.cs.swarthmore.edu/~meeden/DevelopmentalRobotics/lehman_ecj11.pdf
- Lehman, Evolution through the Search for Novelty (tese, arquivos de novidade e caracterizações): https://joellehman.com/lehman-dissertation.pdf
- Meyerson et al., Learning Behavior Characterizations for Novelty Search (GECCO 2016, descritores aprendidos, forest mazes): https://nn.cs.utexas.edu/downloads/papers/meyerson.gecco16.pdf
- Mouret e Clune, Quality Diversity: A New Frontier for Evolutionary Computation (visão geral QD, NSLC, MAP-Elites): https://www.frontiersin.org/journals/robotics-and-ai/articles/10.3389/frobt.2016.00040/full
- Mouret e Clune, Illuminating Search Spaces by Mapping Elites (arXiv 1504.04909): https://arxiv.org/abs/1504.04909
- MAP-Elites: Quality-Diversity Search (fórmulas de célula, cobertura, QD-score, emissores): https://www.emergentmind.com/topics/map-elites-algorithm
- Vassiliades, Chatzilygeroudis e Mouret, Using Centroidal Voronoi Tessellations to Scale Up MAP-Elites (CVT-MAP-Elites): https://inria.hal.science/hal-01630627/file/ieee_tec_voronoi_map_elites.pdf
- Página de referência de Quality Diversity (Mouret, niching comportamental, competição local): https://members.loria.fr/jbmouret/qd.html
- Lista de papers de Quality-Diversity (NSLC, MAP-Elites e variantes): https://quality-diversity.github.io/papers.html
- Doncieux e Mouret, Behavioral diversity measures for Evolutionary Robotics (CEC 2010; edit distance em sequências discretas, medidas de cobertura): https://hal.science/hal-00687641 e PDF https://hal.science/hal-00687641/document
- Helmuth e Spector, Lexicase selection for program synthesis: a diversity analysis (diversidade comportamental do lexicase): https://www.cs.hamilton.edu/~thelmuth/Pubs/2015-GPTP-lexicase-diversity-analysis.pdf
- La Cava e Spector, epsilon-lexicase selection for regression (epsilon adaptativo, mais casos usados): https://faculty.hampshire.edu/lspector/pubs/GECCO_lex_reg_preprint.pdf
- Effects of Lexicase and Tournament Selection on Diversity (comparação direta lexicase vs torneio): http://www.cmap.polytechnique.fr/~nikolaus.hansen/proceedings/2016/GECCO/companion/p983.pdf
- Gradient Lexicase Selection (lexicase em redes neurais, overhead baixo): https://arxiv.org/html/2312.12606v1
- Fitness Sharing (partilha de fitness, densidade de nichos, anti-convergência): https://algorithmafternoon.com/niching/fitness_sharing
- Petrowski, Fitness sharing and niching methods revisited: https://www.researchgate.net/publication/3418541_Fitness_sharing_and_niching_methods_revisited
- Niching in Evolutionary Algorithms (referência de niching e multi-modalidade): https://link.springer.com/rwe/10.1007/978-3-540-92910-9_32
- MAP-Elites e crowding como competição local (notas de implementação): https://szhaovas.github.io/2022-09-15-me
- Velez e Clune, Novelty Search Creates Robots with General Skills for Exploration (métricas Area Covered e Distance Traveled): http://www.cmap.polytechnique.fr/~nikolaus.hansen/proceedings/2014/GECCO/proceedings/p737.pdf
- Surprise Search: Beyond Objectives and Novelty (entropia de posições visitadas em maze): https://antoniosliapis.com/papers/surprise_search_beyond_objectives_and_novelty.pdf
- Novelty search (síntese wiki: caracterização por posição final em maze, arquivo de comportamentos): https://wiki.wfmlabs.org/wiki/Novelty_search
