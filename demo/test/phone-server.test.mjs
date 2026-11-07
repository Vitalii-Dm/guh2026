// The helper: passes messages between devices and serves only the public folders.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHelper, localAddressOf, showAddress } from '../phone-server.mjs';

async function withHelper(run, options) {
  const helper = createHelper(options);
  await new Promise((done) => helper.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${helper.address().port}`;
  try { await run(base); } finally { helper.close(); helper.closeAllConnections(); }
}

const signal = (base, body) => fetch(`${base}/signal`, { method: 'POST', body: JSON.stringify(body) });
const poll = async (base, id) => (await fetch(`${base}/signal?for=${id}`)).json();

test('a message waits for its device and is delivered once', () => withHelper(async (base) => {
  await signal(base, { from: 'a', to: 'b', data: { kind: 'offer' } });
  assert.deepEqual((await poll(base, 'b')).messages, [{ from: 'a', data: { kind: 'offer' } }]);
  assert.deepEqual((await poll(base, 'b')).messages, []);
}));

test('only the newest offer from a device is kept', () => withHelper(async (base) => {
  await signal(base, { from: 'a', to: 'c', data: { kind: 'offer', gen: 1 } });
  await signal(base, { from: 'b', to: 'c', data: { kind: 'offer', gen: 2 } });
  await signal(base, { from: 'a', to: 'c', data: { kind: 'answer', gen: 3 } });
  await signal(base, { from: 'a', to: 'c', data: { kind: 'offer', gen: 4 } });
  const gens = (await poll(base, 'c')).messages.map((m) => m.data.gen);
  assert.deepEqual(gens.sort(), [2, 3, 4]);
}));

test('devices are listed to each other until they stop polling', async () => {
  let time = 0;
  await withHelper(async (base) => {
    await poll(base, 'a');
    assert.deepEqual((await poll(base, 'b')).peers, ['a']);
    time = 6000;
    assert.deepEqual((await poll(base, 'b')).peers, []);
  }, { now: () => time });
});

test('a hidden .local address is replaced, and nothing else changes', () => {
  const line = (host) => `a=candidate:1 1 udp 2122260223 ${host} 54321 typ host\r\no=- 1 2 IN IP4 127.0.0.1\r\n`;
  assert.equal(showAddress(line('8f14e45f-ceea-467f-a9a3-111122223333.local'), '10.0.0.7'), line('10.0.0.7'));
  assert.equal(showAddress(line('192.168.1.5'), '10.0.0.7'), line('192.168.1.5'));
});

test('only addresses on the local network are used', () => {
  const req = (remoteAddress, headers = {}) => ({ socket: { remoteAddress }, headers });
  assert.equal(localAddressOf(req('::ffff:10.205.1.9')), '10.205.1.9');
  assert.equal(localAddressOf(req('192.168.0.4')), '192.168.0.4');
  assert.equal(localAddressOf(req('8.8.8.8')), null);
  assert.equal(localAddressOf(req('10.0.0.1', { 'cf-connecting-ip': '8.8.8.8' })), null);
});

test('a device report can be read back', () => withHelper(async (base) => {
  await fetch(`${base}/report`, { method: 'POST', body: JSON.stringify({ id: 'a', text: 'log' }) });
  assert.equal((await (await fetch(`${base}/report`)).json()).a.text, 'log');
}));

const postJson = async (base, path, body = {}) => {
  const res = await fetch(`${base}${path}`, { method: 'POST', body: JSON.stringify(body) });
  return { status: res.status, ...(await res.json()) };
};

test('phones get drones 1, 2 and 3, keep them, and a fourth is told it is full', () => withHelper(async (base) => {
  assert.equal((await postJson(base, '/join', { key: 'p1' })).error, 'no mission');
  const { id } = await postJson(base, '/mission', { seed: 5 });
  const drones = [];
  for (const key of ['p1', 'p2', 'p3']) drones.push((await postJson(base, '/join', { key })).drone);
  assert.deepEqual(drones, [1, 2, 3]);
  assert.equal((await postJson(base, '/join', { key: 'p2' })).drone, 2, 'a reloaded phone keeps its drone');
  const fourth = await postJson(base, '/join', { key: 'p4' });
  assert.deepEqual([fourth.status, fourth.error], [409, 'full']);
  const mission = await (await fetch(`${base}/mission`)).json();
  assert.deepEqual([mission.id, mission.seed, mission.fleet, mission.drones], [id, 5, 15, [1, 2, 3]]);
  assert.match(mission.joinUrl, /^http:.*\/demo\/phone\.html$/);
}));

test('nobody new joins after launch, and launching twice keeps the first time', async () => {
  let time = 1000;
  await withHelper(async (base) => {
    await postJson(base, '/mission', { seed: 1 });
    await postJson(base, '/join', { key: 'p1' });
    const { launchAt } = await postJson(base, '/launch');
    assert.ok(launchAt > 1000);
    time = 2000;
    assert.equal((await postJson(base, '/launch')).launchAt, launchAt);
    assert.equal((await postJson(base, '/join', { key: 'late' })).error, 'launched');
    assert.equal((await postJson(base, '/join', { key: 'p1' })).drone, 1, 'a reloaded phone can return');
  }, { now: () => time });
});

test('the swarm size travels with the mission, and must be sensible', () => withHelper(async (base) => {
  assert.equal((await postJson(base, '/mission', { seed: 1, fleet: 6 })).fleet, 6);
  assert.equal((await postJson(base, '/join', { key: 'p1' })).fleet, 6);
  for (const fleet of [2, 16, 7.5, 'x']) assert.equal((await postJson(base, '/mission', { seed: 1, fleet })).status, 400, String(fleet));
}));

test('the QR code is served as an image', () => withHelper(async (base) => {
  const res = await fetch(`${base}/qr.svg`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/svg+xml');
  assert.match(await res.text(), /^<svg /);
}));

test('a new mission clears the old one', async () => {
  let time = 1;
  await withHelper(async (base) => {
    await postJson(base, '/mission', { seed: 1 });
    await postJson(base, '/join', { key: 'p1' });
    await postJson(base, '/launch');
    time = 2;
    const next = await postJson(base, '/mission', { seed: 2 });
    assert.deepEqual([next.seed, next.launchAt, next.drones], [2, null, []]);
  }, { now: () => time });
});

test('bad ids and bad bodies are refused', () => withHelper(async (base) => {
  assert.equal((await fetch(`${base}/signal?for=a/b`)).status, 400);
  assert.equal((await signal(base, { from: 'a', to: '../b' })).status, 400);
  assert.equal((await fetch(`${base}/signal`, { method: 'POST', body: 'not json' })).status, 400);
}));

test('files are sent exactly as they are on disk', () => withHelper(async (base) => {
  const path = 'recovery/models/formation-nca.json';
  const sent = await (await fetch(`${base}/${path}`)).text();
  assert.equal(sent, readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8'));
}));

test('only the public folders are served', () => withHelper(async (base) => {
  assert.equal((await fetch(`${base}/demo/phone.html`)).status, 200);
  assert.equal((await fetch(`${base}/demo/`)).status, 200);
  assert.equal((await fetch(`${base}/recovery/swarm-recovery.js`)).status, 200);
  for (const path of ['/package.json', '/.git/config', '/demo/.hidden', '/demo/%2e%2e/package.json', '/demo/..%2f.git/config', '/docs/hub-recovery-plan.md']) {
    assert.equal((await fetch(base + path)).status, 404, path);
  }
}));

test('speed is shared: a change is scheduled ahead and the mission clock never jumps', async () => {
  const { stepsAt, DEFAULT_RATE, SPEED_CHANGE_MS } = await import('../mission.js');
  let time = 1000;
  await withHelper(async (base) => {
    await postJson(base, '/mission', { seed: 1 });
    assert.equal((await postJson(base, '/speed', { rate: 3 })).error, 'bad rate');
    const launched = await postJson(base, '/launch');
    assert.equal(launched.clock.rate, DEFAULT_RATE);
    time = launched.launchAt + 10000;                       // 10 s into the mission
    const before = stepsAt(launched.clock, time);
    const changed = (await postJson(base, '/speed', { rate: 0.5 })).clock;
    // every device still agrees on now, and on the moment the change lands
    assert.ok(Math.abs(stepsAt(changed, time) - before) < 1e-9);
    assert.ok(Math.abs(stepsAt(changed, time + SPEED_CHANGE_MS) - stepsAt(launched.clock, time + SPEED_CHANGE_MS)) < 1e-9);
    // after it, the clock runs at the new rate
    const a = stepsAt(changed, time + SPEED_CHANGE_MS), b = stepsAt(changed, time + SPEED_CHANGE_MS + 1000);
    assert.ok(Math.abs((b - a) - 0.5 * (1000 / 16)) < 1e-6);
  }, { now: () => time });
});
