// core/rng.mjs [A] — PRNG determinístico (mulberry32), zero dependências.
// makeRng(seed) => { next, int, range, pick, seed }; mesma seed ⇒ mesma sequência.

export function makeRng(seed = 1) {
  const s = Number.isFinite(seed) ? Math.trunc(seed) : 1;
  let st = s >>> 0; // estado interno (32 bits)
  const next = () => {
    st = (st + 0x6d2b79f5) | 0;
    let t = Math.imul(st ^ (st >>> 15), 1 | st);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296; // [0,1)
  };
  return {
    seed: s,
    next,
    int(n) {
      const k = Math.floor(n);
      return k > 0 ? Math.floor(next() * k) : 0; // [0,k)
    },
    range(lo, hi) {
      return lo + next() * (hi - lo); // [lo,hi) para lo ≤ hi
    },
    pick(arr) {
      return arr[Math.floor(next() * arr.length)];
    },
  };
}
