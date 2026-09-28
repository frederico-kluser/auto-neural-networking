# 02. Histórico de decisões sem estado completo

**Tópico de investigação:** como é que agentes com observação parcial (12 sensores, sem
coordenadas, sem mapa, sem células) se lembram das suas PRÓPRIAS DECISÕES passadas.
**Âmbito:** literatura de traços de elegibilidade, fast weights, memória de trabalho em
POMDPs, controlo episódico, representação sucessora e histerese de política em navegação.
**Método:** 9 pesquisas web (Tavily) + leitura de fontes primárias (abstracts e capítulos).
Todas as afirmações abaixo têm URL na secção 4.

---

## 1. Síntese: como agentes guardam decisões passadas sem estado completo

Num POMDP a observação corrente não identifica o estado, e portanto a política ótima não é
reativa: depende do histórico (exemplo canónico: o T-maze, onde a decisão final depende da
primeira observação; ver AIhub/Eberhard 2025). O agente do nosso demo está precisamente
neste regime: 12 sensores locais são compatíveis com muitas células do labirinto, e a única
forma de desempatar é "o que já fiz / onde já passei". A literatura converge em cinco pontos:

1. **Copiar o histórico para as entradas não escala.** Janelas deslizantes de comprimento
   `m` exigem um número de amostras que cresce exponencialmente em `m`. Um trabalho recente
   (Eberhard, Muehlebach e Vernade, ICML 2025) mostra que um "memory trace", isto é, uma
   média móvel exponencial `z ← λ·z + (1-λ)·y`, resolve tarefas de corredor longo com custo
   polinomial, e que com `λ > 1/2` (esquecimento lento) os traços superam as janelas. Este
   é exatamente o formato da nossa sinapse rápida `F` e das células de atividade persistente.

2. **As sinapses podem ser a memória.** Ba, Hinton, Mnih, Leibo e Ionescu (2016) mostram que
   sinapses com dinâmica intermédia ("fast weights", mais lentas que a atividade e muito mais
   rápidas que os pesos) guardam memória temporária do passado recente e permitem "attention
   to the recent past" SEM copiar padrões de atividade para as entradas. Ou seja: é possível
   e desejável satisfazer o pedido "conhecer as decisões anteriores" dentro da rede, com os
   mesmos 12 inputs.

3. **O registo de "o que fiz" chama-se traço de elegibilidade.** Sutton (1984; Sutton e
   Barto, cap. 7) define o traço de elegibilidade como "a temporary record of the occurrence
   of an event, such as the visiting of a state or the taking of an action": um estado ou
   ação recente fica marcado como elegível para receber crédito. Mecanicamente é um
   acumulador com decaimento exponencial por evento, o que o torna o formato canónico para
   "histórico de decisões" dentro de uma rede.

4. **Células de atividade persistente implementam memória de trabalho.** Redes recorrentes
   com leak baixo e autoconexão forte sustentam atividade por dezenas a centenas de passos e
   resolvem tarefas de atraso sem qualquer input extra (Wei e Wang 2016; Cueva, Ardalan e
   Pehlevan 2021). A nossa operação `addMemoryNeuron` é precisamente esta célula.

5. **Memória de longo alcance usa dicionários episódicos ou mapas preditivos.** O controlo
   episódico (Blundell et al. 2016; Pritzel et al. 2017, "Neural Episodic Control") guarda
   experiências num buffer semi-tabular com escrita rápida e leitura por similaridade ("o que
   fiz quando vi isto"). A representação sucessora (Dayan 1993; Gershman 2018) guarda um mapa
   preditivo de ocupação futura de estados, aprendido por TD e equivalente, à luz da
   neurociência, a coding prospectivo aprendido por plasticidade dependente de tempo de spike
   (Brea et al. 2016); explica inclusive o aprendizado latente de Tolman em labirintos, sem
   recompensa.

6. **O horizonte de memória tem de casar com o comprimento da tarefa.** O fenómeno de
   "behavioral state decay" descreve exatamente o fracasso que queremos evitar: à medida que
   a trajetória cresce, o estado que devia guiar a ação (decisões anteriores, tentativas,
   sub-objetivos) deixa de influenciar o comportamento (arXiv:2607.08716). Num episódio de
   1922 passos (31x31) um traço com horizonte de 12 ticks é inútil; daí a correção já prevista
   no CONTRACTS (E16: `λ = exp(-1/H)` com `H = min(800, max(60, 2*openCells))`).

Conclusão operacional: "saber as decisões anteriores" não precisa de mais entradas; precisa
de (a) unidades que representem explicitamente a ação escolhida, (b) sinapses rápidas ou
células persistentes que mantenham a marca dessa ação durante o horizonte certo, e (c) um
mecanismo anti-loop de curto alcance (histerese de política) para os casos em que a decisão
repetida é precisamente o erro.

---

## 2. Mecanismos (6) e comparação

### M1. Traços de elegibilidade de ações (Sutton 1984; Sutton e Barto, cap. 7)
Acumulador por ação: `e_a(t) = γλ·e_a(t-1) + 1[ação_t = a]`. A ação recente fica "elegível" e
recebe crédito quando um erro de predição chega. Na visão backward, o traço é o registo
temporário do evento "tomar a ação", o que é literalmente o histórico de decisões em formato
diferenciável. Horizonte: `1/(1-γλ)`, ajustável por um escalar. Custo: O(nAções) por tick.
Adequação a labirintos grandes: alta, desde que λ case com o comprimento do episódio.

### M2. Fast weights Hebbianos (Ba et al. 2016; origem em Schmidhuber 1992)
Pesos com decaimento e regravação Hebbiana: `F_ij ← clip(λ·F_ij + η·h_i·h_j)`. Guardam o
passado recente nas sinapses, sem buffers e sem cópias de atividade nas entradas; os autores
mostram ganhos sobre RNN e LSTM em tarefas que exigem memória do passado recente. Horizonte:
`1/(1-λ)` ticks por entrada de F. Custo: O(pares mascarados) por tick. Adequação: muito alta;
é o mecanismo que o motor já implementa (E11).

### M3. Células de atividade persistente (memória de trabalho) (Wei e Wang 2016; Cueva et al. 2021)
Neurónio com autoconexão forte e leak baixo: `h ← (1-α)·h + α·tanh(...)`, com `α ≈ 0.05`
mantém atividade dezenas de passos e `α` menor estende o horizonte. É a memória de trabalho
recorrente que resolve tarefas de atraso em POMDPs. Horizonte: `~1/α` ticks, renovável por
novos impulsos. Custo: O(1) por célula. Adequação: alta, ideal para "a última decisão foi X".

### M4. Controlo episódico neural (Blundell et al. 2016; Pritzel et al. 2017)
Buffer semi-tabular: representações de estado lentas + estimativas atualizadas de forma
rápida, com escrita imediata da experiência e leitura por similaridade. É a memória de "o que
eu fiz/obtive quando estava neste contexto", aprendida em poucas experiências (aprendizagem
significativamente mais rápida que métodos gerais). Horizonte: todo o episódio (ou até o
buffer encher). Custo: O(d) por leitura/escrita mais memória O(buffer). Adequação: média; exige
um código de contexto estável derivado dos 12 sensores (hashing/quantização), que pode
aliasing em células parecidas.

### M5. Representação sucessora (Dayan 1993; Gershman 2018; Momennejad et al. 2017)
Mapa preditivo: cada estado é representado pela ocupação descontada dos estados futuros
esperados, aprendido por TD com erro de predição de ocupação. Ponto intermédio entre
model-free e model-based: eficiência do primeiro, flexibilidade do segundo perante mudanças de
recompensa; explica place fields do hipocampo e aprendizado latente em labirintos. Horizonte:
`1/(1-γ)` passos (multi-passo). Custo: O(n²) para a matriz completa, ou O(k) se fatorada num
pequeno banco de features. Adequação: média-alta para navegação, mas cara se implementada à
escala de todas as células.

### M6. Histerese e continuação de política, anti-loop (Sun et al. 2019, PCHID)
"Policy continuation": estender uma política de forma coerente de sub-espacos para espaços
maiores, com aprendizagem multi-passo a manter consistência entre decisões sucessivas (melhora
eficiência amostral em GridWorld e FetchReach). Na prática de navegação, isto traduz-se por
inércia de ação: preferir manter a decisão corrente e penalizar inversões bruscas, que é
precisamente o padrão dos loops (andar para trás, girar em ciclo). Horizonte: 1 a 3 ticks de
inércia; não memoriza o episódio, mas elimina a classe de erro mais frequente. Custo:
praticamente zero. Adequação: alta como complemento dos M1-M3.

### Tabela comparativa

| Mecanismo | Horizonte de memória | Custo por tick | Adequação (labirintos até 31x31) | Referência |
|---|---|---|---|---|
| M1 Traços de elegibilidade de ações | `1/(1-γλ)`, ajustável (10 a 2000+ ticks) | O(nAções) | Alta | Sutton 1984; Sutton e Barto cap. 7 |
| M2 Fast weights Hebbianos (F) | `1/(1-λ)` por par; hoje H≈800 (E16) | O(pares mascarados) | Muito alta (já no motor) | Ba et al. 2016 |
| M3 Atividade persistente (memória de trabalho) | `~1/α` ticks, renovável (20 a 200) | O(1) por célula | Alta | Wei e Wang 2016; Cueva et al. 2021 |
| M4 Controlo episódico neural | Episódio inteiro | O(d) + O(buffer) | Média (aliasing de contexto) | Blundell 2016; Pritzel 2017 |
| M5 Representação sucessora | `1/(1-γ)` passos (multi-passo) | O(n²) ou O(k) | Média-alta, cara | Dayan 1993; Gershman 2018 |
| M6 Histerese / continuação de política | 1 a 3 ticks | ~zero | Alta (anti-loop) | Sun et al. 2019 |

---

## 3. IMPLICAÇÕES PARA O MOTOR

O que já existe e serve de base (CONTRACTS E11, E12, E16):
`F` com `F_ij ← clip(λ·F_ij + η·h_i·h_j, ±2)` sobre a máscara `M`, peso efetivo `W+F`;
`addMemoryNeuron` com autoconexão `W_jj ≈ 0.85` e `alpha ≈ 0.05` (atividade persistente);
`memoryHorizon` com `λ = exp(-1/H)`; `resetNet` zera `h` e `F` por episódio; `cloneNet` copia
`F`; as 12 entradas fixas garantem transferência entre labirintos de qualquer tamanho.

### 3.1 Mecanismo principal: unidades de decisão dedicadas com `h` persistente a correr para dentro de `F`
Reservar 4 (ou 5) slots de "unidades de decisão" (↑, ↓, ←, →, e opcionalmente "parar"), ligadas
ao motor por um impulso: quando a rede escolhe a ação `a` no tick `t`, a unidade correspondente
recebe drive no tick `t+1` e, sendo célula `addMemoryNeuron`, mantém `h` elevado durante
`~1/α` ticks. Efeitos imediatos:
- A Hebbiana rápida passa a gravar co-ocorrência "ação `a` em contexto sensorial `c`": as
  entradas `F[i][a]` tornam-se o histórico de decisões legível pela própria rede, sem qualquer
  input novo (mantêm-se os 12 sensores).
- O sinal "o que acabei de fazer" entra no cálculo como estado interno, exatamente o pedido de
  "conhecer as decisões anteriores" por auto-memória.
- Implementação: as unidades de decisão são neurónios normais (entram em `M`, no update de `F`
  e no `ensureCapacity` como os restantes); o impulso de ação injeta-se em `drive` logo após a
  escolha da ação. Custo: 4 a 5 neurónios e ligações; `F` cresce para `(nSlots+5)²` mas só a
  máscara é atualizada (otimização E16 mantém-se).
- Para decidir a persistência: `alpha ≈ 0.05` dá constante de tempo de ~20 ticks; para lembrar
  a última decisão durante mais tempo, baixar `alpha` (0.01 dá ~100 ticks) ou usar
  autoconexão mais próxima de 1. Recomendação: 2 unidades de decisão por ação com `alpha`
  0.05 e 0.01, cobrindo curto e médio alcance.

### 3.2 Traços de elegibilidade de ação em duas escalas (anti-loop rápido + contexto lento)
Mapear o traço de Sutton diretamente no motor: `e_a ← λ_a·e_a + 1[ação = a]` é exatamente uma
unidade de memória com impulso constante enquanto a ação está ativa. Em vez de um λ único
(M2), usar duas escalas:
- `H_fast ≈ 8 a 16` ticks (`λ ≈ 0.90 a 0.94`): deteta "acabei de vir por aqui" e inversões
  recentes (↑↔↓, ←↔→), o material do anti-loop.
- `H_slow ≈ H` (o `memoryHorizon` do E16, hoje 800): contexto de episódio ("onde andei").
Custo: segunda matriz `F_fast` só sobre as linhas/colunas das unidades de decisão (4 a 5
linhas), ou simplesmente 4 a 5 células extras com `alpha` alto. Atenção ao horizonte do
episódio: em 31x31 com 1922 passos, `H=800` cobre cerca de 40% do episódio (o resto decai
abaixo de `1/e`); para histórico de decisões completo, usar `H = maxSteps` (`λ ≈ 0.9995`) ou
o banco multi-λ de 3.4.

### 3.3 Histerese de política: anti-loop de custo zero (M6)
Nas unidades de decisão, criar duas ligações estruturais (via `addConn`, que já permite
autoconexão):
- inércia: autoconexão positiva na unidade da ação corrente (`b_a ← b_a + κ·h_a(t-1)`),
  implementando "policy continuation": a decisão mantém-se coerente entre ticks;
- anti-inversão: quando o traço rápido da ação oposta está alto (`e_oposta_fast > limiar`),
  bias negativo sobre a ação oposta, quebrando ciclos de ida-e-volta.
Isto resolve a classe de erro mais cara em labirintos grandes sem qualquer memória extra, e a
evolução estrutural pode descobrir κ por conta própria se estas ligações forem colocadas à
disposição das mutações.

### 3.4 Representação sucessora compacta e banco multi-λ (fase 2)
Se as unidades de decisão e os traços não bastarem para loops de longo alcance:
- Em vez de uma matriz `M(s,s')` completa (cara), usar um pequeno conjunto de neurónios de
  memória cuja atividade aproxima `z ← λ·z + (1-λ)·y` sobre os sensores, com vários λ
  (por exemplo `H ∈ {16, 128, 800, 2000}`). Os "memory traces" de Eberhard et al. garantem que
  `λ > 1/2` (esquecimento lento) resolve corredores longos com custo polinomial e que o
  conjunto multi-λ dá resolução temporal em várias escalas sem janela deslizante.
- Entre essas células, a Hebbiana `F` aproxima coding prospectivo: Brea et al. (2016) provam
  equivalência entre plasticidade dependente de tempo de spike e representação sucessora, ou
  seja, um sub-grafo de neurónios de memória ligados por `F` é uma representação sucessora
  fatorada e barata ("mapa preditivo" do trajeto do agente). O caminho mais direto está
  demonstrado em ICLR 2025: "Learning Successor Features with Distributed Hebbian Temporal
  Memory" (DHTM) aprende representações sucessoras com memória Hebbiana distribuída, regras
  locais e operação totalmente online, com menos unidades de memória que alternativas.
- Controlo episódico (M4) só se necessário: um pequeno buffer externo indexado por contexto
  quantizado dos 12 sensores, com escrita por episódio. Custo de integração maior e risco de
  aliasing entre células parecidas; reservar como último recurso.

### 3.5 Regras de ouro de horizonte, reset e clonagem
- **Horizonte casado à tarefa:** `H` deve ser pelo menos o máximo de passos do episódio para
  memória de decisões completa; para anti-loop chega `H_fast ≈ 10`. Nada de um λ único "por
  defeito": derivar sempre de `H` (como já faz o E16).
- **`resetNet` zera `F` (correto):** o histórico de decisões é por episódio; manter. Se se
  quiser memória entre episódios, adicionar um canal lento separado (pesos `W`), nunca
  contaminar `F`.
- **`cloneNet` copia `F` (rever):** copiar a memória rápida de um indivíduo para o seu clone
  faz sentido (mesmo episódio de avaliação); na reprodução entre gerações, `F` a copiar
  atrapalha (o contexto mudou). Sugestão: `F` copiado só em avaliação, zeroado na reprodução.
- **Métricas de validação:** taxa de revisita de células, deteção de loops (sequência
  repetida de ações de período 2 ou 4), passos até resolução em 31x31, e comparação A/B com
  o modo 'sinapses' sem unidades de decisão.

### 3.6 Priorização: os 3 mecanismos mais fortes e acionáveis
1. **Unidades de decisão com `h` persistente a correr para dentro de `F`** (3.1): transforma o
   histórico de ações em estado interno legível pela rede, usando só mecanismos já existentes.
2. **Traços de elegibilidade de ação em duas escalas** (3.2): dão o "quando" da decisão
   (curto alcance para anti-loop, longo alcance para contexto de episódio) com custo marginal.
3. **Histerese de política por autoconexão e bias de inércia** (3.3): custo zero, elimina
   imediatamente a classe de loops mais frequente e prepara o terreno para os mecanismos 1 e 2.

---

## 4. Fontes

- Eberhard, Muehlebach, Vernade (ICML 2025), "Partially Observable Reinforcement Learning
  with Memory Traces": https://openreview.net/pdf?id=c4zVRwxjDD
- AIhub (2025), "Memory traces in reinforcement learning" (divulgação do anterior, T-maze):
  https://aihub.org/2025/09/12/memory-traces-in-reinforcement-learning
- Ba, Hinton, Mnih, Leibo, Ionescu (2016), "Using Fast Weights to Attend to the Recent Past":
  https://arxiv.org/abs/1610.06258 e https://www.cs.toronto.edu/~hinton/absps/FastWeights.pdf
- Sutton e Barto, "Reinforcement Learning: An Introduction", cap. 7 "Eligibility Traces":
  http://www.incompleteideas.net/book/ebook/node72.html
- Sutton (1984, 1988), TD learning e traços de elegibilidade (via Scholarpedia):
  http://www.scholarpedia.org/article/Temporal_difference_learning
- Tanner e Sutton (ICML 2005), "Temporal-Difference Networks with Eligibility Traces":
  https://icml.cc/Conferences/2005/proceedings/papers/112_TDLambdaNetworks_TannerSutton.pdf
- Blundell, Corneil, Lerchner (2016), "Model-Free Episodic Control":
  https://arxiv.org/abs/1606.04460
- Pritzel et al. (ICML 2017), "Neural Episodic Control":
  https://proceedings.mlr.press/v70/pritzel17a.html
- Dayan (1993), "Improving Generalisation for Temporal Difference Learning: The Successor
  Representation": http://www.gatsby.ucl.ac.uk/~dayan/papers/d93b.pdf
- Gershman (2018), "The Successor Representation: Its Computational Logic and Neural
  Substrates": https://pmc.ncbi.nlm.nih.gov/articles/PMC6096039
- Momennejad et al. (2017), "The successor representation in human reinforcement learning":
  https://pmc.ncbi.nlm.nih.gov/articles/PMC6941356
- Stachenfeld, Botvinick, Gershman (2017), SR e place cells (via Nature Sci. Rep. 2022):
  https://www.nature.com/articles/s41598-022-14916-1
- Brea, Gaál, Urbanczik, Senn (2016), "Prospective coding by spiking neurons" (STDP ≈ SR),
  citado em https://pmc.ncbi.nlm.nih.gov/articles/PMC6096039
- Sun, Li, Liu, Lin, Zhou (2019), "Policy Continuation with Hindsight Inverse Dynamics":
  https://arxiv.org/abs/1910.14055 e
  http://papers.neurips.cc/paper/9215-policy-continuation-with-hindsight-inverse-dynamics.pdf
- Cueva, Ardalan, Pehlevan (2021), "RNN models for working memory of continuous variables":
  http://www.columbia.edu/~nq6/publications/rnn-memory.pdf
- Wei e Wang (2016) e afins, dinâmica de atividade persistente em RNN (via OECS/MIT):
  https://oecs.mit.edu/pub/o3wg9y45
- "Remember When It Matters: Proactive Memory Agent for Long-Horizon Agents" (2026),
  behavioral state decay: https://arxiv.org/html/2607.08716v1 e
  https://github.com/yifannnwu/proactive-memory-agent
- Chandak et al. (2019), "Learning Action Representations for Reinforcement Learning"
  (embeddings de ações generalizam sobre ações):
  https://people.cs.umass.edu/~pthomas/papers/Chandak2019.pdf
- Recurrent policy gradients para POMDPs de memória profunda (Wierstra et al./ICANN 2007):
  https://www.idsia.ch/~juergen/icann2007recurrentpolicygradients.pdf
- Hefny et al., "Recurrent Predictive State Policy Networks" (belief state em POMDPs):
  https://personalrobotics.cs.washington.edu/publications/hefny2018rpsp.pdf
- Dzhivelikian, Kuderov, Panov (ICLR 2025), "Learning Successor Features with Distributed
  Hebbian Temporal Memory" (DHTM: memória episódica Hebbiana distribuída, totalmente online,
  com regras locais; suporte direto a 3.4):
  https://proceedings.iclr.cc/paper_files/paper/2025/file/1c71cd4032da425409d8ada8727bad42-Paper-Conference.pdf
