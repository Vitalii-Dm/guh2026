// messages.js — turns what changed in each drone's knowledge during a radio
// tick into animations: dots that fly along links, and rings where news lands.
// Visual only. It reads the shared state before and after a tick and works
// out, hop by hop, who must have heard it from whom.
import * as R from '../recovery/swarm-recovery.js';

const HOP_MS = 150;          // how long one hop takes on screen
const MAX_FLIGHTS = 500;
export const KIND = {
  report:    { colour: '#ff7a59', r: 4 },     // a person was found
  delivered: { colour: '#3fb950', r: 4 },     // base has the report
  hub:       { colour: '#f2c14e', r: 4 },     // the hub changed
  map:       { colour: '#6ed7ff', r: 2.2 },   // searched ground
};

/** What a node knows, in a form that's cheap to compare. */
function summary(n) {
  const s = n.state.survivors;
  return {
    surv: new Set(Object.keys(s)),
    deliv: new Set(Object.keys(s).filter((k) => s[k].delivered)),
    hub: `${n.state.hub.id}:${n.state.hub.epoch}`,
    visited: R.visitedCount(n.state),
  };
}

export function createMessages() {
  let flights = [], flashes = [];
  let ticks = 0;

  /** Call right before the step that runs a radio tick. */
  function before(nodes) {
    return new Map(nodes.map((n) => [n, summary(n)]));
  }

  /**
   * BFS from the nodes that already knew, through links, to the ones that
   * learned this tick. Each learner gets a dot from its parent.
   */
  function spread(kind, knew, learned, adj, now, label) {
    const depth = new Map();
    let frontier = [...knew];
    for (const n of frontier) depth.set(n, 0);
    while (frontier.length) {
      const nextF = [];
      for (const a of frontier) {
        for (const b of adj.get(a) || []) {
          if (depth.has(b) || !learned.has(b)) continue;
          const d = depth.get(a) + 1;
          depth.set(b, d);
          flights.push({ from: a, to: b, kind, start: now + (d - 1) * HOP_MS, dur: HOP_MS });
          flashes.push({ node: b, kind, start: now + d * HOP_MS, label });
          nextF.push(b);
        }
      }
      frontier = nextF;
    }
  }

  /** Call after the radio tick with the same nodes and the tick's links. */
  function after(pre, nodes, links, now) {
    ticks++;
    const adj = new Map(nodes.map((n) => [n, []]));
    for (const [a, b] of links) { adj.get(a)?.push(b); adj.get(b)?.push(a); }
    const post = new Map(nodes.map((n) => [n, summary(n)]));
    const live = nodes.filter((n) => pre.has(n));

    // survivor reports and "base has it"
    for (const [field, kind] of [['surv', 'report'], ['deliv', 'delivered']]) {
      const ids = new Set();
      for (const n of live) for (const id of post.get(n)[field]) if (!pre.get(n)[field].has(id)) ids.add(id);
      for (const id of ids) {
        const knew = live.filter((n) => pre.get(n)[field].has(id));
        const learned = new Set(live.filter((n) => post.get(n)[field].has(id) && !pre.get(n)[field].has(id)));
        const label = kind === 'report' ? `+${id}` : `${id} ✓`;
        if (!knew.length) {
          // Nobody had it before the tick. For "delivered" that's base, which
          // sets the flag itself; it then spreads from there.
          const origin = [...learned].filter((n) => n.id === undefined);
          const roots = origin.length ? origin : [...learned];
          for (const n of roots) { learned.delete(n); flashes.push({ node: n, kind, start: now, label: kind === 'delivered' ? `${id} reached base` : label, big: true }); }
          spread(kind, roots, learned, adj, now, label);
        } else spread(kind, knew, learned, adj, now, label);
      }
    }

    // hub changes
    const keys = new Set();
    for (const n of live) if (post.get(n).hub !== pre.get(n).hub) keys.add(post.get(n).hub);
    for (const key of keys) {
      const knew = live.filter((n) => pre.get(n).hub === key);
      const learned = new Set(live.filter((n) => post.get(n).hub === key && pre.get(n).hub !== key));
      const id = Number(key.split(':')[0]);
      if (!knew.length) {
        const self = live.find((n) => n.id === id);
        if (self) { flashes.push({ node: self, kind: 'hub', start: now, label: 'I\'m hub now', big: true }); learned.delete(self); knew.push(self); }
      }
      spread('hub', knew, learned, adj, now, `hub ${id}`);
    }

    // searched map: constant background traffic, so thin it out
    if (ticks % 3 === 0) {
      for (const [a, b] of links) {
        const pa = pre.get(a), pb = pre.get(b);
        if (!pa || !pb) continue;
        if (pa.visited > pb.visited + 1) flights.push({ from: a, to: b, kind: 'map', start: now, dur: HOP_MS * 2 });
        else if (pb.visited > pa.visited + 1) flights.push({ from: b, to: a, kind: 'map', start: now, dur: HOP_MS * 2 });
      }
    }
    if (flights.length > MAX_FLIGHTS) flights = flights.slice(-MAX_FLIGHTS);
  }

  /** Draw dots and rings. `show(node)` filters by the current view. */
  function draw(ctx, now, show = () => true) {
    flights = flights.filter((f) => now < f.start + f.dur);
    flashes = flashes.filter((f) => now < f.start + (f.big ? 1800 : 900));
    for (const f of flights) {
      if (now < f.start || !(show(f.from) || show(f.to))) continue;
      const t = (now - f.start) / f.dur;
      const x = f.from.x + (f.to.x - f.from.x) * t, y = f.from.y + (f.to.y - f.from.y) * t;
      const k = KIND[f.kind];
      ctx.beginPath(); ctx.arc(x, y, k.r + 1.5, 0, Math.PI * 2); ctx.fillStyle = 'rgba(4,10,20,0.75)'; ctx.fill();
      ctx.beginPath(); ctx.arc(x, y, k.r, 0, Math.PI * 2); ctx.fillStyle = k.colour; ctx.fill();
    }
    ctx.textAlign = 'center';
    for (const f of flashes) {
      if (now < f.start || !show(f.node)) continue;
      const life = f.big ? 1800 : 900;
      const t = (now - f.start) / life;
      const k = KIND[f.kind];
      ctx.globalAlpha = 1 - t;
      ctx.strokeStyle = k.colour; ctx.lineWidth = f.big ? 3 : 2;
      ctx.beginPath(); ctx.arc(f.node.x, f.node.y, 12 + t * (f.big ? 110 : 22), 0, Math.PI * 2); ctx.stroke();
      if (f.label && f.kind !== 'map') {
        ctx.font = '700 11px system-ui';
        ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(4,10,20,0.85)';
        ctx.strokeText(f.label, f.node.x, f.node.y - 28 - t * 14);
        ctx.fillStyle = k.colour; ctx.fillText(f.label, f.node.x, f.node.y - 28 - t * 14);
      }
      ctx.globalAlpha = 1;
    }
  }

  function clear() { flights = []; flashes = []; ticks = 0; }

  return { before, after, draw, clear };
}
