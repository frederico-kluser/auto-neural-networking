/**
 * core/index.mjs — barrel dos módulos do motor (integração).
 * Sem colisões de nomes entre network/ops/evolution (verificado).
 */
export * from './rng.mjs';
export * from './maze.mjs';
export * from './sensors.mjs';
export * from './network.mjs';
export * from './ops.mjs';
export * from './evolution.mjs';
