// The connection layer on a fake network: a stand-in for the browser's WebRTC
// and for the helper, with a clock the tests move by hand. This covers the
// decisions net.js makes. Real links are checked on real devices.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNet } from '../net.js';

class World {
  time = 1000;
  queues = new Map();      // id -> messages waiting at the helper
  polled = new Map();      // id -> last poll
  offline = new Set();     // devices with no network at all
  suspended = new Set();   // devices whose page has stopped running
  channels = new Set();
  helperDown = false;
  pcs = new Map();         // sdp token -> FakePC
  connections = 0;
  count = 0;

  /** Aeroplane mode: as on a real phone, its connections never recover. */
  cutOff(id) {
    this.offline.add(id);
    for (const ch of this.channels) if (ch.pc.owner === id || ch.other?.pc.owner === id) ch.dead = true;
  }

  request(id) {
    return async (url, options) => {
      if (this.offline.has(id) || this.helperDown) throw new Error('unreachable');
      if (options?.method === 'POST') {
        const { from, to, data } = JSON.parse(options.body);
        const q = (this.queues.get(to) ?? []).filter((m) => m.from !== from || m.data.kind !== data.kind);
        this.queues.set(to, [...q, { from, data }]);
        return {};
      }
      this.polled.set(id, this.time);
      const messages = this.queues.get(id) ?? [];
      this.queues.delete(id);
      const peers = [...this.polled].filter(([p, t]) => p !== id && this.time - t <= 5000).map(([p]) => p);
      return { json: async () => ({ messages, peers }) };
    };
  }
}

function fakeRtc(world, owner) {
  return class FakePC {
    iceGatheringState = 'complete';
    closed = false;
    owner = owner;
    token = `pc${++world.count}`;
    channel = null;
    createDataChannel() { this.channel = new FakeChannel(world, this); return this.channel; }
    async createOffer() { world.pcs.set(this.token, this); return { type: 'offer', sdp: this.token }; }
    async createAnswer() { world.pcs.set(this.token, this); return { type: 'answer', sdp: this.token }; }
    async setLocalDescription(d) { this.localDescription = d; }
    async setRemoteDescription(d) {
      if (d.type !== 'answer') { this.remote = world.pcs.get(d.sdp); return; }
      const answerer = world.pcs.get(d.sdp);
      const mine = this.channel, theirs = new FakeChannel(world, answerer);
      mine.other = theirs; theirs.other = mine;
      mine.readyState = theirs.readyState = 'open';
      world.connections++;
      answerer.channel = theirs;
      answerer.ondatachannel?.({ channel: theirs });
    }
    addEventListener() {}
    close() { this.closed = true; if (this.channel) this.channel.readyState = 'closed'; }
  };
}

class FakeChannel {
  readyState = 'connecting';
  bufferedAmount = 0;
  other = null;
  dead = false;
  constructor(world, pc) { this.world = world; this.pc = pc; world.channels.add(this); }
  send(text) {
    const { other, world, pc } = this;
    if (!other || other.readyState !== 'open' || other.pc.closed || this.dead) return;
    if (world.offline.has(pc.owner) || world.offline.has(other.pc.owner) || world.suspended.has(other.pc.owner)) return;
    other.onmessage?.({ data: text });
  }
}

function device(world, selfId, options = {}) {
  const logs = [], inbox = [];
  const state = { hidden: false };
  const net = createNet({ selfId, rtc: fakeRtc(world, selfId), request: world.request(selfId), now: () => world.time,
    isHidden: () => state.hidden, onLog: (m) => logs.push(m), ...options });
  net.onMessage((body, from) => inbox.push({ body, from }));
  return { net, logs, inbox, state, id: selfId };
}

/** Move the clock, with every device polling and ticking as it would in a browser. */
async function run(world, devices, ms) {
  for (let t = 0; t < ms; t += 80) {
    world.time += 80;
    for (const d of devices) {
      if (t % 480 === 0) await d.net.poll();
      if (t % 160 === 0 && !d.frozen) d.net.tick();
      await new Promise((done) => setImmediate(done));
    }
  }
}

const peer = (d, id) => d.net.peers().find((p) => p.id === id);
async function linked() {
  const world = new World();
  const a = device(world, 'a'), b = device(world, 'b');
  await run(world, [a, b], 8000);
  assert.ok(peer(a, 'b').up && peer(b, 'a').up, 'should be linked');
  return { world, a, b, all: [a, b] };
}

test('two devices link, and messages reach the right place', async () => {
  const { world, a, b, all } = await linked();
  const c = device(world, 'c');
  await run(world, [...all, c], 8000);
  assert.equal(world.connections, 3);
  a.net.send({ hello: 1 });
  assert.deepEqual([b.inbox.length, c.inbox.length], [1, 1]);
  assert.equal(b.net.sendTo('c', { direct: 1 }), true);
  assert.deepEqual(c.inbox.at(-1), { body: { direct: 1 }, from: 'b' });
  assert.equal(a.inbox.length, 0);
});

test('a lost peer is noticed within a second, on both sides', async () => {
  const { world, a, b, all } = await linked();
  const changes = [];
  a.net.onPeer((id, up) => changes.push([id, up]));
  world.cutOff('b');
  await run(world, all, 1300);
  assert.equal(peer(a, 'b').up, false);
  assert.equal(peer(b, 'a').up, false);
  assert.deepEqual(changes, [['b', false]]);
});

for (const who of ['a', 'b']) {
  test(`after an outage on ${who}, the link comes back once and stays`, async () => {
    const { world, a, b, all } = await linked();
    const before = world.connections;
    world.cutOff(who);
    await run(world, all, 30000);
    world.offline.delete(who);
    await run(world, all, 6000);
    assert.ok(peer(a, 'b').up && peer(b, 'a').up, 'should be back');
    assert.equal(world.connections, before + 1, 'one new connection, not a run of them');
    const settled = world.connections;
    await run(world, all, 20000);
    assert.equal(world.connections, settled, 'a working link is left alone');
    assert.ok(peer(a, 'b').up && peer(b, 'a').up);
    assert.equal(a.logs.filter((l) => l.includes('LOST')).length, 1);
    assert.equal(b.logs.filter((l) => l.includes('LOST')).length, 1);
  });
}

test('a single late offer does not replace a working link', async () => {
  const { world, b, all } = await linked();
  const before = world.connections;
  world.queues.set('b', [{ from: 'a', data: { kind: 'offer', gen: world.time + 1, sdp: 'stale' } }]);
  await run(world, all, 3000);
  assert.equal(world.connections, before);
  assert.ok(peer(b, 'a').up);
  assert.ok(b.logs.some((l) => l.includes('offer ignored')));
});

test('a peer that keeps offering replaces a link only it finds broken', async () => {
  const { world, b } = await linked();
  const pc = new (fakeRtc(world, 'a'))();
  pc.createDataChannel();
  await pc.createOffer();
  for (const gen of [world.time + 1, world.time + 2]) {
    world.queues.set('b', [{ from: 'a', data: { kind: 'offer', gen, sdp: pc.token } }]);
    await b.net.poll();
    await new Promise((done) => setImmediate(done));
  }
  assert.ok(b.logs.includes('a: offer ignored, link is up'), 'the first is ignored');
  assert.ok(b.logs.at(-1) === 'a: answer sent', 'the repeat gets an answer');
});

test('a hidden peer gets longer before it counts as lost', async () => {
  const { world, a, b, all } = await linked();
  b.state.hidden = true;
  await run(world, all, 500);
  b.frozen = true;                 // the page stops running altogether
  world.suspended.add('b');
  await run(world, all, 3000);
  assert.equal(peer(a, 'b').up, true, 'a slow hidden page is not a lost one');
  await run(world, all, 3000);
  assert.equal(peer(a, 'b').up, false, 'but it does not last for ever');
});

test('a hidden device does not call anyone lost, and waits a moment on returning', async () => {
  const { world, a, all } = await linked();
  a.state.hidden = true;
  world.offline.add('b');
  await run(world, all, 6000);
  assert.equal(peer(a, 'b').up, true);
  world.offline.delete('b');
  a.state.hidden = false;
  await run(world, all, 500);
  assert.equal(peer(a, 'b').up, true);
  assert.equal(a.logs.filter((l) => l.includes('LOST')).length, 0);
});

test('the radio switch stops everything both ways and keeps the link', async () => {
  const { world, a, b, all } = await linked();
  const before = world.connections;
  b.net.setRadio(false);
  await run(world, all, 1300);
  assert.equal(peer(a, 'b').up, false, 'peers see it go');
  assert.equal(peer(b, 'a').up, false);
  a.net.send({ x: 1 });
  b.net.send({ y: 1 });
  assert.deepEqual([a.inbox.length, b.inbox.length], [0, 0]);

  await run(world, all, 20000);
  b.net.setRadio(true);
  await run(world, all, 1500);
  assert.ok(peer(a, 'b').up && peer(b, 'a').up);
  a.net.send({ x: 2 });
  assert.equal(b.inbox.length, 1);
  assert.equal(world.connections, before, 'the same link comes back');
});

test('a device that stalled does not call everyone lost when it wakes', async () => {
  const { world, a, all } = await linked();
  world.time += 1500;              // its timers stopped, and messages are still queued
  a.net.tick();
  await run(world, all, 400);
  assert.equal(a.logs.filter((l) => l.includes('LOST')).length, 0);
});

test('a reloaded offerer is heard even if its clock went backwards', async () => {
  const { world, b } = await linked();
  const newer = peer(b, 'a') && world.time + 1;
  world.queues.set('b', [{ from: 'a', data: { kind: 'offer', gen: newer, boot: 'one', sdp: 'x' } }]);
  await b.net.poll();
  await new Promise((done) => setImmediate(done));
  const pc = new (fakeRtc(world, 'a'))();
  pc.createDataChannel();
  await pc.createOffer();
  world.queues.set('b', [{ from: 'a', data: { kind: 'offer', gen: 5, boot: 'two', sdp: pc.token } }]);
  await b.net.poll();
  await new Promise((done) => setImmediate(done));
  assert.ok(b.logs.at(-1) === 'a: answer sent', 'an old time from a new page still gets an answer');
});

test('with the helper gone, links carry on', async () => {
  const { world, a, b, all } = await linked();
  const before = world.connections;
  world.helperDown = true;
  await run(world, all, 20000);
  assert.equal(a.net.helperReachable(), false);
  a.net.send({ still: 'here' });
  assert.deepEqual(b.inbox.at(-1).body, { still: 'here' });
  assert.ok(peer(a, 'b').up && peer(b, 'a').up);
  assert.equal(world.connections, before);
});
