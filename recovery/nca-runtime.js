// nca-runtime.js — runs the trained Growing Neural Cellular Automaton in the
// browser with plain Float32Arrays (no TensorFlow.js). Zero dependencies.
//
// Same maths as nca/train_nca.py:
//   perceive: per channel [identity, sobel_x, sobel_y], zero padding, order c*3+k
//   update:   h = relu(W1·p + b1); dx = W2·h + b2
//   stochastic update (fire rate), alive = 3x3 max-pool(alpha) > 0.1
//
// const nca = new NCA(await (await fetch('models/formation-nca.json')).json());
// nca.reset(); every frame: nca.step(); nca.draw(ctx2d);
// Split across drones: owner = nca.assignOwners(slots); nca.stepSwarm(owner, group);

const SX = [[-1, 0, 1], [-2, 0, 2], [-1, 0, 1]].map((r) => r.map((v) => v / 8));
const SY = [[-1, -2, -1], [0, 0, 0], [1, 2, 1]].map((r) => r.map((v) => v / 8));

export class NCA {
  constructor(model, { random = Math.random } = {}) {
    this.C = model.channels;
    this.H = model.hidden;
    this.N = model.size;
    this.fireRate = model.fire_rate;
    this.w1 = Float32Array.from(model.w1);
    this.b1 = Float32Array.from(model.b1);
    this.w2 = Float32Array.from(model.w2);
    this.b2 = Float32Array.from(model.b2);
    this.target = model.target_rgba ? Float32Array.from(model.target_rgba) : null;
    this.random = random;
    this.seed = model.seed || [Math.floor(model.size / 2), Math.floor(model.size / 2)];
    const cells = this.N * this.N;
    this.x = new Float32Array(cells * this.C);
    this.next = new Float32Array(cells * this.C);
    this.p = new Float32Array(this.C * 3);
    this.h = new Float32Array(this.H);
    this.preAlive = new Uint8Array(cells);
    this.image = null;
  }

  /** A single live seed cell (the tip of the V) — everything regrows from it. */
  reset() {
    this.x.fill(0);
    const [sx, sy] = this.seed;
    const o = (sy * this.N + sx) * this.C;
    for (let k = 3; k < this.C; k++) this.x[o + k] = 1;
    this.views = null;
  }

  setState(arr) {
    this.x.set(arr);
  }

  aliveMask(src, out) {
    const { N, C } = this;
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        let m = -Infinity;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= N) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= N) continue;
            const a = src[(yy * N + xx) * C + 3];
            if (a > m) m = a;
          }
        }
        out[y * N + x] = m > 0.1 ? 1 : 0;
      }
    }
  }

  /** Largest alpha in the 3x3 block around (x, y) of `src`. */
  maxAlpha(src, y, x) {
    const { N, C } = this;
    let m = -Infinity;
    for (let dy = -1; dy <= 1; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= N) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx;
        if (xx < 0 || xx >= N) continue;
        const a = src[(yy * N + xx) * C + 3];
        if (a > m) m = a;
      }
    }
    return m;
  }

  /** Perceive cell (xi, y) in `src`, run the network, add the change into out[o..o+C). */
  updateCell(src, y, xi, out, o) {
    const { N, C, H, p, h, w1, b1, w2, b2 } = this;
    for (let c = 0; c < C; c++) {
      let id = 0, gx = 0, gy = 0;
      for (let ky = 0; ky < 3; ky++) {
        const yy = y + ky - 1;
        if (yy < 0 || yy >= N) continue;
        for (let kx = 0; kx < 3; kx++) {
          const xx = xi + kx - 1;
          if (xx < 0 || xx >= N) continue;
          const v = src[(yy * N + xx) * C + c];
          if (ky === 1 && kx === 1) id = v;
          gx += SX[ky][kx] * v;
          gy += SY[ky][kx] * v;
        }
      }
      p[c * 3] = id;
      p[c * 3 + 1] = gx;
      p[c * 3 + 2] = gy;
    }
    const P = C * 3;
    for (let j = 0; j < H; j++) {           // h = relu(W1 p + b1)
      let s = b1[j];
      const row = j * P;
      for (let i = 0; i < P; i++) s += w1[row + i] * p[i];
      h[j] = s > 0 ? s : 0;
    }
    for (let c = 0; c < C; c++) {           // dx = W2 h + b2
      let s = b2[c];
      const row = c * H;
      for (let j = 0; j < H; j++) s += w2[row + j] * h[j];
      out[o + c] += s;
    }
  }

  /** Cells next to a pre-alive cell (they decide whether it survives). */
  nearMask(pre) {
    const { N } = this;
    const near = this.near || (this.near = new Uint8Array(N * N));
    near.fill(0);
    for (let y = 0; y < N; y++) for (let xi = 0; xi < N; xi++) {
      if (!pre[y * N + xi]) continue;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const yy = y + dy, xx = xi + dx;
        if (yy >= 0 && yy < N && xx >= 0 && xx < N) near[yy * N + xx] = 1;
      }
    }
    return near;
  }

  /** One update step. fireRate=1 makes it deterministic (used by the test). */
  step(fireRate = this.fireRate) {
    const { N, C, x, next } = this;
    this.aliveMask(x, this.preAlive);
    // Cells next to a live cell must be updated too: their new alpha decides
    // whether that live cell survives (post-alive mask). Cells further out
    // are zeroed at the end anyway, so they can be skipped.
    const near = this.nearMask(this.preAlive);
    next.set(x);
    for (let y = 0; y < N; y++) {
      for (let xi = 0; xi < N; xi++) {
        const cell = y * N + xi;
        if (!near[cell]) continue;
        if (fireRate < 1 && this.random() > fireRate) continue;
        this.updateCell(x, y, xi, next, cell * C);
      }
    }
    // alive = pre & post
    const post = new Uint8Array(N * N);
    this.aliveMask(next, post);
    for (let cell = 0; cell < N * N; cell++) {
      if (!(this.preAlive[cell] && post[cell])) next.fill(0, cell * C, cell * C + C);
    }
    this.x = next;
    this.next = x;
  }

  // ------------------------------------------------------------ on the drones
  // The grid is split between drones: each cell is computed by the drone that
  // owns it. A drone sees its own cells live and other drones' cells only as
  // they last arrived by radio. Drones that can reach each other (directly or
  // through relays) share the same `group`; for any other drone it keeps
  // using the last copy it received, which goes stale.

  /**
   * Give each cell to the nearest drone.
   * @param {{id: number, gx: number, gy: number}[]} drones  positions in grid cells
   * @returns {Int32Array} owner id per cell
   */
  assignOwners(drones) {
    const { N } = this;
    const owner = new Int32Array(N * N).fill(-1);
    for (let y = 0; y < N; y++) for (let xi = 0; xi < N; xi++) {
      let best = -1, bd = Infinity;
      for (const d of drones) {
        const dd = (xi + 0.5 - d.gx) ** 2 + (y + 0.5 - d.gy) ** 2;
        if (dd < bd) { bd = dd; best = d.id; }
      }
      owner[y * N + xi] = best;
    }
    return owner;
  }

  /**
   * One step computed by the drones.
   * @param {Int32Array} owner         from assignOwners()
   * @param {Map<number, any>} group   drones with equal values can reach each other
   * @returns {{ fresh: number, stale: number }} cell borders exchanged / served stale
   */
  stepSwarm(owner, group, fireRate = this.fireRate) {
    const { N, C, x, next } = this;
    const cells = N * N;
    const views = this.views || (this.views = new Map());
    const ids = new Set(owner);
    for (const id of views.keys()) if (!ids.has(id)) views.delete(id);
    const sees = (a, b) => a === b || (group.has(a) && group.get(a) === group.get(b));
    // 1. radio: refresh each drone's copy of the cells it can hear
    for (const id of ids) {
      let v = views.get(id);
      if (!v) { views.set(id, (v = Float32Array.from(x))); continue; }
      for (let cell = 0; cell < cells; cell++) {
        if (sees(id, owner[cell])) v.set(x.subarray(cell * C, cell * C + C), cell * C);
      }
    }
    // 2. each drone updates its own cells from its own copy
    const pre = this.preAlive;
    for (let y = 0; y < N; y++) for (let xi = 0; xi < N; xi++) {
      const cell = y * N + xi;
      pre[cell] = this.maxAlpha(views.get(owner[cell]), y, xi) > 0.1 ? 1 : 0;
    }
    const near = this.nearMask(pre);
    next.set(x);
    for (let y = 0; y < N; y++) for (let xi = 0; xi < N; xi++) {
      const cell = y * N + xi;
      if (!near[cell]) continue;
      if (fireRate < 1 && this.random() > fireRate) continue;
      this.updateCell(views.get(owner[cell]), y, xi, next, cell * C);
    }
    // 3. alive check, again with only what the owner can hear
    let fresh = 0, stale = 0;
    for (let y = 0; y < N; y++) for (let xi = 0; xi < N; xi++) {
      const cell = y * N + xi, o = owner[cell], v = views.get(o);
      let m = -Infinity;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= N) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = xi + dx;
          if (xx < 0 || xx >= N) continue;
          const nb = yy * N + xx;
          const a = (sees(o, owner[nb]) ? next : v)[nb * C + 3];
          if (a > m) m = a;
        }
      }
      if (!(pre[cell] && m > 0.1)) next.fill(0, cell * C, cell * C + C);
      // count borders inside the shape (right and down neighbours)
      if (pre[cell]) {
        if (xi + 1 < N && owner[cell + 1] !== o) sees(o, owner[cell + 1]) ? fresh++ : stale++;
        if (y + 1 < N && owner[cell + N] !== o) sees(o, owner[cell + N]) ? fresh++ : stale++;
      }
    }
    this.x = next;
    this.next = x;
    return { fresh, stale };
  }

  /** Erase a disk of cells (grid coords) — simulates a drone dropping out. */
  erase(cx, cy, r) {
    const { N, C } = this;
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 < r * r) this.x.fill(0, (y * N + x) * C, (y * N + x) * C + C);
      }
    }
  }

  /** How close the current picture is to the trained shape (0..1). */
  similarity() {
    if (!this.target) return null;
    const { N, C, x, target } = this;
    let err = 0, base = 0;
    for (let cell = 0; cell < N * N; cell++) {
      for (let k = 0; k < 4; k++) {
        const t = target[cell * 4 + k];
        const v = Math.min(1, Math.max(0, x[cell * C + k]));
        err += (v - t) ** 2;
        base += t * t;
      }
    }
    return Math.max(0, 1 - err / base);
  }

  /** Draw onto a 2D canvas context, scaled to fill it. bg = [r,g,b] 0..1; x = a drone's copy, if given. */
  draw(ctx, bg = [0.07, 0.09, 0.12], x = this.x) {
    const { N, C } = this;
    if (!this.image) {
      this.image = new ImageData(N, N);
      this.tmp = document.createElement('canvas');
      this.tmp.width = this.tmp.height = N;
    }
    const d = this.image.data;
    for (let cell = 0; cell < N * N; cell++) {
      const a = Math.min(1, Math.max(0, x[cell * C + 3]));
      for (let k = 0; k < 3; k++) {
        const v = Math.min(1, Math.max(0, x[cell * C + k])) + (1 - a) * bg[k];
        d[cell * 4 + k] = Math.min(255, v * 255);
      }
      d[cell * 4 + 3] = 255;
    }
    this.tmp.getContext('2d').putImageData(this.image, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.tmp, 0, 0, ctx.canvas.width, ctx.canvas.height);
  }
}
