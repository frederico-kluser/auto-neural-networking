#!/usr/bin/env bash
# Baixa os PDFs listados em docs/manifest-downloads.tsv para as subpastas de docs/.
# Uso: ./scripts/baixar-pdfs.sh [secao ...]   (sem argumentos = todas as seções)
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST="$ROOT/docs/manifest-downloads.tsv"
DIR_A="$ROOT/docs/A-neuroevolucao-e-crescimento-de-redes"
DIR_B="$ROOT/docs/B-redes-recorrentes-reservatorio-e-dinamica"
DIR_C="$ROOT/docs/C-selecao-adaptativa-de-operadores"
DIR_D="$ROOT/docs/D-early-stopping"

UA="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
FILTERS=("$@")

download() {
  local sec="$1" name="$2" url="$3" dir out
  case "$sec" in
    A) dir="$DIR_A" ;;
    B) dir="$DIR_B" ;;
    C) dir="$DIR_C" ;;
    D) dir="$DIR_D" ;;
    *) echo "SECAO-DESCONHECIDA  $sec  $name" ; return 1 ;;
  esac
  out="$dir/$name"

  if [[ -s "$out" ]] && head -c 5 "$out" | grep -q '%PDF'; then
    echo "JA-OK        $sec/$name"
    return 0
  fi

  if curl -sSL --fail --max-time 180 -A "$UA" \
       -H "Accept: application/pdf,*/*" \
       -o "$out.tmp" "$url"; then
    if head -c 5 "$out.tmp" | grep -q '%PDF'; then
      mv "$out.tmp" "$out"
      echo "OK           $sec/$name  ($(du -h "$out" | cut -f1))"
      return 0
    fi
    echo "NAO-E-PDF    $sec/$name  ($url)"
  else
    echo "FALHOU       $sec/$name  ($url)"
  fi
  rm -f "$out.tmp"
  return 1
}

export -f download
export DIR_A DIR_B DIR_C DIR_D UA

while IFS=$'\t' read -r sec name url; do
  [[ -z "${sec:-}" || "$sec" == \#* ]] && continue
  if [[ ${#FILTERS[@]} -gt 0 ]]; then
    keep=0
    for f in "${FILTERS[@]}"; do [[ "$f" == "$sec" ]] && keep=1; done
    [[ $keep -eq 0 ]] && continue
  fi
  echo "$sec" "$name" "$url"
done < "$MANIFEST" | xargs -P 4 -n 3 bash -c 'download "$@"' _

echo "Concluído."
