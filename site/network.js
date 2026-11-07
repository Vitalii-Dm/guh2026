// network.js — the "How it works" graph. It runs the team's real swarm code
// (demo/sim.js + recovery/swarm-recovery.js) on a fixed seed and draws it as a
// node-link diagram over a blue relief map. Nothing here is scripted: every
// counter, link, hub change and message dot comes from the simulation state.
import * as R from '../recovery/swarm-recovery.js';
import { makeTerrain, WATER } from '../demo/terrain.js';
import { W, H, BASE, CELL, TICK_STEPS, createSim } from '../demo/sim.js';

const SEED = 116;               // picked by trying 160 seeds: no false takeover before the hub fails, first report home early
const DRONES = 9;
const SPEED = 2;                 // motion steps per frame (1 = real time)
const AUTO_FAIL_AFTER = 45;      // ticks after the first report reaches base
const AUTO_FAIL_LATEST = 420;    // fail the hub by this tick if nothing has been delivered
const RESTART_AT = 640;          // ticks before the autoplay loops (all 7 reports reach base by ~360)

const C = { link: '#5ee6d6', hub: '#f6c453', sos: '#ff8a5c', ok: '#4ade80', bad: '#ff5d5d', ice: '#eaf6ff', muted: '#8fa6c4' };
const MODE = { hub: C.link, neighbours: C.sos, alone: C.bad };

/** Blue relief map: elevation shading, hillshade and contour lines, drawn once. */
function reliefCanvas(terrain) {
  const S = 2, w = W / S, h = H / S;
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d'), img = ctx.createImageData(w, h);
  const hm = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) hm[y * w + x] = terrain.height(x * S, y * S);
  const lerp = (a, b, t) => a + (b - a) * t;
  const ramp = [[0, [8, 22, 44]], [WATER, [14, 40, 72]], [0.3, [24, 58, 102]], [0.5, [40, 84, 138]], [0.68, [74, 120, 172]], [0.82, [138, 176, 216]], [1, [206, 226, 248]]];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = hm[y * w + x];
      let i = 1; while (i < ramp.length - 1 && v > ramp[i][0]) i++;
      const [a, ca] = ramp[i - 1], [b, cb] = ramp[i];
      const t = Math.max(0, Math.min(1, (v - a) / (b - a)));
      let col = ca.map((c, k) => lerp(c, cb[k], t));
      // hillshade from the north-west
      const dx = hm[y * w + Math.min(w - 1, x + 1)] - hm[y * w + Math.max(0, x - 1)];
      const dy = hm[Math.min(h - 1, y + 1) * w + x] - hm[Math.max(0, y - 1) * w + x];
      const shade = Math.max(-0.45, Math.min(0.45, -(dx + dy) * 9));
      col = col.map((c) => c * (1 + shade));
      // contours
      const band = Math.floor(v / 0.06), r = Math.floor(hm[y * w + Math.min(w - 1, x + 1)] / 0.06), d = Math.floor(hm[Math.min(h - 1, y + 1) * w + x] / 0.06);
      if (v > WATER && (band !== r || band !== d)) col = col.map((c) => c + 26);
      const o = (y * w + x) * 4;
      img.data[o] = col[0]; img.data[o + 1] = col[1]; img.data[o + 2] = col[2]; img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const big = document.createElement('canvas'); big.width = W; big.height = H;
  const b = big.getContext('2d'); b.imageSmoothingQuality = 'high'; b.drawImage(cv, 0, 0, W, H);
  // darken so the graph sits on top
  b.fillStyle = 'rgba(4,12,30,.46)'; b.fillRect(0, 0, W, H);
  return big;
}

export function createNetwork({ canvas, steps, readout, note, onChange = () => {} }) {
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(2, devicePixelRatio || 1);
  canvas.width = W * dpr; canvas.height = H * dpr;
  ctx.scale(dpr, dpr);

  const terrain = makeTerrain(SEED, W, H, BASE);
  const relief = reliefCanvas(terrain);

  let sim, flights, rings, reached, touched, firstDelivery, failedHub, lastTick, lastLog, takeoverAt;

  function reset() {
    lastLog = '';
    sim = createSim({ seed: SEED, terrain, drones: DRONES, onLog: (m) => { lastLog = m; } });
    flights = []; rings = [];
    reached = new Map([['search', 0]]);
    touched = false; firstDelivery = null; failedHub = null; lastTick = 0; takeoverAt = null;
    note.innerHTML = 'Running at 2× speed. Drones are launching from base.';
    paintSteps(); onChange(status());
  }

  const nodes = () => [sim.base, ...sim.drones.filter((d) => d.alive)];
  const summary = (n) => {
    const s = n.state.survivors;
    return { surv: new Set(Object.keys(s)), deliv: new Set(Object.keys(s).filter((k) => s[k].delivered)), hub: `${n.state.hub.id}:${n.state.hub.epoch}` };
  };

  function reach(step) {
    if (!reached.has(step)) { reached.set(step, performance.now()); paintSteps(); }
  }
  function paintSteps() {
    const latest = [...reached.entries()].sort((a, b) => a[1] - b[1]).pop()[0];
    steps.querySelectorAll('li').forEach((li) => {
      const s = li.dataset.step;
      li.classList.toggle('active', s === latest);
      li.classList.toggle('done', reached.has(s) && s !== latest);
    });
  }

  /** After a radio tick: send a dot from a neighbour that knew to each node that just learned. */
  function animateNews(before) {
    const adj = new Map();
    for (const [a, b] of sim.links) {
      if (!adj.has(a)) adj.set(a, []); if (!adj.has(b)) adj.set(b, []);
      adj.get(a).push(b); adj.get(b).push(a);
    }
    const now = performance.now();
    for (const n of nodes()) {
      const pre = before.get(n); if (!pre) continue;
      const post = summary(n);
      for (const [kind, key] of [['deliv', 'ok'], ['surv', 'sos']]) {
        for (const id of post[kind]) {
          if (pre[kind].has(id)) continue;
          if (kind === 'surv' && post.deliv.has(id) && !pre.deliv.has(id) && n !== sim.base) continue;
          const from = (adj.get(n) || []).find((m) => before.get(m)?.[kind].has(id));
          if (from) flights.push({ a: from, b: n, t0: now, col: C[key] });
          rings.push({ n, t0: now + (from ? 260 : 0), col: n === sim.base && kind === 'deliv' ? C.ok : C[key], big: n === sim.base && kind === 'deliv' });
        }
      }
      if (pre.hub !== post.hub && R.isHub(n.state)) rings.push({ n, t0: now, col: C.hub, big: true });
    }
    if (flights.length > 300) flights.splice(0, flights.length - 300);
  }

  function advance() {
    for (let i = 0; i < SPEED; i++) {
      const tickNext = sim.steps % TICK_STEPS === 0;   // sim.step runs a radio tick on this step
      const before = tickNext ? new Map(nodes().map((n) => [n, summary(n)])) : null;
      sim.step();
      if (before) animateNews(before);
    }
    if (sim.tick !== lastTick) { lastTick = sim.tick; onTick(); }
  }

  function onTick() {
    const found = sim.survivors.filter((s) => s.foundBy);
    const atBase = Object.keys(sim.base.state.survivors).length;
    if (found.length) reach('find');
    if (atBase) { reach('relay'); if (firstDelivery == null) firstDelivery = sim.tick; }
    // Autoplay fails the hub once the story has reached base, unless a judge already broke something.
    if (!touched && failedHub == null && ((firstDelivery != null && sim.tick >= firstDelivery + AUTO_FAIL_AFTER) || sim.tick >= AUTO_FAIL_LATEST)) failHub(true);
    if (failedHub != null && takeoverAt == null) {
      const hub = sim.currentHub();
      if (hub != null && hub !== failedHub) {
        takeoverAt = sim.tick; reach('takeover');
        readout.hub.classList.remove('flash'); void readout.hub.offsetWidth; readout.hub.classList.add('flash');
      }
    }
    if (lastLog) note.innerHTML = lastLog;
    const st = status();
    readout.base.textContent = `${atBase} / ${found.length}`;
    readout.live.textContent = `${st.live} / ${DRONES}`;
    readout.hub.innerHTML = st.hub == null ? '—' : st.hubDown ? `drone ${failedHub} down <small>electing…</small>` : `drone ${st.hub}${st.epoch ? ` <small>epoch ${st.epoch}</small>` : ''}`;
    readout.hub.classList.toggle('down', st.hubDown);
    readout.cov.textContent = `${Math.round(sim.coverage() * 100)}%`;
    onChange(st);
    if (!touched && sim.tick >= RESTART_AT) reset();
  }

  function status() {
    const hub = sim.currentHub();
    const hd = sim.drones.find((d) => d.id === hub);
    return { hub, epoch: hd ? hd.state.hub.epoch : 0, live: sim.drones.filter((d) => d.alive).length, radio: sim.radio, hubDown: failedHub != null && takeoverAt == null };
  }

  function failHub(auto = false) {
    const hub = sim.currentHub();
    const d = sim.drones.find((x) => x.id === hub && x.alive);
    if (!d) return null;
    if (!auto) touched = true;
    sim.fail(d, performance.now());
    failedHub = d.id; takeoverAt = null;
    reach('fail');
    rings.push({ n: d, t0: performance.now(), col: C.bad, big: true });
    note.innerHTML = `<b>Drone ${d.id} failed. It was the hub.</b>${auto ? ' (autoplay)' : ''} Watch the gold ring move.`;
    onChange(status());
    return d.id;
  }

  function failRandom() {
    const live = sim.drones.filter((d) => d.alive && d.id !== sim.currentHub());
    if (!live.length) return null;
    touched = true;
    const d = live[Math.floor(Math.random() * live.length)];
    sim.fail(d, performance.now());
    rings.push({ n: d, t0: performance.now(), col: C.bad, big: true });
    onChange(status());
    return d.id;
  }

  function toggleRadio() {
    touched = true;
    sim.radio = !sim.radio;
    note.innerHTML = sim.radio ? '<b>Radio back.</b> The drones swap memories and base catches up.' : '<b>All radio cut.</b> Every drone keeps searching on its own memory.';
    onChange(status());
    return sim.radio;
  }

  // ───────── drawing ─────────
  function draw(now) {
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(relief, 0, 0);

    // searched ground, lightly lit
    ctx.fillStyle = 'rgba(120,220,255,.07)';
    for (const k of sim.truthVisited) { const [c, r] = k.split(','); ctx.fillRect(c * CELL, r * CELL, CELL, CELL); }

    // blocked links
    ctx.setLineDash([4, 6]); ctx.lineWidth = 1.2; ctx.strokeStyle = 'rgba(255,93,93,.55)';
    ctx.beginPath(); for (const [a, b] of sim.blocked) { ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); } ctx.stroke();
    // live links: soft glow + bright core with moving dashes
    ctx.setLineDash([]); ctx.lineWidth = 5; ctx.strokeStyle = 'rgba(94,230,214,.14)';
    ctx.beginPath(); for (const [a, b] of sim.links) { ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); } ctx.stroke();
    ctx.setLineDash([7, 5]); ctx.lineDashOffset = -now / 40; ctx.lineWidth = 1.6; ctx.strokeStyle = 'rgba(94,230,214,.85)';
    ctx.beginPath(); for (const [a, b] of sim.links) { ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); } ctx.stroke();
    ctx.setLineDash([]);

    // people
    for (const s of sim.survivors) {
      const atBase = !!sim.base.state.survivors[s.id];
      const col = !s.foundBy ? 'rgba(200,215,235,.28)' : atBase ? C.ok : C.sos;
      if (s.foundBy && !atBase) {
        const p = (now / 900) % 1;
        ctx.strokeStyle = `rgba(255,138,92,${1 - p})`; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(s.x, s.y, 7 + p * 16, 0, 7); ctx.stroke();
      }
      ctx.fillStyle = col; ctx.beginPath(); ctx.arc(s.x, s.y, s.foundBy ? 7 : 4, 0, 7); ctx.fill();
      if (s.foundBy) {
        ctx.font = '700 12px Inter, sans-serif'; ctx.textAlign = 'center';
        ctx.fillStyle = col; ctx.fillText(atBase ? 'AT BASE' : 'SOS', s.x, s.y - 14);
      }
    }

    // message flights
    flights = flights.filter((f) => now - f.t0 < 420);
    for (const f of flights) {
      const k = Math.min(1, Math.max(0, (now - f.t0) / 300));
      const x = f.a.x + (f.b.x - f.a.x) * k, y = f.a.y + (f.b.y - f.a.y) * k;
      ctx.fillStyle = f.col; ctx.shadowColor = f.col; ctx.shadowBlur = 12;
      ctx.beginPath(); ctx.arc(x, y, 4, 0, 7); ctx.fill(); ctx.shadowBlur = 0;
    }

    // base
    ctx.fillStyle = 'rgba(4,12,30,.8)'; ctx.strokeStyle = C.ice; ctx.lineWidth = 1.5;
    roundRect(BASE.x - 32, BASE.y - 14, 64, 26, 8); ctx.fill(); ctx.stroke();
    ctx.fillStyle = C.ice; ctx.font = '700 13px Sora, Inter, sans-serif'; ctx.textAlign = 'center'; ctx.fillText('BASE', BASE.x, BASE.y + 4.5);

    // drones
    const hub = sim.currentHub();
    for (const d of sim.drones) {
      if (!d.alive) {
        ctx.strokeStyle = 'rgba(255,93,93,.75)'; ctx.lineWidth = 2.2;
        ctx.beginPath(); ctx.moveTo(d.x - 7, d.y - 7); ctx.lineTo(d.x + 7, d.y + 7); ctx.moveTo(d.x + 7, d.y - 7); ctx.lineTo(d.x - 7, d.y + 7); ctx.stroke();
        ctx.fillStyle = 'rgba(255,93,93,.8)'; ctx.font = '600 12px Inter, sans-serif'; ctx.textAlign = 'center'; ctx.fillText(`${d.id} down`, d.x, d.y + 24);
        continue;
      }
      if (d.id === hub) {
        const p = 0.5 + 0.5 * Math.sin(now / 300);
        ctx.fillStyle = `rgba(246,196,83,${0.12 + p * 0.1})`; ctx.beginPath(); ctx.arc(d.x, d.y, 20 + p * 3, 0, 7); ctx.fill();
        ctx.strokeStyle = C.hub; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.arc(d.x, d.y, 16, 0, 7); ctx.stroke();
        ctx.fillStyle = C.hub; ctx.font = '700 12px Sora, Inter, sans-serif'; ctx.textAlign = 'center'; ctx.fillText('HUB', d.x, d.y - 23);
      }
      ctx.strokeStyle = MODE[d.commsMode] || C.link; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(d.x, d.y, 11, 0, 7); ctx.stroke();
      ctx.fillStyle = C.ice; ctx.beginPath(); ctx.arc(d.x, d.y, 5.5, 0, 7); ctx.fill();
      ctx.fillStyle = 'rgba(234,246,255,.92)'; ctx.font = '600 13px Inter, sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(d.muling ? `${d.id} · carrying report` : `${d.id}`, d.x, d.y + 26);
    }

    // rings where news lands
    rings = rings.filter((r) => now - r.t0 < (r.big ? 1400 : 700));
    for (const r of rings) {
      const p = (now - r.t0) / (r.big ? 1400 : 700);
      if (p < 0) continue;
      ctx.strokeStyle = r.col; ctx.globalAlpha = 1 - p; ctx.lineWidth = r.big ? 3 : 2;
      ctx.beginPath(); ctx.arc(r.n.x, r.n.y, 10 + p * (r.big ? 46 : 18), 0, 7); ctx.stroke();
    }
    ctx.globalAlpha = 1;

    if (!sim.radio) {
      ctx.fillStyle = 'rgba(255,93,93,.08)'; ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = C.bad; ctx.font = '700 13px Sora, Inter, sans-serif'; ctx.textAlign = 'right'; ctx.fillText('RADIO CUT', W - 16, 28);
    }
  }
  function roundRect(x, y, w, h, r) { ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, y, w, h, r) : ctx.rect(x, y, w, h); }

  // Keep simulating even when scrolled away (the phone preview drives it), but only draw when visible.
  let visible = false;
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; }).observe(canvas);
  function loop(t) {
    advance();
    if (visible) draw(t);
    requestAnimationFrame(loop);
  }

  reset();
  draw(performance.now());
  requestAnimationFrame(loop);
  const bench = (n = 60) => { const t0 = performance.now(); for (let i = 0; i < n; i++) advance(); const t1 = performance.now(); for (let i = 0; i < n; i++) draw(t1); return { advanceMs: (t1 - t0) / n, drawMs: (performance.now() - t1) / n, tick: sim.tick }; };
  return { failHub: () => failHub(false), failRandom, toggleRadio, replay: reset, status, bench };
}
