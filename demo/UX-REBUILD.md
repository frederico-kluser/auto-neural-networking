# UX-REBUILD.md — contrato da reconstrução de experiência (obrigatório)

Objetivo único, na voz do utilizador: **"clicar em Treinar, ver a coisa evoluir sozinha e ver o treino
VENCER o jogo pela interface"**. Tudo o resto subordina-se a isto.

Proibições absolutas: em-dash (`—`) em copy visível; jargão sem explicação; controlos sem linha de
ajuda; paragens silenciosas; dados fabricados.

## 1. Fluxo canónico (uma decisão de cada vez)

1. O utilizador abre a página e percebe em 3 segundos: o que é ("rede que evolui num labirinto"),
   qual é o objetivo ("levar o agente à saída") e o que fazer ("clicar em Treinar").
2. Clica em **Treinar**. O treino corre **até vencer** (ou até ele pausar/recomeçar). Nunca pára
   sozinho por limite escondido.
3. Vê a evolução acontecer: sparkline a subir, contadores a mexer, rede 3D a pulsar, agente a
   explorar o labirinto com o percurso marcado.
4. Quando vence: estado **RESOLVIDO** inequívoco (verde), texto "desafio vencido em N épocas", e o
   campeão reproduz a solução no labirinto até à saída.

## 2. Estrutura e copy exatos (pt-PT)

### Barra de topo
- Marca: `auto-neural-networking` + descritor `rede que evolui em labirintos`.
- Chip de estado (estados): `a treinar` · `em pausa` · `parado` · `resolvido` (verde).
- Contador de época no topo: `época N`.

### Faixa de objetivo (NOVA, entre o topo e o palco; largura total)
- Texto fixo: `objetivo: treinar a rede até o agente chegar à saída`.
- Linha de progresso dinâmica: `época 340 · resolvidos 2/3 · melhor resultado 2,41`.
- Estado inicial (antes do 1.º treino): `clica em Treinar e observa a rede evoluir até vencer`.
- Vitória: `desafio vencido em 312 épocas` (fundo verde semântico ténue).
- Limite atingido sem vitória: `limite de épocas atingido: a rede ainda não venceu. Aumente o limite em definições avançadas ou use um labirinto menor.`

### Painel de controlo (ordem de cima para baixo)
1. Botões: **`Treinar`** (primário, maior, largura total do painel), `Pausar` e `Recomeçar`
   (secundários, lado a lado). Texto do primário muda com o estado: `Treinar` → `Retomar` (em pausa).
2. `tamanho do desafio` (select 5×5 … 31×31) · ajuda: `labirintos maiores são mais difíceis e o treino demora mais a vencer`.
3. `velocidade do treino` (segmentos: `lenta` `normal` `rápida` `máxima`; valores 1/4/16/max) ·
   ajuda: `quão depressa o treino corre. Não muda o resultado, só o tempo`.
4. `<details>` `definições avançadas` (fechado por defeito):
   - `labirinto nº` (input número; texto NUNCA "seed") · ajuda: `cada número gera um labirinto diferente`.
   - `redes em competição` (input número; texto NUNCA "população") · ajuda: `quantas redes são treinadas de cada vez. Mais redes = mais diversidade, treino mais lento`.
   - `limite de épocas` (input número, 0) · ajuda: `0 = treinar até vencer. Coloque um número para limitar o tempo de treino`.
   - `rotação automática da câmara` (checkbox, desligada) · ajuda: `anima a câmara das vistas 3D`.

### Palco (mantém as duas vistas; ganha legendas)
- Sob a vista da rede: `os pulsos são os sinais a circular pelas ligações`.
- Sob a vista do labirinto: `percurso feito a âmbar · saída a verde · raios = o que o agente deteta`.

### Faixa de estatísticas (rótulos em linguagem comum; cada um com ajuda curta)
- `evolução` (o sparkline) · ajuda: `subir = a rede está a melhorar de geração em geração` · legenda `melhor` / `média`.
- Contadores: `época` · `melhor resultado` (ajuda: `0 a 3.0; vencer começa em 1.2`) · `resultado médio`
  (ajuda: `média de todas as redes`) · `resolvidos` (`2/3`; ajuda: `labirintos de treino já resolvidos pelo campeão`)
  · `neurónios` (ajuda: `crescem sozinhos quando são precisos`) · `conexões`.
- `mutações em ensaio` (era "banco de operadores") · ajuda: `a rede tenta mutações e fica com as que funcionam` ·
  cabeçalhos: `mutação` / `probabilidade` / `p` / `usos`.
- `o que a rede vê` (era "leituras") · ajuda: `12 sinais: distâncias às paredes, saída visível e onde já esteve` ·
  grupos: `paredes` (4) / `saída visível` (4) / `onde já esteve` (4).

## 3. Comportamento obrigatório (funcional, não cosmético)

- `Treinar` inicia/retoma e **só termina** por: vitória (todos os labirintos de treino resolvidos pelo
  campeão), `limite de épocas` (quando > 0), `Pausar` ou `Recomeçar`. Cada fim mostra o motivo.
- Mudar `tamanho do desafio` ou `labirinto nº` durante o treino reinicia o desafio (com aviso curto
  no texto de progresso: `desafio novo: a contar do zero`).
- A memória tem de ser VISÍVEL: barra de progresso do percurso na vista do labirinto (células
  visitadas marcadas), 4 leituras `onde já esteve` a mexer, e a explicação de que a rede só vê esses
  12 sinais.
- Vitória tem de ser OBSERVÁVEL: com o campeão resolvido, o episódio ao vivo termina na saída e a
  etiqueta `resolvido` fica verde.

## 4. Regras de copy

- pt-PT; frases curtas; verbos concretos; números com vírgula decimal (2,41).
- Nada de: "pipeline", "fitness" sem explicação (usar "resultado"), "geração" (usar "época"), "seed"
  (usar "labirinto nº"), "população" (usar "redes em competição").
- Sem em-dash, sem emoji, sem falsa precisão.
