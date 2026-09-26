# docs/ — Referências do relatório

Organização por sessão do relatório de pesquisa. Cada subpasta guarda os PDFs de
acesso aberto daquela sessão e um `README.md` com a ficha completa de cada
trabalho (link oficial, DOI, status de acesso e observações).

| Pasta | Sessão | PDFs |
|---|---|---|
| [A-neuroevolucao-e-crescimento-de-redes](A-neuroevolucao-e-crescimento-de-redes/) | Neuroevolução e crescimento de redes | 24 |
| [B-redes-recorrentes-reservatorio-e-dinamica](B-redes-recorrentes-reservatorio-e-dinamica/) | Redes recorrentes, reservatório e dinâmica | 7 |
| [C-selecao-adaptativa-de-operadores](C-selecao-adaptativa-de-operadores/) | Seleção adaptativa de operadores | 8 |
| [D-early-stopping](D-early-stopping/) | Early stopping | 3 |
| [E-referencias-tecnicas](E-referencias-tecnicas/) | Referências técnicas (web) | 0 (páginas verificadas) |

**Total: 42 PDFs baixados** — todos os links de PDF do relatório, exceto os 4
trabalhos sem versão aberta (listados abaixo).

## Visão geral do acervo

- **30 fontes acadêmicas** conferidas; **26 têm PDF em acesso aberto**.
- **4 somente em versão paga** (sem PDF legítimo aberto):
  Sompolinsky, Crisanti & Sommers (1988); Beer (1995); Benettin et al. (1980);
  Thierens (2005). Detalhes e links das editoras nas fichas das seções B e C.

## Como os PDFs foram baixados

- Manifesto: [`manifest-downloads.tsv`](manifest-downloads.tsv) (seção, nome do arquivo, URL).
- Script reproduzível: [`../scripts/baixar-pdfs.sh`](../scripts/baixar-pdfs.sh) —
  baixa tudo de novo em `bash scripts/baixar-pdfs.sh`, ou só uma seção
  (`bash scripts/baixar-pdfs.sh C`). Arquivos já presentes e válidos são pulados.

## Convenção de nomes

`<autor(es)>-<ano>-<titulo-curto>-<veiculo>.pdf` — quando o mesmo trabalho tem
mais de uma cópia legítima (ex.: preprint arXiv + versão dos anais), as duas
ficam salvas e o sufixo indica a origem (`arxiv`, `neurips`, `aaai`, `ubc`, …).

## Correções de citação

Ver [correcoes-citacoes.md](correcoes-citacoes.md) para as correções identificadas
na conferência dos links (IDs de arXiv trocados e título exato de um artigo).
