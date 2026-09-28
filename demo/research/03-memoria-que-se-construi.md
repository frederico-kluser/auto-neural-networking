# Memória que se constrói sozinha: crescimento estrutural como armazenamento de experiência

Pesquisa de suporte ao demo de agentes neurais em labirintos (até 31x31, 12 sensores). Pergunta central: como obter memória cuja ESTRUTURA se constrói (neurónios e sinapses que aparecem para guardar experiência) em vez de alimentar dados como inputs externos.

## 1. Síntese

A ideia transversal a toda a literatura é: **a memória não se escreve num banco fixo, cresce-se**. Um mecanismo de crescimento decide, por sinais locais (erro de previsão, novidade, estagnação, reuso), onde e quando adicionar capacidade; o novo material nasce direcionado ao que ainda não está representado; e o material antigo é protegido ou podado para evitar interferência. Em detalhe:

1. **O gatilho é sempre um erro ou uma novidade.** Cascade-Correlation recruta uma unidade quando o erro estagna (Fahlman e Lebiere, 1990). A rede de alocação de recursos de Platt (1991) cria uma unidade quando um padrão é "inusitado" (distância ao centro mais próximo acima de limiar). O Growing Neural Gas insere um nó onde o erro quantização acumulado é máximo (Fritzke, 1994). A ART de Grossberg comete um neurónio novo quando nenhuma categoria existente corresponde ao input acima do limiar de vigilância. A neurogénese biológica é favorecida por novidade e por erro de previsão.
2. **O que se guarda é a exceção, não a média.** Cada unidade nova nasce congelada ou direcionada ao resíduo que a rede atual não explica (Cascade-Correlation maximiza a correlação com o erro residual; RAN guarda o padrão inusitado; GNG guarda o protótipo da região de pior erro). A capacidade é gasta onde há informação nova.
3. **A anti-interferência vem de três regras:** (a) congelar o que já funciona (pesos de entrada congelados no Cascade-Correlation, colunas congeladas nas redes progressivas, aprendizagem só em ressonância na ART); (b) separar fisicamente as memórias novas (neurónios imaturos como separadores de padrões, alocação por excitabilidade, clusters sinápticos); (c) podar o que não é reutilizado (idade das arestas no GNG, poda por contribuição).
4. **A capacidade tem custo e por isso é orçamentada.** Os modelos biológicos tratam a neurogénese como recurso escasso e regulado; a ART regula a proliferação de categorias com o limiar de vigilância; o GNG tem tamanho máximo. Crescimento sem poda e sem teto degenera.

Contraste que importa ter presente: nas Memory Networks (Weston et al., 2015) e no Differentiable Neural Computer (Graves et al., 2016; DeepMind) a memória é uma MATRIZ EXTERNA de tamanho fixo com leitura/escrita por atenção. A capacidade é pré-alocada e o que se aprende é o endereçamento. É poderoso, mas não é memória que se constrói: a estrutura não emerge da experiência, é cenário pré-montado. O nosso motor já faz a coisa certa ao fazer crescer a estrutura; o que falta é acoplar o crescimento aos sinais certos (novidade, erro de previsão, reuso) em vez de só à estagnação evolucionária.

## 2. Mecanismos (com referência)

### M1. Cascade-Correlation: recrutamento por estagnação do erro
- **Referência:** Fahlman e Lebiere, "The Cascade-Correlation Learning Architecture" (NIPS 1989 / CMU-CS-90-100, 1991); versão recorrente em NIPS 1990.
- **Gatilho de crescimento:** a treino dos pesos existentes estagnar (sem melhoria do erro). Então criam-se vários candidatos treinados para MAXIMIZAR a correlação absoluta entre a sua saída e o erro residual das saídas; o melhor candidato é recrutado e as suas ligações de saída são treinadas.
- **O que guarda:** uma feature residual que explica o que a rede ainda erra. Cada unidade nova liga-se em cascata a TODAS as anteriores, formando memória ordenada de abstrações sucessivas.
- **Como evita interferência:** os pesos de ENTRADA da unidade recrutada são CONGELADOS para sempre; as unidades antigas não são reabertas. A memória antiga fica literalmente intocável.

### M2. ART (Adaptive Resonance Theory): cometer um nó novo por mismatch
- **Referência:** Grossberg e Carpenter; ver Adaptive Resonance Theory (Wikipedia) e Grossberg, Neural Networks (2012).
- **Gatilho de crescimento:** comparação entre expectativa top-down (protótipo) e input bottom-up. Se o grau de correspondência fica abaixo do PARÂMETRO DE VIGILÂNCIA, o nó vencedor é inibido e procura-se outro; se nenhum nó comprometido passa, **compromete-se um neurónio novo** e ajusta-se ao input.
- **O que guarda:** um protótipo de categoria (um "padrão que já se viu"), com aprendizagem só enquanto há ressonância (match suficiente).
- **Como evita interferência:** o dilema estabilidade-plasticidade resolve-se por aprendizagem condicionada ao match: os protótipos existentes só mudam quando o input é suficientemente parecido; inputs novos nunca sobrescrevem categorias antigas, criam estrutura nova. A vigilância regula o equilíbrio (alta = memórias finas e muitas; baixa = memórias gerais e poucas).

### M3. Growing Neural Gas e RAN: crescimento dirigido pelo erro local e pela novidade
- **Referência:** Fritzke, "A Growing Neural Gas Network Learns Topologies" (NIPS 1994); Platt, "A Resource-Allocating Network for Function Interpolation" (Neural Computation, 1991).
- **Gatilho de crescimento:** GNG: a cada λ sinais, insere-se um nó junto do que acumulou MAIS erro, entre o nó de maior erro e o vizinho de maior erro. RAN: cria-se uma unidade quando o padrão é inusitado (distância ao centro mais próximo acima de um limiar decrescente) E o erro é significativo.
- **O que guarda:** um protótipo do espaço de estados (vetor de referência) e a topologia de vizinhança entre protótipos, criada por aprendizagem Hebbiana competitiva (ligação entre o vencedor e o segundo classificado, com idade que renova quando usada).
- **Como evita interferência:** a adaptação é LOCAL (só o vencedor e vizinhos diretos); arestas não usadas envelhecem e são removidas, levando consigo nós órfãos. O mapa renova-se sem reescrever as regiões estáveis.

### M4. Neurogénese computacional: novos neurónios para memórias novas
- **Referência:** Deng, "New neurons and new memories: how does adult hippocampal neurogenesis affect learning and memory?" (2010); Aimone e Gage, revisões de modelação de neurogénese; Butz e van Ooyen (2009), citados no próprio código de ops.mjs; Frankland e Josselyn, "Memory Allocation: Mechanisms and Function".
- **Gatilho de crescimento:** novidade, contexto emocional, erro de previsão e estresse regulam a taxa de nascimento de neurónios; modelos computacionais usam explicitamente erro de predição como sinal de "precisa-se de capacidade nova".
- **O que guarda:** memórias novas em neurónios recém-nascidos (imaturos), que atuam como separadores de padrões e como integadores de padrões antes da maturação. O efeito descrito é o de um PALIMPSESTO: sem novos neurónios, cada memória nova sobrescreve uma antiga; com neurogénese, há espaço para as novas sem apagar as velhas ("new neurons make room for new memories").
- **Como evita interferência:** material novo nasce VÍRGEM (sem pesos a reescrever), a alocação faz-se por excitabilidade (os neurónios mais excitáveis ganham a competição por entrar no engrama) e a imaturidade cria uma janela de plasticidade que fecha com a maturação, estabilizando o que foi guardado.

### M5. Alocação sináptica e clustering: o engrama cresce em aglomerados
- **Referência:** Kastellakis et al., "Synaptic Clustering and Memory Formation" (2019); Josselyn e Frankland sobre alocação de memória; Delamare et al. (2024) sobre excitabilidade e sobreposição de engramas.
- **Gatilho de crescimento:** co-ativação repetida de sinapses relacionadas; a formação de engramas é distribuída por mecanismos sinápticos E neuronais.
- **O que guarda:** associações (entre contexto, local e resultado) em aglomerados de espinhas dendríticas próximas, com ligações estruturais entre clusters que permitem relembrar uma memória a partir de outra ligada.
- **Como evita interferência:** memórias parecidas são alocadas a populações sobrepostas (memórias relacionadas ficam próximas e ligadas); memórias diferentes ficam em populações distintas (separação). O físico importa: sinapses do mesmo conjunto ficam juntas, protegendo-se mutuamente da sobrescrita.

### M6. Crescimento progressivo com congelamento: proteção por construção
- **Referência:** Rusu et al., "Progressive Neural Networks" (arXiv:1606.04671); revisão de continual learning (arXiv:1802.07569); Dynamic Network Surgery (Guo et al.) como poda/ligação dinâmica.
- **Gatilho de crescimento:** surgimento de tarefa ou contexto novo; acrescenta-se uma coluna/estrutura nova com ligações laterais para as anteriores.
- **O que guarda:** capacidade dedicada ao contexto novo, com leitura do conhecimento antigo através das ligações laterais.
- **Como evita interferência:** as colunas antigas são CONGELADAS; o conhecimento novo nunca entra nos pesos antigos. É o caso extremo de "memória que se constrói sem nunca reescrever", ao custo de crescimento linear por tarefa.

## 3. IMPLICAÇÕES PARA O MOTOR (regras acionáveis)

Mapeamento para os mecanismos existentes: mutações estruturais (`addConn`, `addNeuron`, `pruneNeuron`, `splitNeuron`, `removeConn`, `rewire`), `addMemoryNeuron` (célula auto-recorrente, W[self]=0.85, leak alphaJ=0.05), sinapses rápidas Hebbianas `F` (F_ij <- clip(lambda*F_ij + eta*h_i*h_j, +-2), reset por episódio) e o burst de neurogénese por estagnação (STALL_K=25 gerações, BURST_GENS=50, setBias({addNeuron: 2.5, addMemoryNeuron: 3})).

### R1. Gatilho de recrutamento por erro de previsão DENTRO do episódio (cascade correlation + RAN + prediction error)
Hoje o crescimento só é disparado por estagnação do fitness evolucionário. Acrescentar um gatilho por episódio: manter o erro de previsão do estado sensorial seguinte (12 sensores) dado o estado atual das células de memória. Quando a surpresa acumulada num trecho de labirinto exceder um limiar E durante W ticks consecutivos, disparar `addMemoryNeuron` de forma DIRECIONADA: escolher o input sensorial k com maior erro de previsão como fonte (em vez de `k` aleatório como em ops.mjs) e ligar a saída ao neurónio cujo estado mais contribuiu para o erro. Efeito: cada zona nova do labirinto (corredor inexplorado, bifurcação) recebe célula de memória própria; a rede constrói mapa de experiência por regiões.
Justificação: Platt (1991) só aloca quando o padrão é inusitado E errado; neurogénese é induzida por novidade/erro de previsão; o Cascade-Correlation recruta contra o erro residual.

### R2. Recrutamento com congelamento progressivo (anti-interferência de Fahlman)
Depois de `addMemoryNeuron` provar utilidade (aparece num elite por G gerações seguidas, ou recebe crédito positivo do banco), congelar as suas ligações de entrada: marcar o slot como "cristalizado" e excluí-lo de `perturbWeights`, `rewire` e `pruneNeuron` (e baixar muito a probabilidade de `splitNeuron` sobre ele). É a regra de "memória antiga intocável" do Cascade-Correlation e das redes progressivas, adaptada ao nosso conjunto de operações. O congelamento deve ser revogável por decaimento longo (ex.: após N gerações sem ser usado numa trajetória elite, o slot volta a ser plástico e pode morrer), para não engessar o teto de MAX_SLOTS=256.

### R3. Sinapses que multiplicam por reuso (Hebbian com consolidação em dois tempos)
Hoje `F` é do episódio e morre no reset. Acrescentar um terceiro tempo: (1) rápido: F como hoje; (2) médio: um contador de co-ativação c_ij por ligação estrutural (M[i][j]=1); (3) lento: quando c_ij ultrapassa K co-ativações, consolidar W_ij <- W_ij + c*F_ij médio (sinapse usada muitas vezes torna-se estrutural). O próprio eta pode ser modulado por c_ij (sinapses com mais reuso aprendem mais depressa, "multiplicação por reuso"). Poda simétrica: ligações estruturais com c_ij baixo durante muitos episódios são candidatas a `removeConn`. Justificação: aprendizagem Hebbiana competitiva do GNG cria/renova ligações por co-ativação; alocação sináptica mostra que sinapses repetidamente co-ativas se agrupam e estabilizam.

### R4. Estabilização de conjuntos (engram clusters no grafo)
Detectar conjuntos de neurónios de memória frequentemente co-ativos no mesmo episódio e marcá-los como CONJUNTO. Regras para conjuntos marcados: (a) `pruneNeuron` e `perturbWeights` com probabilidade dividida por um fator (ex.: 3x menos); (b) `addConn` preferencial dentro do conjunto (a probabilidade de escolher par dentro do conjunto multiplica-se por um fator); (c) `splitNeuron` permitido como via de crescimento do conjunto (Net2Net preserva a função e duplica a memória). Efeito: memórias relacionadas (a saída do labirinto X e a entrada do labirinto Y) ficam fisicamente próximas e protegem-se; é o clustering de Kastellakis traduzido em regras de mutação.

### R5. Vigilância para decidir entre reforçar e criar (ART)
Antes de disparar `addMemoryNeuron`, calcular a melhor correspondência entre o estado atual do episódio e a atividade das células de memória existentes (correlação ou distância). Se a correspondência >= rho (vigilância), REFORÇAR o conjunto existente (aplicar Hebb extra, sem criar nada). Se < rho, criar célula nova. rho controla a granularidade: alto dá muitas memórias finas (labirintos 31x31 precisam de rho alto), baixo dá poucas memórias gerais. Pode tornar-se parâmetro evolutivo ou adaptativo (descer rho quando o teto de slots se aproxima, subir rho quando há slots livres). Isto evita a proliferação de memórias redundantes, o risco principal de um motor de neurogénese livre.

### R6. Poda por idade e teto orçamentado (GNG)
Dar a cada ligação uma idade que renova a cada vez que a ligação é usada num tick (ativação real, não só existência); incrementar quando não usada; `removeConn` quando a idade passa de A_max; `pruneNeuron` em cascata para neurónios que fiquem sem ligações úteis (já temos heurística por contribuição; acrescentar idade como sinal). Manter o teto de MAX_SLOTS e o orçamento de crescimento: um burst (hoje 50 gerações de bias {addNeuron: 2.5, addMemoryNeuron: 3}) deve ser limitado em número de slots criados por burst (ex.: teto de 8 slots por burst) e terminar antecipadamente se o fitness voltar a melhorar, tal como a busca da ART desiste quando encontra match.

### R7. Sequência mínima recomendada (ordem de implementação)
1. R1 (gatilho por erro de previsão no episódio) com `addMemoryNeuron` direcionado ao sensor mais surpreendente.
2. R5 (vigilância como guarda de proliferação) junto com R1, para não rebentar o teto.
3. R3 (consolidação de F em W por reuso) para a memória deixar de morrer no reset do episódio.
4. R4 (conjuntos estáveis) e R6 (poda por idade) para estabilizar e libertar capacidade.
5. R2 (congelamento por elite) por último, porque engessa a evolução se aplicado cedo demais.

Os três mecanismos de maior impacto para o motor são R1 (gatilho de recrutamento por novidade/erro de previsão), R3 (sinapses que consolidam por reuso) e R4 (estabilização de conjuntos), seguidos de perto por R5 como regulador de custo.

## 4. Fontes

- The Cascade-Correlation Learning Architecture (Fahlman e Lebiere): https://www.cs.cmu.edu/~bhiksha/courses/deeplearning/Fall.2016/pdfs/cascor-tr.pdf
- The Recurrent Cascade-Correlation Architecture (NIPS 1990): https://papers.nips.cc/paper_files/paper/1990/file/fe73f687e5bc5280214e0486b273a5f9-Paper.pdf
- The Cascade-Correlation Learning Architecture (NIPS 1989): https://proceedings.neurips.cc/paper/1989/hash/69adc1e107f7f7d035d7baf04342e1ca-Abstract.html
- Adaptive Resonance Theory (visão geral de Grossberg e Carpenter): https://en.wikipedia.org/wiki/Adaptive_resonance_theory
- Grossberg, "Adaptive resonance theory: How a brain learns to consciously attend, learn, and recognize" (Neural Networks, 2012): http://clinique-autisme-asperger-mtl.ca/wp/wp-content/uploads/2015/03/Grossberg-2012.pdf
- Scholarpedia, Adaptive Resonance Theory (dilema estabilidade-plasticidade): http://www.scholarpedia.org/article/Adaptive_resonance_theory
- A Growing Neural Gas Network Learns Topologies (Fritzke, NIPS 1994): https://proceedings.neurips.cc/paper_files/paper/1994/file/d56b9fc4b0f1be8871f5e1c40c0067e7-Paper.pdf
- Growing Neural Gas, algoritmo completo (inserção por erro acumulado, idade das arestas): https://www.demogng.de/JavaPaper/node19.html
- Growing Self-organizing Networks (Fritzke, 1996): https://faculty.sites.iastate.edu/tesfatsi/archive/tesfatsi/GrowingSelfOrganizingNetworks.BFritzke1996.pdf
- A Resource-Allocating Network for Function Interpolation (Platt, 1991): https://pubmed.ncbi.nlm.nih.gov/31167310
- New neurons and new memories (Deng, 2010): https://pmc.ncbi.nlm.nih.gov/articles/PMC2886712
- Modeling new neuron function: a history of using computational models (Aimone e Gage): https://www.semanticscholar.org/paper/Modeling-new-neuron-function%3A-a-history-of-using-to-Aimone-Gage/32dcb6cf352ac43e5ab3e84ab11bc0853df75f5f
- New Neurons Make Room for New Memories (Scientific American): https://www.scientificamerican.com/article/new-neurons-make-room-for-new-memories
- Synaptic Clustering and Memory Formation (Kastellakis et al., 2019): https://pmc.ncbi.nlm.nih.gov/articles/PMC6908852
- The Quest for the Hippocampal Memory Engram (Frontiers in Behavioral Neuroscience, 2020): https://www.frontiersin.org/journals/behavioral-neuroscience/articles/10.3389/fnbeh.2020.632019/full
- Memory Allocation: Mechanisms and Function (Josselyn e Frankland): https://www.semanticscholar.org/paper/Memory-Allocation%3A-Mechanisms-and-Function-Josselyn-Frankland/b78668e1a96de5cade4166706191275c386d76dd
- Intrinsic Neural Excitability Biases Allocation and Overlap of Memory Engrams (Delamare et al., 2024): https://pmc.ncbi.nlm.nih.gov/articles/PMC11112642
- Is neurogenesis driven by prediction error?: https://psychology.stackexchange.com/questions/16400/is-neurogenesis-driven-by-prediction-error
- Prediction error and memory updating (Ofen, 2025): https://pmc.ncbi.nlm.nih.gov/articles/PMC12880735
- Continual Lifelong Learning with Neural Networks: A Review (paras neurogénese e plasticidade estrutural): https://arxiv.org/pdf/1802.07569
- Progressive Neural Networks (Rusu et al., 2016): https://arxiv.org/abs/1606.04671 (síntese: https://www.emergentmind.com/topics/progressive-neural-networks)
- Structural Plasticity Module: Dynamic Neural Networks: https://www.emergentmind.com/topics/structural-plasticity-module-spm
- Differentiable Neural Computer (DeepMind, memória externa como contraste): https://deepmind.google/blog/differentiable-neural-computers
- DNC, implementação de referência (memória externa de tamanho fixo): https://github.com/google-deepmind/dnc
- Lecture: Neural Networks with External Memory (Memory Networks e DNC como contraste): https://shubhendu-trivedi.org/files/CMSC-DLcourse/Lecture13_pauses.pdf
