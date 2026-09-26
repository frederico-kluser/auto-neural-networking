# E. Referências técnicas

Páginas e códigos verificados (sem PDF — são referências web). Todos os links
foram abertos e conferidos na data da pesquisa.

## TensorFlow.js

| Item | Link verificado | O que confirma |
|---|---|---|
| API do TensorFlow.js | [js.tensorflow.org/api/latest](https://js.tensorflow.org/api/latest/) | Versão 4.22.0; `tf.linalg` tem só `bandPart`, `gramSchmidt`, `qr`; **não há** `solve`/`inv`/`eig`/`svd`/`clipByGlobalNorm` |
| Releases do tfjs | [github.com/tensorflow/tfjs/releases](https://github.com/tensorflow/tfjs/releases) | "Latest" = tfjs-v4.22.0 (21/10/2024); existe só uma tag 4.23.0-rc.0 (jan/2025), sem release |
| Issue #8609 | [github.com/tensorflow/tfjs/issues/8609](https://github.com/tensorflow/tfjs/issues/8609) | "latest release (4.22.0) tfjs-node is broken with node 24", aberta em 06/12/2025 |
| Código do otimizador / gradientes | [optimizer.ts](https://github.com/tensorflow/tfjs/blob/master/tfjs-core/src/optimizers/optimizer.ts) · [gradients.ts](https://github.com/tensorflow/tfjs/blob/master/tfjs-core/src/gradients.ts) | `minimize`, `applyGradients`; `variableGrads` retorna `{value, grads}` |
| tfjs-vis | [npm @tensorflow/tfjs-vis](https://www.npmjs.com/package/@tensorflow/tfjs-vis) · [código](https://github.com/tensorflow/tfjs/tree/master/tfjs-vis) | Versão 1.5.1 |

## Bibliotecas de neuroevolução

| Item | Link verificado | O que confirma |
|---|---|---|
| neataptic | [github.com/wagenaartje/neataptic](https://github.com/wagenaartje/neataptic) | Sem manutenção desde 2017 (issue #112); último commit jun/2018 |
| NeatapticTS | [github.com/reicek/NeatapticTS](https://github.com/reicek/NeatapticTS) | Reescrita em TypeScript, ativa (último commit set/2026), projeto de um autor só |
| TensorNEAT | [github.com/EMI-Group/tensorneat](https://github.com/EMI-Group/tensorneat) | Biblioteca em JAX/Python (não JS), GPL-3.0 |

## Observação

Os destaques acima sobre a API do `tf.linalg` (ausência de `solve`, `inv`,
`eig`, `svd` e `clipByGlobalNorm`) são restrições relevantes para a
implementação — verifique a API atual antes de planejar dependências.
