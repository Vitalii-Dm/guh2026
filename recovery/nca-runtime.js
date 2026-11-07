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

  /** One update step. fireRate=1 makes it deterministic (used by the test). */
  step(fireRate = this.fireRate) {
    const { N, C, H, x, next, p, h, w1, b1, w2, b2 } = this;
    this.aliveMask(x, this.preAlive);
    // Cells next to a live cell must be updated too: their new alpha decides
    // whether that live cell survives (post-alive mask). Cells further out
    // are zeroed at the end anyway, so they can be skipped.
    const near = this.near || (this.near = new Uint8Array(N * N));
    near.fill(0);
    for (let y = 0; y < N; y++) for (let xi = 0; xi < N; xi++) {
      if (!this.preAlive[y * N + xi]) continue;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const yy = y + dy, xx = xi + dx;
        if (yy >= 0 && yy < N && xx >= 0 && xx < N) near[yy * N + xx] = 1;
      }
    }
    next.set(x);
    for (let y = 0; y < N; y++) {
      for (let xi = 0; xi < N; xi++) {
        const cell = y * N + xi;
        if (!near[cell]) continue;                    // result is zeroed anyway
        if (fireRate < 1 && this.random() > fireRate) continue;
        // perceive
        for (let c = 0; c < C; c++) {
          let id = 0, gx = 0, gy = 0;
          for (let ky = 0; ky < 3; ky++) {
            const yy = y + ky - 1;
            if (yy < 0 || yy >= N) continue;
            for (let kx = 0; kx < 3; kx++) {
              const xx = xi + kx - 1;
              if (xx < 0 || xx >= N) continue;
              const v = x[(yy * N + xx) * C + c];
              if (ky === 1 && kx === 1) id = v;
              gx += SX[ky][kx] * v;
              gy += SY[ky][kx] * v;
            }
          }
          p[c * 3] = id;
          p[c * 3 + 1] = gx;
          p[c * 3 + 2] = gy;
        }
        // h = relu(W1 p + b1)
        const P = C * 3;
        for (let j = 0; j < H; j++) {
          let s = b1[j];
          const row = j * P;
          for (let i = 0; i < P; i++) s += w1[row + i] * p[i];
          h[j] = s > 0 ? s : 0;
        }
        // dx = W2 h + b2
        const o = cell * C;
        for (let c = 0; c < C; c++) {
          let s = b2[c];
          const row = c * H;
          for (let j = 0; j < H; j++) s += w2[row + j] * h[j];
          next[o + c] += s;
        }
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

  /** Draw onto a 2D canvas context, scaled to fill it. bg = [r,g,b] 0..1. */
  draw(ctx, bg = [0.07, 0.09, 0.12]) {
    const { N, C, x } = this;
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
