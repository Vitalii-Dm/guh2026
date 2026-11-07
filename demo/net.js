// net.js — direct links between devices, used by the phone page and the big
// screen. The helper only introduces devices; messages then go device to device
// over WebRTC data channels. What a drone may hear is decided elsewhere (see
// canHear in drone.js): this file only says who is really connected.

const SILENCE_MS = 1000;         // a peer is lost after this long with no message
const HIDDEN_SILENCE_MS = 5000;  // the same for a peer whose page is hidden, as its timers slow down
const REBUILD_AFTER_MS = 2000;   // how long a link must be silent before replacing it
const REOFFER_MS = 4000;         // gap between attempts to rebuild
const GATHER_MS = 1000;          // longest wait for this device's addresses. Local ones arrive in milliseconds
const POLL_MS = 500;             // how often to ask the helper for offers
const POLL_TIMEOUT_MS = 2000;    // give up on a request after this long
const STALL_MS = 500;            // a gap this long between ticks means this device stopped, not its peers
const HIDDEN_STALL_MS = 3000;    // the same while hidden, as a hidden page's timers run about once a second
const PING_MS = 160;             // one swarm tick
const ROUTE_MS = 1000;           // how often to read a link's route
const MAX_BUFFERED = 64 * 1024;  // stop queueing on a link that has stalled
const OFFERS_BEFORE_REPLACING = 2; // offers from a peer that can't hear us, before a working link gives way

/**
 * @param {object} o
 * @param {string} o.selfId         this device's id. Of any two devices, the lower id makes the offer
 * @param {(msg: string) => void} [o.onLog]
 * @param {RTCIceServer[]} [o.iceServers]
 * The rest are the browser's own, passed in so that tests can replace them.
 */
export function createNet({
  selfId,
  onLog = () => {},
  iceServers = [{ urls: 'stun:stun.l.google.com:19302' }],
  rtc = globalThis.RTCPeerConnection,
  request = (...args) => fetch(...args),
  now = Date.now,
  isHidden = () => globalThis.document?.hidden ?? false,
}) {
  const boot = Math.random().toString(36).slice(2);   // tells peers this page is a new one
  const peers = new Map();
  const timers = [];
  const messageHandlers = [], peerHandlers = [];
  let listed = new Set();     // devices the helper says are around
  let helperUp = null;
  let radioOn = true, radioOnAt = 0;
  let judgeFrom = 0, lastTick = 0, polling = false, stopped = false;

  function peerFor(id) {
    if (!peers.has(id)) {
      peers.set(id, { id, link: null, pending: null, incoming: null, gen: 0, lastOffer: 0, lastHeard: 0,
        up: false, peerHidden: false, rtt: null, route: null, offersWhileUp: 0, lostAt: null });
    }
    return peers.get(id);
  }

  function setUp(p, up) {
    if (p.up === up) return;
    p.up = up;
    if (up) {
      const gap = p.lostAt ? ` after ${((now() - p.lostAt) / 1000).toFixed(1)} s` : '';
      onLog(`${p.id}: LINK UP${gap}`);
      p.lostAt = null;
      p.pending?.pc.close();
      p.pending = null;
    } else {
      p.lostAt = now();
      p.offersWhileUp = 0;
      onLog(`${p.id}: LINK LOST`);
    }
    for (const fn of peerHandlers) fn(p.id, up);
  }

  function write(p, message) {
    const { ch } = p.link ?? {};
    if (ch?.readyState !== 'open' || ch.bufferedAmount > MAX_BUFFERED) return false;
    try { ch.send(JSON.stringify(message)); return true; } catch { return false; }
  }

  function useChannel(p, ch) {
    ch.onclose = () => { if (p.link?.ch === ch) onLog(`${p.id}: channel closed`); };
    ch.onmessage = (e) => {
      if (p.link?.ch !== ch || !radioOn) return;
      p.lastHeard = now();
      const m = JSON.parse(e.data);
      p.peerHidden = Boolean(m.hidden);
      setUp(p, true);
      if (m.ping) write(p, { pong: m.ping, hidden: isHidden() });
      if (m.pong) p.rtt = now() - m.pong;
      if (m.body !== undefined) for (const fn of messageHandlers) fn(m.body, p.id);
    };
  }

  function adopt(p, pc, ch) {
    p.link?.pc.close();
    p.link = { pc, ch };
    useChannel(p, ch);
  }

  function gathered(pc) {
    return new Promise((done) => {
      if (pc.iceGatheringState === 'complete') return done();
      const timer = setTimeout(done, GATHER_MS);
      pc.addEventListener('icegatheringstatechange', () => {
        if (pc.iceGatheringState === 'complete') { clearTimeout(timer); done(); }
      });
    });
  }

  const post = (to, data) => request('/signal', { method: 'POST', body: JSON.stringify({ from: selfId, to, data }) });

  async function offer(p) {
    p.lastOffer = now();
    p.pending?.pc.close();
    const gen = now();
    const pc = new rtc({ iceServers });
    p.pending = { pc, ch: pc.createDataChannel('swarm'), gen };
    await pc.setLocalDescription(await pc.createOffer());
    await gathered(pc);
    if (stopped || p.pending?.gen !== gen) return;
    await post(p.id, { kind: 'offer', gen, boot, sdp: pc.localDescription.sdp });
    onLog(`${p.id}: offer sent`);
  }

  async function onOffer(p, { gen, boot: peerBoot, sdp }) {
    if (peerBoot !== p.boot) { p.boot = peerBoot; p.gen = 0; }   // a reloaded page's clock may be behind
    if (!radioOn || gen <= p.gen) return;
    // A late offer must not tear down a link that works. A peer that really
    // can't hear us keeps offering, so a working link gives way on a repeat.
    const heardLately = now() - p.lastHeard < SILENCE_MS;
    if (p.up && heardLately && ++p.offersWhileUp < OFFERS_BEFORE_REPLACING) return onLog(`${p.id}: offer ignored, link is up`);
    p.offersWhileUp = 0;
    p.gen = gen;
    p.incoming?.close();
    const pc = new rtc({ iceServers });
    p.incoming = pc;
    pc.ondatachannel = (e) => {
      if (p.gen !== gen) return;
      p.incoming = null;
      adopt(p, pc, e.channel);
    };
    await pc.setRemoteDescription({ type: 'offer', sdp });
    await pc.setLocalDescription(await pc.createAnswer());
    await gathered(pc);
    if (p.gen !== gen) return;      // a newer offer replaced this one while it waited
    await post(p.id, { kind: 'answer', gen, sdp: pc.localDescription.sdp });
    onLog(`${p.id}: answer sent`);
  }

  async function onAnswer(p, { gen, sdp }) {
    const { pending } = p;
    if (pending?.gen !== gen) return;
    p.pending = null;
    await pending.pc.setRemoteDescription({ type: 'answer', sdp });
    adopt(p, pending.pc, pending.ch);
  }

  async function poll() {
    if (polling || stopped) return;
    polling = true;
    try {
      const res = await request(`/signal?for=${selfId}`, { signal: AbortSignal.timeout?.(POLL_TIMEOUT_MS) });
      if (stopped) return;
      const { messages, peers: ids } = await res.json();
      if (helperUp !== true) onLog('helper reachable');
      helperUp = true;
      listed = new Set(ids);
      for (const id of ids) peerFor(id);
      // Not awaited: an answer must not wait behind another peer's address gathering.
      for (const { from, data } of messages) {
        const handle = data.kind === 'offer' ? onOffer : onAnswer;
        handle(peerFor(from), data).catch((e) => onLog(`${from}: ${data.kind} failed: ${e.message}`));
      }
    } catch {
      if (helperUp !== false) onLog('helper not reachable');
      helperUp = false;
    } finally {
      polling = false;
    }
  }

  function tick() {
    const t = now();
    const hidden = isHidden();
    // Silence means nothing while this device was stopped or slowed, or just after.
    if (lastTick && t - lastTick >= (hidden ? HIDDEN_STALL_MS : STALL_MS)) judgeFrom = t + SILENCE_MS;
    lastTick = t;
    const canJudge = radioOn && !hidden && t >= judgeFrom;

    for (const p of peers.values()) {
      if (radioOn) write(p, { ping: t, hidden });
      const limit = p.peerHidden ? HIDDEN_SILENCE_MS : SILENCE_MS;
      // A closed channel needs no judging, so a hidden device still acts on it.
      const closed = p.link && p.link.ch.readyState !== 'open' && p.link.ch.readyState !== 'connecting';
      if (p.up && radioOn && (closed || (canJudge && t - p.lastHeard >= limit))) setUp(p, false);
      const stale = t - Math.max(p.lastHeard, radioOnAt) >= REBUILD_AFTER_MS;
      if (radioOn && t >= judgeFrom && !p.up && stale && helperUp && listed.has(p.id) && selfId < p.id && t - p.lastOffer >= REOFFER_MS) {
        offer(p).catch((e) => onLog(`${p.id}: offer failed: ${e.message}`));
      }
    }
  }

  async function readRoutes() {
    for (const p of peers.values()) {
      if (!p.up || !p.link?.pc.getStats) continue;
      const stats = await p.link.pc.getStats();
      const all = [...stats.values()];
      const transport = all.find((s) => s.type === 'transport');
      const pair = stats.get(transport?.selectedCandidatePairId) ?? all.find((s) => s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded');
      if (!pair) continue;
      const route = `${stats.get(pair.localCandidateId)?.candidateType} to ${stats.get(pair.remoteCandidateId)?.candidateType}`;
      if (route !== p.route) { p.route = route; onLog(`${p.id}: route is ${route}`); }
    }
  }

  const net = {
    selfId,
    poll,
    tick,

    /** Begin finding and keeping links. */
    start() {
      const onOnline = () => { for (const p of peers.values()) p.lastOffer = 0; poll(); };
      const onVisibility = () => { if (radioOn && !stopped) for (const p of peers.values()) write(p, { ping: now(), hidden: isHidden() }); };
      globalThis.addEventListener?.('online', onOnline);
      // Tell peers before this page freezes, so they allow it the longer limit.
      globalThis.document?.addEventListener('visibilitychange', onVisibility);
      timers.push(setInterval(poll, POLL_MS), setInterval(tick, PING_MS), setInterval(() => readRoutes().catch(() => {}), ROUTE_MS));
      poll();
    },

    /** Stop for good: this page is no longer part of the mission. */
    stop() {
      stopped = true;
      timers.splice(0).forEach(clearInterval);
      for (const p of peers.values()) { p.link?.pc.close(); p.pending?.pc.close(); p.incoming?.close(); }
    },

    /** Send to every linked device. */
    send(body) { for (const p of peers.values()) if (radioOn) write(p, { body, hidden: isHidden() }); },

    /** Send to one device. Returns false if it could not be sent. */
    sendTo(id, body) { const p = peers.get(id); return Boolean(p && radioOn && write(p, { body, hidden: isHidden() })); },

    /** fn(body, fromId) for each message. */
    onMessage(fn) { messageHandlers.push(fn); },

    /** fn(id, up) when a link is gained or lost. */
    onPeer(fn) { peerHandlers.push(fn); },

    peers() {
      return [...peers.values()].map(({ id, up, rtt, route, lostAt, peerHidden }) => ({ id, up, rtt, route, lostAt, hidden: peerHidden, present: listed.has(id) }));
    },

    helperReachable: () => helperUp,

    /** The manual radio switch: stop everything both ways, but keep the links open. */
    setRadio(on) {
      if (on === radioOn) return;
      radioOn = on;
      onLog(`radio ${on ? 'on' : 'off'}`);
      if (on) radioOnAt = now();
      else for (const p of peers.values()) setUp(p, false);
    },

    radioOn: () => radioOn,
  };
  return net;
}
