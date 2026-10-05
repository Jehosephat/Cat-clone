// Small deterministic PRNG (mulberry32) so games are reproducible and testable.
export function createRng(seed) {
  let a = (seed >>> 0) || 0x9e3779b9;
  return {
    next() {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
    int(max) {
      return Math.floor(this.next() * max);
    },
    pick(arr) {
      return arr[this.int(arr.length)];
    },
    shuffle(arr) {
      const a2 = arr.slice();
      for (let i = a2.length - 1; i > 0; i--) {
        const j = this.int(i + 1);
        [a2[i], a2[j]] = [a2[j], a2[i]];
      }
      return a2;
    },
    get state() {
      return a;
    },
    set state(v) {
      a = v >>> 0;
    },
  };
}

export function randomSeed() {
  return Math.floor(Math.random() * 0xffffffff) >>> 0;
}
