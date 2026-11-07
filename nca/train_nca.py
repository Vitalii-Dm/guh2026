"""Train a Growing Neural Cellular Automaton (the "gecko" network) on the
swarm's formation shape, then export the weights for the browser.

Same model as Google's growing_ca.ipynb (vendor/self-organising-systems),
rewritten in PyTorch:
  perceive = identity + Sobel x + Sobel y per channel (depthwise 3x3)
  update   = 1x1 conv 48 -> 128 (ReLU) -> 16, last layer zero-initialised
  stochastic update (fire rate 0.5), alive mask = 3x3 max-pool(alpha) > 0.1
Trained in "Regenerating" mode: sample pool + random circular damage, so it
learns to regrow holes, not just grow once.

Usage:
  python3 nca/train_nca.py                 # trains, writes recovery/models/
  python3 nca/train_nca.py --steps 500     # quick smoke run
"""
import argparse
import json
import math
import os
import time

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "recovery", "models")

CHANNELS = 16
SIZE = 40          # grid is SIZE x SIZE
POOL_SIZE = 1024
BATCH = 8
FIRE_RATE = 0.5
DAMAGE_N = 3

# Formation shape: a chevron ("V" pointing up) in normalised [0,1] coords.
# Keep in sync with FORMATION_POLYLINE in recovery/swarm-recovery.js.
FORMATION_POLYLINE = [(0.12, 0.80), (0.50, 0.22), (0.88, 0.80)]
# The seed cell must sit on the shape (the gecko notebook seeds the centre,
# which is on the gecko's body). We seed at the tip of the V: the lead drone.
SEED_XY = (int(FORMATION_POLYLINE[1][0] * SIZE), int(FORMATION_POLYLINE[1][1] * SIZE))


def make_target(size=SIZE):
    """Chevron of drone 'dots' joined by a thinner link, RGBA premultiplied."""
    img = np.zeros((size, size, 4), np.float32)
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32) + 0.5
    pts = [(x * size, y * size) for x, y in FORMATION_POLYLINE]

    def seg_dist(px, py, a, b):
        ax, ay = a
        bx, by = b
        dx, dy = bx - ax, by - ay
        t = np.clip(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy), 0, 1)
        return np.hypot(px - (ax + t * dx), py - (ay + t * dy)), t

    link = np.zeros((size, size), np.float32)
    for a, b in zip(pts[:-1], pts[1:]):
        d, _ = seg_dist(xx, yy, a, b)
        link = np.maximum(link, np.clip(1.6 - d, 0, 1))

    # Dots evenly spaced along the polyline (the "drones").
    lengths = [math.dist(a, b) for a, b in zip(pts[:-1], pts[1:])]
    total = sum(lengths)
    n_dots = 9
    dots = np.zeros((size, size), np.float32)
    dot_t = np.zeros((size, size), np.float32)  # position along chain, for colour
    for i in range(n_dots):
        s = total * i / (n_dots - 1)
        for (a, b), L in zip(zip(pts[:-1], pts[1:]), lengths):
            if s <= L + 1e-6:
                cx = a[0] + (b[0] - a[0]) * s / L
                cy = a[1] + (b[1] - a[1]) * s / L
                break
            s -= L
        d = np.hypot(xx - cx, yy - cy)
        m = np.clip(2.6 - d, 0, 1)
        upd = m > dots
        dot_t[upd] = i / (n_dots - 1)
        dots = np.maximum(dots, m)

    # Colours: link = slate, dots = teal -> orange gradient along the chain.
    teal = np.array([0.10, 0.62, 0.62])
    orange = np.array([0.95, 0.52, 0.15])
    slate = np.array([0.35, 0.42, 0.52])
    dot_rgb = teal[None, None] * (1 - dot_t[..., None]) + orange[None, None] * dot_t[..., None]
    alpha = np.maximum(dots, link * 0.9)
    rgb = np.where(dots[..., None] > link[..., None] * 0.9, dot_rgb, slate[None, None])
    img[..., :3] = rgb * alpha[..., None]
    img[..., 3] = alpha
    return img


class CAModel(nn.Module):
    def __init__(self, channels=CHANNELS, hidden=128):
        super().__init__()
        self.channels = channels
        ident = np.zeros((3, 3), np.float32)
        ident[1, 1] = 1
        sx = np.outer([1, 2, 1], [-1, 0, 1]).astype(np.float32) / 8.0
        sy = sx.T
        k = np.stack([ident, sx, sy])  # (3,3,3)
        # Output channel order: c*3 + k  (identity, sobel_x, sobel_y per channel)
        kernel = np.tile(k[None], (channels, 1, 1, 1)).reshape(channels * 3, 1, 3, 3)
        self.register_buffer("kernel", torch.from_numpy(kernel))
        self.fc1 = nn.Conv2d(channels * 3, hidden, 1)
        self.fc2 = nn.Conv2d(hidden, channels, 1)
        nn.init.zeros_(self.fc2.weight)
        nn.init.zeros_(self.fc2.bias)

    def perceive(self, x):
        return F.conv2d(x, self.kernel, padding=1, groups=self.channels)

    @staticmethod
    def alive(x):
        return F.max_pool2d(x[:, 3:4], 3, 1, 1) > 0.1

    def forward(self, x, fire_rate=FIRE_RATE):
        pre = self.alive(x)
        dx = self.fc2(F.relu(self.fc1(self.perceive(x))))
        mask = (torch.rand_like(x[:, :1]) <= fire_rate).float()
        x = x + dx * mask
        post = self.alive(x)
        return x * (pre & post).float()


def make_seed(n, device):
    x = torch.zeros(n, CHANNELS, SIZE, SIZE, device=device)
    x[:, 3:, SEED_XY[1], SEED_XY[0]] = 1.0
    return x


def point_on_shape(rng):
    """Random point along the formation polyline, in [-1, 1] grid coords."""
    segs = list(zip(FORMATION_POLYLINE[:-1], FORMATION_POLYLINE[1:]))
    (ax, ay), (bx, by) = segs[rng.integers(len(segs))]
    t = rng.random()
    if rng.random() < 0.3:          # extra weight on the tip, where the seed lives
        t = 1.0 if (bx, by) == FORMATION_POLYLINE[1] else 0.0
    return (ax + (bx - ax) * t) * 2 - 1, (ay + (by - ay) * t) * 2 - 1


def circle_masks(n, device):
    """Damage disks: half anywhere in the middle, half centred on the shape
    itself (including the tip), sized like one failed drone or larger."""
    lin = torch.linspace(-1, 1, SIZE, device=device)
    y, x = torch.meshgrid(lin, lin, indexing="ij")
    c = torch.rand(2, n, 1, 1, device=device) - 0.5
    for i in range(n):
        if np.random.random() < 0.5:
            px, py = point_on_shape(np.random.default_rng(np.random.randint(1 << 30)))
            c[0, i], c[1, i] = px, py
    r = torch.rand(n, 1, 1, device=device) * 0.25 + 0.15
    return (((x - c[0]) / r) ** 2 + ((y - c[1]) / r) ** 2 < 1).float()  # 1 = damaged


def export(model, target, path, test_path):
    sd = {k: v.detach().cpu().numpy() for k, v in model.state_dict().items()}
    r = lambda a: [float(f"{v:.6g}") for v in np.asarray(a).ravel()]
    data = {
        "format": "growing-nca-v1",
        "channels": CHANNELS,
        "hidden": int(sd["fc1.weight"].shape[0]),
        "size": SIZE,
        "fire_rate": FIRE_RATE,
        "perceive_order": "c*3+k (identity, sobel_x, sobel_y), zero padding",
        "w1": r(sd["fc1.weight"][:, :, 0, 0]),  # [hidden][channels*3]
        "b1": r(sd["fc1.bias"]),
        "w2": r(sd["fc2.weight"][:, :, 0, 0]),  # [channels][hidden]
        "b2": r(sd["fc2.bias"]),
        "seed": list(SEED_XY),  # [x, y] grid cell the pattern grows from
        "formation_polyline": FORMATION_POLYLINE,
        "target_rgba": r(np.round(target, 3)),  # [y][x][4]
    }
    with open(path, "w") as f:
        json.dump(data, f, separators=(",", ":"))

    # Reference pair for checking the JS port: grow 30 steps, then one step
    # with fire_rate=1 (deterministic). Layout [y][x][c] to match the JS.
    with torch.no_grad():
        m = model.cpu()
        x = make_seed(1, "cpu")
        torch.manual_seed(0)
        for _ in range(30):
            x = m(x)
        y = m(x, fire_rate=1.0)
    hwc = lambda t: r(t[0].permute(1, 2, 0).numpy())
    with open(test_path, "w") as f:
        json.dump({"input": hwc(x), "output": hwc(y)}, f, separators=(",", ":"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--steps", type=int, default=6000)
    ap.add_argument("--init", help="start from an exported formation-nca.json (fine-tune)")
    ap.add_argument("--lr", type=float, default=2e-3)
    ap.add_argument("--device", default="mps" if torch.backends.mps.is_available() else "cpu")
    args = ap.parse_args()
    dev = torch.device(args.device)
    torch.manual_seed(42)
    np.random.seed(42)

    target_np = make_target()
    target = torch.from_numpy(target_np).permute(2, 0, 1)[None].to(dev)
    model = CAModel().to(dev)
    if args.init:
        js = json.load(open(args.init))
        with torch.no_grad():
            model.fc1.weight.copy_(torch.tensor(js["w1"]).reshape(model.fc1.weight.shape))
            model.fc1.bias.copy_(torch.tensor(js["b1"]))
            model.fc2.weight.copy_(torch.tensor(js["w2"]).reshape(model.fc2.weight.shape))
            model.fc2.bias.copy_(torch.tensor(js["b2"]))
        print("fine-tuning from", args.init, flush=True)
    opt = torch.optim.Adam(model.parameters(), lr=args.lr)
    sched = torch.optim.lr_scheduler.MultiStepLR(opt, [min(2000, args.steps * 2 // 3)], 0.1)
    pool = make_seed(POOL_SIZE, dev)

    t0 = time.time()
    for it in range(args.steps + 1):
        idx = torch.from_numpy(np.random.choice(POOL_SIZE, BATCH, replace=False)).to(dev)
        x = pool[idx]
        with torch.no_grad():
            loss_per = ((x[:, :4] - target) ** 2).mean(dim=(1, 2, 3))
            order = torch.argsort(loss_per, descending=True)
            x = x[order]
            idx = idx[order]
            x[:1] = make_seed(1, dev)                      # worst -> fresh seed
            dmg = circle_masks(DAMAGE_N, dev)[:, None]
            x[-DAMAGE_N:] *= 1.0 - dmg                     # best few -> damaged
        n_steps = int(np.random.randint(64, 97))
        for _ in range(n_steps):
            x = model(x)
        loss = ((x[:, :4] - target) ** 2).mean()
        opt.zero_grad()
        loss.backward()
        for p in model.parameters():  # per-variable gradient normalisation
            if p.grad is not None:
                p.grad /= p.grad.norm() + 1e-8
        opt.step()
        sched.step()
        with torch.no_grad():
            pool[idx] = x.detach()
        if it % 100 == 0:
            print(f"step {it:5d}  loss {loss.item():.5f}  log10 {math.log10(loss.item()):.2f}  "
                  f"{time.time() - t0:.0f}s", flush=True)

    os.makedirs(OUT_DIR, exist_ok=True)
    export(model, target_np, os.path.join(OUT_DIR, "formation-nca.json"),
           os.path.join(ROOT, "nca", "nca-reference.json"))
    try:  # optional checkpoint; the JSON above is what the browser uses
        torch.save(model.state_dict(), os.path.join(ROOT, "nca", "formation-nca.pt"))
    except Exception as e:
        print("skipped .pt checkpoint:", e, flush=True)
    print("exported", flush=True)


if __name__ == "__main__":
    main()
