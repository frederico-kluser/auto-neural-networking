# TRAVAS.md — travas permanentes e protocolo de pesquisa quando trava

Regras OBRIGATÓRIAS para todo o trabalho neste projeto (agente pai, subagents, probes, testes).
Criadas em 2026-09-27 após loops sem limite (smoke-worker a 98% CPU durante 10 min; 5 probes
de evolução sem timeout a correr 25+ min).

## 1. Travas de processo (nunca correr sem)

1. **Todo o comando de trabalho corre com `timeout` de parede** como PRIMEIRO wrapper:
   `timeout 600 node ...` (máx. recomendado 900 s). Nada de `until solved`, `while true` ou
   caps de gerações acima de 2000 em processos de teste.
2. **Probes de desempenho/aprendizagem**: máx. **2 variantes** por ronda, **máx. 10 min cada**
   (`timeout 600`), escritos com saída parcial por linha (para se poder travar a meio e aproveitar).
3. **Nunca lançar mais de 2 processos pesados em simultâneo** (1 preferível). Antes de lançar:
   `ps --sort=-%cpu | head` para confirmar que não há nada órfão.
4. **Subagents**: todo o prompt de trabalho TEM de incluir o limite de tempo da tarefa e a regra
   "se o tempo se esgotar, entrega o resultado parcial + o que falta". Um subagent não pode
   lançar trabalhos sem `timeout`.
5. **Fecho obrigatório**: ao fim de qualquer ronda, `ps` tem de mostrar zero processos do projeto
   além do servidor da demo.

## 2. Travas de tentativas (nunca iterar sem limite)

- **2ª tentativa** falhada no mesmo problema → PARA. Não há 3.ª tentativa silenciosa.
- Cada problema tem um orçamento máximo de **3 rondas de trabalho** (tentativa + correção +
  verificação conta como 1 ronda). Esgotadas as rondas → decidir: entregar como está com
  limitação documentada, ou apresentar opções ao utilizador.

## 3. Protocolo PESQUISA QUANDO TRAVA (configurado, não improvisar)

Quando uma tentativa falha OU um número medido contraria a expectativa (ex.: treino não vence):

1. **Diagnóstico dirigido** (máx. 10 min): reproduzir o caso mínimo, identificar a causa com
   evidência (números, grelhas, traces). Sem evidência não há hipótese.
2. **Onda de pesquisa** (máx. 20 min): **2 a 5 subagents**, cada um com `/tavily-agent-skill`
   (máx. 5 queries espaçadas 15 s; fallback `web_fetch` de fontes primárias). Cada um entrega
   `demo/research/NN-tema.md` com: síntese, mecanismos com URL, **IMPLICAÇÕES ACIONÁVEIS**
   mapeadas aos mecanismos do motor. Ângulos obrigatórios: mecanismo alternativo, falhas
   conhecidas do nosso enfoque, números de referência/benchmarks, orçamento de tempo.
3. **Decisão em 1 página**: escolher 1-3 mecanismos, escrever emenda ao CONTRACTS.md, implementar,
   medir. Se a pesquisa não trouxer nada acionável → aceitar o limite atual e documentar.
4. **Nunca** repetir a onda sobre o mesmo tema. Uma onda por problema; a segunda só por ordem
   explícita do utilizador.

## 4. Estados de trabalho (para o utilizador ver sempre onde estamos)

Cada ronda comunica: O QUE corre (com timeout), O QUE se mediu, O QUE trava (evidência),
O PRÓXIMO passo com o seu limite. Sem estado → o trabalho não começou.

## 5. SAÍDA SINCRONIZADA (conceito do utilizador, 2026-09-27)

- Quando há vários trabalhos em paralelo (subagents, probes), NÃO se entregam resultados
  parcelares. Espera-se que TODOS os em voo se resolvam e entrega-se **um único relatório
  consolidado** com o estado de cada um e **opções claras para o utilizador escolher**.
- A única exceção: avisos de trava/loop (esses são imediatos).
