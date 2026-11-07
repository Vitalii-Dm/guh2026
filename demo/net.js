// net.js — direct links between devices, used by the phone page and the big
// screen. The helper only introduces devices; messages then go device to device
// over WebRTC data channels. What a drone may hear is decided elsewhere (see
// canHear in drone.js): this file only says who is really connected.

const SILENCE_MS = 1000;         // a peer is lost after this long with no message
const HIDDEN_SILENCE_MS = 5000;  // the same for a peer whose page is hidden, as its timers slow down
const REBUILD_AFTER_MS = 2000;   // how long a link must be silent before replacing it
const REOFFER_MS = 4000;         // gap between attempts to rebuild
const GATHER_MS = 2500;          // longest wait for this device's addresses
const POLL_MS = 500;             // how often to ask the helper for offers
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
  const peers = new Map();
  const messageHandlers = [], peerHandlers = [];
  let listed = new Set();     // devices the helper says are around
  let helperUp = null;
  let radioOn = true, radioOnAt = 0;
  let wasHidden = false, judgeFrom = 0;

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
    if (p.pending?.gen !== gen) return;
    await post(p.id, { kind: 'offer', gen, sdp: pc.localDescription.sdp });
    onLog(`${p.id}: offer sent`);
  }

  async function onOffer(p, { gen, sdp }) {
    if (!radioOn || gen <= p.gen) return;
    // A late offer must not tear down a link that works. A peer that really
    // can't hear us keeps offering, so a working link gives way on a repeat.
    if (p.up && ++p.offersWhileUp < OFFERS_BEFORE_REPLACING) return onLog(`${p.id}: offer ignored, link is up`);
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
    try {
      const res = await request(`/signal?for=${selfId}`);
      const { messages, peers: ids } = await res.json();
      if (helperUp !== true) onLog('helper reachable');
      helperUp = true;
      listed = new Set(ids);
      for (const id of ids) peerFor(id);
      for (const { from, data } of messages) {
        const handle = data.kind === 'offer' ? onOffer : onAnswer;
        await handle(peerFor(from), data).catch((e) => onLog(`${from}: ${data.kind} failed: ${e.message}`));
      }
    } catch {
      if (helperUp !== false) onLog('helper not reachable');
      helperUp = false;
    }
  }

  function tick() {
    const t = now();
    const hidden = isHidden();
    // Silence means nothing while our own timers are slowed, or just after.
    if (wasHidden && !hidden) judgeFrom = t + SILENCE_MS;
    wasHidden = hidden;
    const canJudge = radioOn && !hidden && t >= judgeFrom;

    for (const p of peers.values()) {
      if (radioOn) write(p, { ping: t, hidden });
      const limit = p.peerHidden ? HIDDEN_SILENCE_MS : SILENCE_MS;
      if (canJudge && p.up && t - p.lastHeard >= limit) setUp(p, false);
      const stale = t - Math.max(p.lastHeard, radioOnAt) >= REBUILD_AFTER_MS;
      if (canJudge && !p.up && stale && helperUp && listed.has(p.id) && selfId < p.id && t - p.lastOffer >= REOFFER_MS) {
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
      globalThis.addEventListener?.('online', onOnline);
      setInterval(poll, POLL_MS);
      setInterval(tick, PING_MS);
      setInterval(() => readRoutes().catch(() => {}), ROUTE_MS);
      poll();
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
