# 09. Ciclos em políticas RL: porque aparecem atratores cíclicos e como quebrá-los

Pesquisa web sobre ciclos limite em políticas determinísticas (vista de sistemas dinâmicos), oscilação de ações em RL, ruído de ação e de parâmetros, regularização de entropia (SAC, Boltzmann), histerese e inércia de política, anti-chattering de teoria de controlo e randomização forçada ao detetar ciclo. Objetivo: o motor de avaliação deteta e pune ciclos (período-2, loops) para que a evolução explore alternativas.

## 1. Síntese: porque surgem ciclos em políticas determinísticas e como se quebram

**Um argmax policy num ambiente determinístico é um sistema dinâmico, e sistemas dinâmicos discretos terminam em atratores.** Com política determinística π e transições determinísticas, a trajetória de estados s(t+1) = T(s(t), argmax π(s(t))) é um mapa determinístico; as trajetórias convergem para pontos fixos (agente pára num beco) ou para ciclos limite estáveis (loops de período 2, 3, ...). Em RNNs, ciclos limite são atratores periódicos estáveis documentados e podem ser deformados por perturbações externas (Kanamaru 2013); a mesma lógica se aplica à dinâmica fechada (rede + labirinto). Num labirinto de grelha com aliasing sensorial (12 sinais, sem coordenadas), o ciclo de período 2 é o caso degenerado típico: duas células com assinaturas quase idênticas fazem a rede alternar as ações A e B (vai-e-vem), e o argmax fecha o loop de forma estável. **Sem estocasticidade não há saída espontânea do atrator**: a política gulosa reentra no loop para sempre, e qualquer recompensa que não penalize estagnação torna o ciclo um ótimo local do fitness.

**A oscilação também nasce de fronteiras de decisão finas.** Os trabalhos de RL para controlo mostram que políticas aprendidas trocam de ação por diferenças mínimas de estado ("action oscillation"): o agente seleciona ações diferentes em passos consecutidos embora os estados só difiram ligeiramente, o que em problemas com pontos críticos (fronteira entre duas regiões de ação) produz exatamente o comportamento ABAB mesmo com ruído pequeno (Chen et al., AAAI 2021; HyRL, de Priester et al. 2022). A teoria de controlo chama a isto chattering: comutação de alta frequência junto a uma superfície de deslize, causada por dinâmica não modelada e amostragem finita.

**Os mecanismos que quebram ciclos dividem-se em três famílias.** (a) Perturbação: ruído de ação (epsilon-greedy, Boltzmann/softmax com temperatura), entropia máxima no treino (SAC) e ruído persistente em espaço de parâmetros dão à trajetória energia para sair da bacia do atrator. (b) Inércia deliberada: histerese, inércia de política (Policy Inertia Controller) e bandas limite exigem uma vantagem mínima para mudar de ação, eliminando a oscilação por micro-diferenças. (c) Deteção e castigo explícito: detetar o ciclo (repetição de estados/ações, ausência de progresso), forçar uma ação alternativa por k passos, penalizar o fitness e cortar o episódio por estagnação; as recompensas de contagem de visitas tornam loops caros por construção. Em avaliações evolutivas, o ruído tem de ser determinístico por seed (reproduzível) e a robustez a seeds múltiplas expõe agentes que só funcionam no modo guloso.

## 2. Mecanismos (6)

### 2.1 Ruído de ação: epsilon-greedy e Boltzmann/softmax com temperatura
Ação aleatória com probabilidade ε (ou amostragem softmax com temperatura τ) é a forma mais direta de escapar a um ciclo: a perturbação empurra a trajetória para fora da bacia do atrator e, se houver recompensa por progresso, a nova trajetória pode dominar a antiga. Limites conhecidos: ε pequeno raramente visita ações suficientes quando o loop é longo (relatos de agentes presos em loop mesmo com ε-greedy), e softmax com temperatura fixa é sensível à escala dos Q-valores; o operador Boltzmann dinâmico (IJCAI 2020) ajusta a temperatura ao longo do treino para equilibrar exploração e exploração gulosa. Ação estocástica expressa até políticas multimodais (CleanRL/SAC), que é precisamente o que falta ao argmax.

### 2.2 Entropia máxima e regularização de entropia (SAC)
O SAC treina a política para maximizar retorno + entropia (coeficiente α), ligando explicitamente exploração a aleatoriedade: mais entropia, mais exploração (Spinning Up). A regularização de entropia previne convergência prematura a política determinística (Ahmed et al., ICML 2019, analisam o impacto da entropia na otimização de políticas e quando ela ajuda ou atrapalha). No nosso contexto evolutivo a entropia serve a dois níveis: (a) como bónus de fitness que premia políticas não degeneradas; (b) como diagnóstico, uma rede com saídas quase one-hot (entropia ≈ 0) é candidata a cíclica e merece mais ruído na avaliação.

### 2.3 Ruído persistente: espaço de parâmetros vs espaço de ação
O ruído de ação é i.i.d. passo a passo e produz exploração "branca", incoerente; o ruído em espaço de parâmetros (Plappert et al. 2017) perturba os pesos da rede uma vez por episódio, gerando um comportamento exploratório coerente e temporariamente determinístico, e aprende mais eficientemente que ruído de ação e evolutionary strategies. Para o motor: o equivalente prático é variar ligeiramente os pesos (ou uma máscara fixa sobre as ativações) por episódio/seed em vez de borbulhar ruído a cada passo; isso quebra ciclos de longo alcance mantendo a avaliação reproduzível.

### 2.4 Histerese, inércia de política e compromisso
O Policy Inertia Controller (PIC, AAAI 2021) é um módulo plug-in que penaliza mudanças de ação e equilibra otimalidade e suavidade, reduzindo oscilação com quase nenhuma perda de desempenho (em condução autónoma e Atari). O HyRL (de Priester et al. 2022) mostra que PPO e DQN produzem políticas não robustas a pequeno ruído de medição junto a pontos críticos (a trajetória oscila entre "esquerda" e "direita" e cracha) e resolve-o com comutação por histerese num sistema híbrido: só se muda de modo quando a evidência ultrapassa um limiar. Regra transferível: exigir uma vantagem mínima Δ (margem) para trocar de ação face à ação anterior, ou manter a ação atual durante m passos salvo melhoria clara, elimina o vai-e-vem de período 2 por construção.

### 2.5 Anti-chattering de teoria de controlo (banda limite, saturação)
No controlo por modos deslizantes, a comutação descontínua (sign) provoca chattering; as mitigações padrão são substituir o sign por uma aproximação contínua (sat, tanh) dentro de uma banda limite à volta da superfície de deslize, com custo de erro residual proporcional à espessura da banda (Kachroo e Tomizuka 1996; MathWorks SMC). Analogia direta para políticas discretas: suavizar a decisão junto à fronteira de argmax (exigir margem entre o melhor e o segundo melhor logit, ou desempatar por histerese em vez de por ordem fixa) troca oscilação por um pequeno viés estável, que é a troca certa quando o castigo por ciclo é alto.

### 2.6 Detecção de ciclo + randomização forçada e penalização (família Pledge e contagem de visitas)
Os algoritmos clássicos de labirinto tratam loops como caso a detetar e a quebrar explicitamente: o algoritmo de Pledge mantém um contador de ângulo acumulado e escapa a armadilhas/loops mesmo começando no interior do labirinto, e o wall follower só falha quando há paredes desconexas (Wikipedia, Maze-solving). Do lado do RL, recompensas de contagem de visitas e memória episódica penalizam revisitas e evitam comportamento repetitivo (curiosity-driven RL do Google, "not in memory" como novidade; E3B estende bónus episódicos a espaços contínuos; Tang et al. em pseudo-contagens). A síntese para avaliação evolutiva: detetar o ciclo pela repetição da assinatura (estado, ação), forçar uma ação alternativa por k passos (segunda melhor saída ou ação por PRNG semeado), e cobrar no fitness cada passo gasto em ciclo.

## 3. IMPLICAÇÕES PARA O MOTOR (acionáveis)

**A. Detector de ciclo dentro do runEpisode (O(1) por passo).**
Manter um buffer circular das últimas W assinaturas `sig_t = hash(célula ou vetor de 12 sinais quantizado, ação_t)`, com W = 64. Deteções: (1) período p ∈ {1..4}: `sig_t == sig_{t-p}` para todos os últimos p·q passos (q = 2 repetições chegam para o caso ABAB); (2) estagnação: mesma célula visitada ≥ 3 vezes na janela W, ou passos sem diminuir a distância/sem nova célula ≥ S_max (ex. 48). Registar por episódio: `n_ciclos`, `L_ciclo` (passos em ciclo), `p_dominante` (o p=2 do demo deve aparecer como métrica própria).

**B. Ao detetar ciclo: quebrar, cobrar e cortar (política Pledge-like).**
(1) **Quebrar**: forçar uma ação alternativa por k = 8 passos: preferir a segunda melhor saída da rede (mantém coerência da política) e, se não houver alternativa útil, ação por PRNG com seed derivada de `(episode_seed, step)`; durante esses k passos proibir reentrar na célula que iniciou o ciclo (marca de curto prazo tipo Trémaux). (2) **Cobrar**: penalidade de ciclo no fitness, `pen = α·L_ciclo + β·n_reincidências`, com α ≈ 0.02 a 0.05 por passo em ciclo (ajustar à escala do fitness) e β crescente (ex. 0.5, 1.0, 2.0) para punir reincidência mais que duração. (3) **Cortar**: terminar o episódio por estagnação após M = 3 ciclos detetados, atribuindo o fitness parcial já penalizado; evita gastar avaliação num agente que nunca sai do atrator.

**C. Ruído determinístico por seed na avaliação (reproduzível e revelador).**
ε(t) gerado por PRNG rápido (xorshift/PCG) semeado com `(run_seed, episode_id)`, ε_base ≈ 0.05, elevado para ≈ 0.25 durante os k passos de pós-deteção. Avaliar cada indivíduo em duas condições: gulosa (argmax puro) e com ruído; `fitness = min(f_guloso, f_ruido) - pen_ciclos`, ou média sobre S = 3 seeds de ruído menos castigo pelo desvio-padrão. Isto pune os agentes que só parecem bons no argmax e colapsam com qualquer perturbação, que é exatamente a assinatura de uma política apoiada num atrator cíclico frágil.

**D. Histerese e inércia no próprio runEpisode (anti-período-2).**
Exigir uma margem Δ (ex. 5 a 10% do intervalo dos logits/Q) para mudar de ação face à ação anterior: se `a_t-1` ainda estiver entre as duas melhores saídas e a melhor não a superar em Δ, manter `a_t-1`. Alternativa mais barata: manter a ação escolhida durante m = 2 a 3 passos salvo colisão imediata (o sensor de 12 sinais deteta parede à frente). É o equivalente discreto da banda limite do sliding mode e do PIC: pequeno viés de continuidade em troca de eliminação da oscilação; com castigo de ciclo ativo, a troca favorece sempre a estabilidade.

**E. Tornar ciclos caros por construção (prevenção).**
Custo por passo (já recomendado em 05) + penalização de revisita por contagem de visitas à célula (`-c·n_visitas`, c pequeno mas não nulo) + bónus de cobertura de células novas (novelty por contagem): um loop deixa de ser ótimo local porque cada volta perde fitness e nenhuma traz recompensa nova. Isto transfere para o fitness a lição dos métodos de curiosity/contagem: "não estar na memória" é a novidade que puxa a exploração.

**F. Diagnóstico e hiperparâmetros a reportar.**
Por geração: entropia/variância das saídas da rede (entropia ≈ 0 + ciclos ⇒ aumentar ε adaptativamente, como a temperatura automática do SAC), taxa de passos em ciclo, período dominante, passos até ao primeiro ciclo e ganho do fitness com/without ruído. Valores iniciais sugeridos: W = 64, P_max = 4, k = 8, M = 3, S = 3 seeds, Δ = 0.05 (fração do intervalo de logits), ε_base = 0.05. Ajustar α da penalidade para que um ciclo de período 2 com L = 30 passos custe mais do que o ganho típico de se aproximar do objetivo por um beco, senão a evolução continua a coletar ciclos.

## 4. Fontes

- Deformation of Attractor Landscape via Cholinergic Activation (ciclos limite estáveis em RNNs, atratores deformáveis por perturbação): https://pmc.ncbi.nlm.nih.gov/articles/PMC3543278
- Soft Actor-Critic, Spinning Up (regularização de entropia, troca exploração/exploração): https://spinningup.openai.com/en/latest/algorithms/sac.html
- Understanding the Impact of Entropy on Policy Optimization (Ahmed et al., ICML 2019): https://proceedings.mlr.press/v97/ahmed19a/ahmed19a.pdf
- Soft Actor-Critic (CleanRL): política estocástica multimodal e coeficiente α de entropia: https://docs.cleanrl.dev/rl-algorithms/sac
- Entropy-Regularized Reinforcement Learning Explained (bónus de entropia e soft Q-learning): https://towardsdatascience.com/entropy-regularized-reinforcement-learning-explained-2ba959c92aad
- Reinforcement Learning with Deep Energy-Based Policies (Haarnoja et al., Boltzmann exploration): https://proceedings.mlr.press/v70/haarnoja17a/haarnoja17a-supp.pdf
- Softmax Action Selection, Sutton e Barto (temperatura, limite guloso): http://incompleteideas.net/book/first/ebook/node17.html
- Reinforcement Learning with Dynamic Boltzmann Softmax (temperatura dinâmica, IJCAI 2020): https://www.ijcai.org/proceedings/2020/0276.pdf
- An Alternative Softmax Operator for Reinforcement Learning (exploração on-policy e softmax): https://arxiv.org/pdf/1612.05628
- Parameter Space Noise for Exploration (Plappert et al. 2017, ruído de parâmetros vs ação): https://arxiv.org/abs/1706.01905
- Better exploration with parameter noise (OpenAI, ruído coerente por episódio): https://openai.com/index/better-exploration-with-parameter-noise
- Parameter Space Noise, Advanced RL (síntese): https://apxml.com/courses/advanced-reinforcement-learning/chapter-4-advanced-exploration-strategies/parameter-space-noise
- Addressing Action Oscillations through Learning Policy Inertia (PIC, AAAI 2021, Chen et al.): https://ojs.aaai.org/index.php/AAAI/article/view/16864 (DOI: https://doi.org/10.1609/aaai.v35i8.16864)
- Hysteresis-Based RL: Robustifying RL-based Control Policies via Hybrid Control (HyRL, pontos críticos, ruído de medição, comutação com histerese): https://arxiv.org/abs/2204.00654 (HTML: https://arxiv.org/html/2204.00654v1)
- Addressing Action Oscillations (PDF AAAI): https://cdn.aaai.org/ojs/16864/16864-13-20358-1-2-20210518.pdf
- Chattering Reduction and Error Convergence in the Sliding-Mode Control (banda limite e controlo contínuo, Kachroo e Tomizuka 1996): https://oasis.library.unlv.edu/cgi/viewcontent.cgi?article=1034&context=ece_fac_articles
- Sliding Mode Control (chattering, quasi-sliding mode, saturação, MathWorks): https://www.mathworks.com/help/slcontrol/ug/design-sliding-mode-control-reaching-law.html
- Chattering in sliding mode control systems with boundary layer approximation (análise de eliminação de chattering): https://www.scilit.com/publications/cecabb35ddf3d534acc0d6f664d5f1a4
- Maze-solving algorithm (wall follower, Pledge com contador de ângulo, Trémaux): https://en.wikipedia.org/wiki/Maze-solving_algorithm
- Count-Based Exploration (contagem de visitas vs epsilon-greedy em espaços grandes): https://apxml.com/courses/advanced-reinforcement-learning/chapter-4-advanced-exploration-strategies/count-based-exploration
- Curiosity and Procrastination in Reinforcement Learning (memória episódica, "not in memory" como novidade, Google): https://research.google/blog/curiosity-and-procrastination-in-reinforcement-learning
- E3B: Exploration via Elliptical Episodic Bonuses (bónus episódicos em espaços contínuos): https://e3bagent.github.io
- Curiosity in Hindsight: Intrinsic Exploration in Stochastic Environments (paradigmas de novidade, contagens, memória episódica, ICML 2023): https://proceedings.mlr.press/v202/jarrett23a/jarrett23a.pdf
- ETA-Hysteresis-Based Reinforcement Learning (histerese para evitar oscilação de decisão): https://www.mdpi.com/2571-5577/9/1/7
- Evaluation-Time Policy Switching for Offline RL (mecanismo de comutação de política na avaliação, AAMAS 2025): https://www.ifaamas.org/Proceedings/aamas2025/pdfs/p1520.pdf
