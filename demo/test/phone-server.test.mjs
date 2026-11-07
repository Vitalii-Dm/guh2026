// The helper: passes messages between devices and serves only the public folders.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { createHelper, isLoopback, localAddressOf, pickLanAddress, showAddress } from '../phone-server.mjs';

async function withHelper(run, options) {
  const helper = createHelper({ logs: true, ...options });
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

test('a device address is the one the helper sees, unless a proxy is in the way', () => {
  const req = (remoteAddress, headers = {}) => ({ socket: { remoteAddress }, headers });
  assert.equal(localAddressOf(req('::ffff:10.205.1.9')), '10.205.1.9');
  assert.equal(localAddressOf(req('100.64.1.2')), '100.64.1.2');
  assert.equal(localAddressOf(req('10.0.0.1', { 'cf-connecting-ip': '8.8.8.8' })), null);
  assert.equal(isLoopback(req('::ffff:127.0.0.1')), true);
  assert.equal(isLoopback(req('10.0.0.1')), false);
});

test('the laptop address skips VPNs, bridges and virtual machines', () => {
  const v4 = (address) => [{ family: 'IPv4', internal: false, address }];
  const interfaces = { lo0: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }], utun4: v4('10.230.0.19'), bridge100: v4('192.168.64.1'), en0: v4('10.205.142.195') };
  assert.equal(pickLanAddress(interfaces, ''), '10.205.142.195');
  assert.equal(pickLanAddress({ utun4: v4('10.230.0.19') }, ''), '10.230.0.19', 'better than nothing');
  assert.equal(pickLanAddress(interfaces, '192.168.1.9'), '192.168.1.9', 'PHONE_HOST wins');
  assert.equal(pickLanAddress({}, ''), null);
  assert.equal(pickLanAddress({ en5: v4('169.254.3.4'), en7: v4('192.168.2.2'), en0: v4('192.168.1.5') }, ''), '192.168.1.5', 'en0 first, and never a self-assigned address');
});

test('a malformed request does not stop the helper', () => withHelper(async (base) => {
  const { port, hostname } = new URL(base);
  for (const path of ['//', '///', '//:', '/\\\\', 'http://[']) {
    await new Promise((done) => {
      const socket = connect(Number(port), hostname, () => socket.write(`GET ${path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`));
      socket.on('data', () => {}); socket.on('close', done); socket.on('error', done);
    });
  }
  assert.equal((await fetch(`${base}/time`)).status, 200);
}));

test('logs are off unless asked for', () => withHelper(async (base) => {
  assert.equal((await fetch(`${base}/report`)).status, 404);
  assert.equal((await fetch(`${base}/report`, { method: 'POST', body: '{}' })).status, 404);
}, { logs: false }));

test('a second big screen is turned away, and the same one rejoins', async () => {
  let time = 1000;
  await withHelper(async (base) => {
    const { id } = await postJson(base, '/mission', { seed: 1, tab: 'first' });
    await postJson(base, '/launch');
    await poll(base, 'base');
    time += 1000;
    assert.equal((await postJson(base, '/mission', { seed: 2, tab: 'second' })).status, 409);
    const reloaded = await postJson(base, '/mission', { seed: 2, tab: 'first' });
    assert.deepEqual([reloaded.id, reloaded.seed, reloaded.resume], [id, 1, true], 'a reload rejoins the run');
    time += 1000;
    assert.notEqual((await postJson(base, '/mission', { seed: 2, tab: 'second', restart: true })).id, id, 'on request it is replaced');
  }, { now: () => time });
});

test('even an old run is safe from a second screen while its own is there', async () => {
  let time = 1000;
  await withHelper(async (base) => {
    const { id } = await postJson(base, '/mission', { seed: 1, tab: 'first' });
    await postJson(base, '/launch');
    time += 60 * 60 * 1000;
    await poll(base, 'base');
    assert.equal((await postJson(base, '/mission', { seed: 2, tab: 'second' })).status, 409);
    assert.equal((await (await fetch(`${base}/mission`)).json()).id, id);
  }, { now: () => time });
});

test('a big screen opened after the last one has gone rejoins the run', async () => {
  let time = 1000;
  await withHelper(async (base) => {
    const { id } = await postJson(base, '/mission', { seed: 1, tab: 'first' });
    await postJson(base, '/launch');
    await poll(base, 'base');
    time += 10000;
    const opened = await postJson(base, '/mission', { seed: 2, tab: 'second' });
    assert.deepEqual([opened.id, opened.resume], [id, true]);
    time += 60 * 60 * 1000;
    assert.notEqual((await postJson(base, '/mission', { seed: 2, tab: 'third' })).id, id, 'but not an old one');
  }, { now: () => time });
});

test('the big screen can give a restarted helper its mission back', async () => {
  let saved;
  await withHelper(async (base) => {
    await postJson(base, '/mission', { seed: 4, fleet: 9 });
    await postJson(base, '/join', { key: 'p1' });
    await postJson(base, '/launch');
    saved = await (await fetch(`${base}/mission`)).json();
  });
  await withHelper(async (base) => {
    assert.deepEqual(await (await fetch(`${base}/mission`)).json(), {});
    const { id, seed, fleet, launchAt, claims } = saved;
    await postJson(base, '/mission', { restore: { id, seed, fleet, launchAt, claims } });
    const back = await (await fetch(`${base}/mission`)).json();
    assert.deepEqual([back.id, back.seed, back.fleet, back.launchAt, back.drones], [id, 4, 9, launchAt, [1]]);
    assert.equal((await postJson(base, '/join', { key: 'p1' })).drone, 1, 'and its phone can still return');
  });
});

test('a phone that left before launch gives its drone back', async () => {
  let time = 1000;
  await withHelper(async (base) => {
    await postJson(base, '/mission', { seed: 1 });
    assert.equal((await postJson(base, '/join', { key: 'gone' })).drone, 1);
    assert.equal((await postJson(base, '/join', { key: 'stays' })).drone, 2);
    await poll(base, 'drone-2');
    time += 6000;
    await poll(base, 'drone-2');
    time += 6000;
    await poll(base, 'drone-2');
    assert.deepEqual((await (await fetch(`${base}/mission`)).json()).drones, [2]);
    assert.equal((await postJson(base, '/join', { key: 'new' })).drone, 1);
  }, { now: () => time });
});

test('a phone that rejoins is given time to start polling', async () => {
  let time = 1000;
  await withHelper(async (base) => {
    await postJson(base, '/mission', { seed: 1 });
    await postJson(base, '/join', { key: 'a' });
    time += 9000;
    await postJson(base, '/join', { key: 'a' });
    time += 5000;
    assert.deepEqual((await (await fetch(`${base}/mission`)).json()).drones, [1]);
  }, { now: () => time });
});

test('phones keep their drones into the next run', async () => {
  let time = 1;
  await withHelper(async (base) => {
    await postJson(base, '/mission', { seed: 1 });
    await postJson(base, '/join', { key: 'a' });
    await postJson(base, '/join', { key: 'b' });
    time = 2;
    await postJson(base, '/mission', { seed: 2, fleet: 15 });
    assert.equal((await postJson(base, '/join', { key: 'late' })).drone, 3, 'a waiting page cannot take a flying phone\'s drone');
    assert.equal((await postJson(base, '/join', { key: 'b' })).drone, 2);
  }, { now: () => time });
});

test('a phone keeps its number from run to run if it can', () => withHelper(async (base) => {
  await postJson(base, '/mission', { seed: 1 });
  assert.equal((await postJson(base, '/join', { key: 'a', prefer: 2 })).drone, 2);
  assert.equal((await postJson(base, '/join', { key: 'b', prefer: 2 })).drone, 1);
}));

test('a small swarm offers only the drones it has', () => withHelper(async (base) => {
  await postJson(base, '/mission', { seed: 1, fleet: 3 });
  assert.deepEqual(await Promise.all(['a', 'b', 'c'].map(async (key) => (await postJson(base, '/join', { key })).status)), [200, 200, 200]);
  assert.equal((await postJson(base, '/join', { key: 'd' })).error, 'full');
}));

test('the root address sends a folder to its page', () => withHelper(async (base) => {
  const root = await fetch(`${base}/`, { redirect: 'manual' });
  assert.equal(root.headers.get('location'), '/demo/?phones=1');
  assert.equal((await fetch(`${base}/demo?phones=1`, { redirect: 'manual' })).headers.get('location'), '/demo/?phones=1');
}));

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
    const next = await postJson(base, '/mission', { seed: 2, restart: true });
    assert.deepEqual([next.seed, next.launchAt], [2, null]);
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
