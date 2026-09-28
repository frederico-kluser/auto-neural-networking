# 01: Como as sinapses surgem, ligam-se e guardam histórico de decisões

Investigação para o demo de agentes neurais em labirintos (12 sensores, grelha de slots leaky-tanh, pesos Hebbianos rápidos F, `addMemoryNeuron`, mutações estruturais `addConn`/`addNeuron`/`prune`). Pergunta central do utilizador: a memória tem de se construir sozinha, e os agentes têm de conhecer as suas decisões anteriores porque as sinapses emergem e se ligam para as codificar.

## 1. Síntese (o que a literatura diz)

A memória não é guardada em pesos isolados: é guardada em **mudanças físicas de sinapses que nascem, morrem e se agrupam em função da co-atividade recente**. Quatro ideias sustentam tudo o resto:

1. **A sinapse é criada por regras locais guiadas pela atividade, não por um orçamento central.** No modelo MSP de Butz e van Ooyen, cada neurónio cria espinhas dendríticas e boutões axonais quando a sua atividade média cai abaixo de um set-point homeostático, e elimina-os quando a atividade está acima do set-point ou abaixo de um mínimo; as sinapses formam-se pela fusão de espinhas e boutões que coexistem, e a formação depende apenas da atividade do próprio neurónio (https://anvooyen.home.xs4all.nl/network_formation.html; regra original em Butz & van Ooyen 2013, PLoS Comput Biol 9(10):e1003259, https://doi.org/10.1371/journal.pcbi.1003259). Ou seja: a estrutura que "conhece" o passado é um subproduto de material axonal/dendrítico que cresce onde a atividade foi persistente e recua onde não foi.

2. **A maioria das sinapses nasce silenciosa e só se torna funcional por coincidência.** Sinapses silenciosas têm receptores NMDA mas não têm AMPA inseridos; só quando há atividade pré-sináptica e despolarização pós-sináptica coincidentes se recrutam AMPA e a sinapse passa a transmitir (https://pubmed.ncbi.nlm.nih.gov/11487624; https://pmc.ncbi.nlm.nih.gov/articles/PMC2291097; revisão em http://www.scholarpedia.org/article/Silent_synapse). Isto significa que a criação de uma ligação e a sua ativação funcional são eventos separados: a ligação pode existir fisicamente muito antes de passar a carregar memória.

3. **A sinapse que participa numa experiência forte é "marcada" (tagged) e captura recursos partilhados que estabilizam o traço.** Frey & Morris (1997, Nature 385:533) mostraram que a marcação é local, transitória e independente de síntese de proteínas, e que as proteínas de plasticidade (PRPs) produzidas por estimulação forte podem ser capturadas por sinapses fracas próximas que estavam marcadas, convertendo LTP precoce (rápida e decaindo) em LTP tardia (estável) (https://www.nature.com/articles/ncomms2250; https://en.wikipedia.org/wiki/Synaptic_tagging; https://pmc.ncbi.nlm.nih.gov/articles/PMC11058361). A marcação é também a base do cross-capture entre sinapses vizinhas, que agrupa memórias relacionadas.

4. **Sequências de decisões ficam codificadas em cadeias de conjuntos de neurónios que disparam por ordem.** As synfire chains de Abeles (1982) são cadeias de pools que disparam em sequência precisa; em modelos, cadeias assim surgem sozinhas quando há regras de aprendizagem simples combinadas com plasticidade sináptica e normalização (Bienenstock: sincronia semeada em rede aleatória cria a cadeia, http://www.scholarpedia.org/article/Synfire_chain; desenvolvimento robusto a partir de STDP + plasticidade intrínseca + normalização em Zheng & Rüdiger 2014, https://pmc.ncbi.nlm.nih.gov/articles/PMC4074894). A reativação (replay) destas cadeias consolida a memória de sequências (https://pmc.ncbi.nlm.nih.gov/articles/PMC5305273).

Em conjunto: **sinapses emergem onde a co-atividade foi persistente, ficam silenciosas até a coincidência as recrutar, são marcadas durante eventos relevantes e capturam recursos que as estabilizam, e agrupam-se em cadeias que representam a ordem temporal das experiências**. É exatamente este o tipo de memória que se "constrói sozinha" e que regista decisões anteriores.

## 2. Mecanismos concretos (6)

1. **Synaptic tagging and capture (STC).** A estimulação forte ativa CaMKII local, marca a sinapse, e dispara CREB no núcleo, que gera PRPs; as sinapses marcadas capturam PRPs (inclusive de eventos distintos próximos no tempo, cross-tagging) e passam a L-LTP estável (Frey & Morris 1997; revisão Redondo & Morris, http://www.its.caltech.edu/~bio156/Papers/PDFs/2011%20Redondo.pdf; https://pmc.ncbi.nlm.nih.gov/articles/PMC11058361). A marca é transitória (minutos), o que cria uma janela de coerência temporal.

2. **Recrutamento de sinapses silenciosas (unsilencing).** Ligação anatómica existe primeiro (só NMDA); a co-atividade pré+pós insere AMPA em minutos e a sinapse passa a transmitir; atividade NMDA modesta até inibe a inserção constitutiva, garantindo que só coincidência forte ativa (https://pubmed.ncbi.nlm.nih.gov/11487624; https://pmc.ncbi.nlm.nih.gov/articles/PMC2291097).

3. **Regra simples de crescimento estrutural homeostático (Butz & van Ooyen 2013).** Cada neurónio cria espinhas/boutões quando a sua atividade média cai abaixo do set-point e elimina-os quando está acima; sinapses formam-se por fusão material independente da atividade, e o resultado reproduz a reorganização cortical após lesões retinianas (https://doi.org/10.1371/journal.pcbi.1003259; descrição do modelo MSP em https://www.fz-juelich.de/en/jsc/about-us/structure/simulation-and-data-labs/sdl-neuroscience/research/structural-plasticity). A implicação forte: o alvo da formação é a atividade do próprio nó, e a eliminação é o mecanismo que mantém a capacidade limitada.

4. **Agrupamento sináptico (clustering) e cross-capture.** Sinapses vizinhas no mesmo ramo dendrítico que são co-ativadas capturam os mesmos PRPs e formam clusters estruturais; o cluster ativa o dendrito de forma supralinear e torna-se a unidade do engram (Kastellakis et al. 2015, https://labs.neuroscience.mssm.edu/wp-content/uploads/2020/08/synpatic-clustering.pdf; revisão 2019, https://pmc.ncbi.nlm.nih.gov/articles/PMC6908852; Lee 2024, https://www.sciencedirect.com/science/article/pii/S1074742724001047).

5. **Alocação de memória por excitabilidade (Tonegawa lab).** Só 10 a 30% dos neurónios ficam no traço de uma memória; os mais excitáveis no momento do treino (CREB alto) são recrutados, e a janela de excitabilidade aumenta ligações entre memórias próximas no tempo (Zhou et al. 2009, https://mzhoulab.com/wp-content/uploads/2019/04/2009-Nature-Neuroscience.pdf; Yiu et al. 2014 e Mocle et al. 2024, sub-ensembles pré-configurados com maior conectividade funcional após treino, https://www.cell.com/neuron/fulltext/S0896-6273(24)00091-6; revisão https://pmc.ncbi.nlm.nih.gov/articles/PMC11058361). CREB também aumenta densidade de espinhas, ou seja, a alocação neuronal e a criação física de sinapses são o mesmo processo visto de dois lados.

6. **Dinâmica de espinhas e consolidação + cadeias de sequências.** A aprendizagem provoca um aumento transitório da formação de espinhas que deixa um traço duradouro na rede (Moczulska et al. 2013, https://pmc.ncbi.nlm.nih.gov/articles/PMC3831433; revisão Guo 2023, https://faseb.onlinelibrary.wiley.com/doi/full/10.1096/fj.202202166R). Em modelos computacionais, a criação orientada de sinapses entre grupos co-ativos produz cadeias que guardam a ordem dos eventos: synfire chains (http://www.scholarpedia.org/article/Synfire_chain), SORN com STDP+IP+normalização (https://pmc.ncbi.nlm.nih.gov/articles/PMC4074894), e replay de assemblies (https://pmc.ncbi.nlm.nih.gov/articles/PMC5305273; Buzsáki 2010, https://buzsakilab.com/content/PDFs/Buzsaki2010Neuron.pdf).

## 3. IMPLICAÇÕES PARA O MOTOR (acionáveis, mapeadas para F, addConn, addMemoryNeuron, bursts)

3.1. **Nascimento de sinapses guiado por co-atividade (mapeia para `addConn` + acumulador tipo F).** Manter para cada par de slots ativos um acumulador de coincidência `c_ij += h_i * h_j` (mesma matemática de F, mas sem exigir sinapse existente). Quando `c_ij` ultrapassa um limiar e não existe ligação, disparar `addConn(i, j)` com peso inicial quase nulo, sujeito a um orçamento de material por nó (número máximo de ligações, como o set-point de espinhas do modelo Butz/van Ooyen). Quem nunca ultrapassa o limiar nunca vira ligação: a estrutura só regista co-atividade real, logo o grafo é a memória física das decisões repetidas.

3.2. **Recrutamento de sinapses silenciosas (mapeia para `addConn` + F).** Toda a ligação criada nasce "silenciosa": existe topologicamente mas com efeito transmissor nulo ou residual. A ligação só ganha F quando há coincidência pré+pós dentro da mesma janela de decisão (porta de coincidência tipo NMDA: exige os dois lados ativos, não basta um). Passos de simulação sem recrutamento podem ativar um `prune` dirigido, como a eliminação homeostática. Isto separa "propor mutação estrutural" de "a ligação passou a contar", que é o que permite à topologia crescer primeiro e consolidar depois.

3.3. **Tagging e captura para consolidar sequências de decisões (mapeia para F decaído + `addMemoryNeuron`).** Em cada evento de decisão (burst de saída do agente), marcar (`tag = 1`, com decaimento lento) as sinapses ativas nos últimos k passos. O `addMemoryNeuron` funciona como o reservatório de PRPs: a sua auto-ligação 0.85 e leak lento dão atividade persistente que "captura" as tags da janela e converte os traços rápidos F (que decaem) num peso lento estável (`W_slow += PRP * tag`). Tags sem captura decaem como E-LTP. Assim a rota completa de decisões é estabilizada por cross-capture temporal: decisões adjacentes na mesma janela partilham o mesmo PRP e ficam ligadas entre si.

3.4. **Encadeamento de decisões (mapeia para `addNeuron`/`addConn` + bursts).** Tratar bursts sucessivos como sincronia semeada (Bienenstock): quando a mesma sequência de estados-decisão se repete, criar ligações dirigidas entre os slots das decisões consecutivas, formando uma cadeia tipo synfire que codifica a ordem. A cadeia permite ao agente "lembrar a decisão seguinte" a partir do estado atual: reativar o primeiro nó da cadeia reativa a sequência (replay). Evolutivamente, mutações que criam estas ligações merecem fitness por recompensa acumulada tardia, não só imediata.

3.5. **Clustering espacial de sinapses (mapeia para `addNeuron` local + `addConn` dirigido).** Viesar `addConn`/`addNeuron` para junto das ligações já ativas (novas ligações preferem pares no mesmo conjunto co-ativo), criando clusters que integram de forma supralinear e detetam padrões compostos dos 12 sensores. Clusters maiores significam memórias mais robustas a ruído de sensores, e o mesmo cluster pode suportar várias memórias próximas via cross-capture.

3.6. **Alocação por excitabilidade e janela de coerência (mapeia para `addMemoryNeuron` e escolha de nós).** O slot com maior atividade recente (mais "excitável") é o candidato natural a receber o próximo `addMemoryNeuron` (engram do episódio). Janelas de decisão próximas no tempo devem partilhar o mesmo nó de memória (ligação de memórias por janela de excitabilidade), o que liga espontaneamente memórias de segmentos consecutivos do labirinto. Nota: só uma pequena fração dos slots deve receber memória persistente (10 a 30% na biologia), para manter capacidade e evitar ruído.

Ordem de implementação sugerida: 3.2 primeiro (nasce silencioso, ativa por coincidência), depois 3.1 (orçamento de material + criação guiada por co-atividade), depois 3.3 (tagging + captura pelo `addMemoryNeuron`), e só depois 3.4 a 3.6 como refinamentos evolutivos.

## 4. Fontes

- Synaptic tagging and capture, Frey & Morris 1997 (Nature): https://www.nature.com/articles/ncomms2250 (estudo in vivo relacionado) e https://en.wikipedia.org/wiki/Synaptic_tagging
- Redondo & Morris, "Making memories last: the synaptic tagging and capture hypothesis": http://www.its.caltech.edu/~bio156/Papers/PDFs/2011%20Redondo.pdf
- Park & Kaang 2024, "Memory allocation at the neuronal and synaptic levels": https://pmc.ncbi.nlm.nih.gov/articles/PMC11058361
- Recrutamento de sinapses silenciosas por AMPA: https://pubmed.ncbi.nlm.nih.gov/11487624
- NMDA e unsilencing durante o desenvolvimento: https://pmc.ncbi.nlm.nih.gov/articles/PMC2291097
- Silent synapse (Scholarpedia): http://www.scholarpedia.org/article/Silent_synapse
- Butz & van Ooyen 2013, regra simples para espinhas e boutões: https://doi.org/10.1371/journal.pcbi.1003259
- Modelo MSP e regras homeostáticas (Van Ooyen lab): https://anvooyen.home.xs4all.nl/network_formation.html
- Structural plasticity (JSC, descrição do modelo por elementos sinápticos): https://www.fz-juelich.de/en/jsc/about-us/structure/simulation-and-data-labs/sdl-neuroscience/research/structural-plasticity
- Kastellakis et al. 2015, synaptic clustering within dendrites: https://labs.neuroscience.mssm.edu/wp-content/uploads/2020/08/synpatic-clustering.pdf
- Kastellakis et al. 2019, "Synaptic Clustering and Memory Formation": https://pmc.ncbi.nlm.nih.gov/articles/PMC6908852
- Lee 2024, "Clustering of synaptic engram": https://www.sciencedirect.com/science/article/pii/S1074742724001047
- Zhou et al. 2009, CREB e alocação de memória (Nature Neurosci): https://mzhoulab.com/wp-content/uploads/2019/04/2009-Nature-Neuroscience.pdf
- Mocle et al. 2024, excitability e ensembles pré-configurados (Neuron): https://www.cell.com/neuron/fulltext/S0896-6273(24)00091-6
- Moczulska et al. 2013, dinâmica de espinhas e memória (in vivo): https://pmc.ncbi.nlm.nih.gov/articles/PMC3831433
- Guo 2023, "Dendritic spine dynamics in associative memory": https://faseb.onlinelibrary.wiley.com/doi/full/10.1096/fj.202202166R
- Synfire chains (Scholarpedia, Abeles 1982): http://www.scholarpedia.org/article/Synfire_chain
- Zheng & Rüdiger 2014, desenvolvimento robusto de synfire chains (SORN): https://pmc.ncbi.nlm.nih.gov/articles/PMC4074894
- Chenkov et al. 2017, "Memory replay in balanced recurrent networks": https://pmc.ncbi.nlm.nih.gov/articles/PMC5305273
- Buzsáki 2010, "Cell Assemblies, Synapsembles, and Readers": https://buzsakilab.com/content/PDFs/Buzsaki2010Neuron.pdf
- Formação de sinapses novas em memória associativa (eLife): https://elifesciences.org/articles/87969
