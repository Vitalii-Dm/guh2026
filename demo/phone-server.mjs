// phone-server.mjs — the helper. It serves the pages, starts the mission, shares
// the clock, and introduces devices to each other. Positions and findings never
// pass through it, and linked devices keep talking without it.
import { realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LAPTOP_ID, LAUNCH_DELAY_MS, MAX_FLEET, MIN_FLEET, PHONE_DRONES, netId } from './mission.js';

// Everything else works without the QR code, so a missing package isn't fatal.
const qrcode = await import('qrcode-generator').then((m) => m.default).catch(() => null);

const ROOT = fileURLToPath(new URL('..', import.meta.url));
// Anyone on the Wi-Fi can reach the helper, so only these folders are served.
const PUBLIC_DIRS = new Set(['demo', 'demo3d', 'recovery']);
const BIG_SCREEN = '/demo/?phones=1', PHONE_PAGE = '/demo/phone.html';
const PEER_TTL = 5000;     // ms since its last poll before a device stops being listed
const SCREEN_TTL = 3000;   // ms since the big screen's last poll before its mission can be replaced
const CLAIM_TTL = 10000;   // ms a phone can stop polling before launch and still keep its drone
const RESUME_MS = 20 * 60 * 1000;  // a big screen can rejoin a mission launched this recently
const MAX_BODY = 64 * 1024;  // limit per request
const MAX_QUEUE = 32;      // waiting messages kept per device
const ID = /^[\w-]{1,32}$/;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json' };

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((done, fail) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (part) => {
      body += part;
      if (body.length > MAX_BODY) { fail(new Error('too large')); req.destroy(); }
    });
    req.on('end', () => done(body));
    req.on('error', fail);
  });
}

async function serveFile({ pathname, search }, res) {
  if (PUBLIC_DIRS.has(pathname.slice(1))) {
    res.writeHead(302, { location: `${pathname}/${search}` });
    return res.end();
  }
  const file = resolve(ROOT, `.${decodeURIComponent(pathname)}${pathname.endsWith('/') ? 'index.html' : ''}`);
  const [top, ...rest] = file.slice(ROOT.length).split(sep);
  if (!file.startsWith(ROOT) || !PUBLIC_DIRS.has(top) || !rest.length || rest.some((p) => p.startsWith('.'))) return send(res, 404, { error: 'not found' });
  try {
    send(res, 200, await readFile(file), TYPES[extname(file)] ?? 'application/octet-stream');
  } catch {
    send(res, 404, { error: 'not found' });
  }
}

// Interfaces phones can't reach: tunnels, VPNs, virtual machines, Apple's peer links.
const VIRTUAL = /^(lo|utun|tun|tap|ppp|ipsec|bridge|vmnet|vboxnet|vethernet|docker|br-|veth|awdl|llw|ap\d|anpi|gif|stf)/i;

/** The laptop's address on the Wi-Fi. PHONE_HOST overrides it if this picks wrongly. */
export function pickLanAddress(interfaces = networkInterfaces(), host = process.env.PHONE_HOST) {
  if (host) return host;
  const all = Object.entries(interfaces).flatMap(([name, list]) => list.filter((a) => a.family === 'IPv4' && !a.internal).map((a) => ({ name, address: a.address })));
  const real = all.filter((a) => !VIRTUAL.test(a.name));
  const usable = real.filter((a) => !a.address.startsWith('169.254.'));   // self-assigned: nothing else is out there
  return (usable.find((a) => /^(en0|wlan0)$/i.test(a.name)) ?? usable.find((a) => /^(en|wl|eth|wi-?fi)/i.test(a.name)) ?? usable[0] ?? real[0] ?? all[0])?.address ?? null;
}

const plainIp = (ip) => (ip ?? '').replace(/^::ffff:/, '');

/** True if the request came from this laptop. Only it may start or launch a mission. */
export function isLoopback(req) {
  const ip = plainIp(req.socket.remoteAddress);
  return ip === '127.0.0.1' || ip === '::1';
}

/** A device's address as seen by the helper, or null if it came through a proxy. */
export function localAddressOf(req) {
  if (req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']) return null;
  return isLoopback(req) ? pickLanAddress() : plainIp(req.socket.remoteAddress) || null;
}

/**
 * Browsers hide a device's address behind a random .local name, which other
 * devices can only look up if the network allows multicast. Many do not, so
 * the helper writes in the address it already sees.
 */
export function showAddress(sdp, ip) {
  return sdp.replace(/\b[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}\.local\b/gi, ip);
}

/** Build the helper. Call `.listen(port)` on the result. */
export function createHelper({ now = Date.now, logs = process.env.PHONE_LOGS === '1' } = {}) {
  const lastPoll = new Map();   // device id -> time of its last poll
  const inboxes = new Map();    // device id -> messages waiting for it
  const reports = new Map();    // device id -> its latest log. Only with PHONE_LOGS=1, for rehearsals
  let mission = null;           // { id, seed, fleet, launchAt, claims: phone key -> { drone, at } }

  const joinUrl = (req) => {
    const host = isLoopback(req) ? pickLanAddress() : plainIp(req.socket.localAddress);
    return `http://${host ?? 'localhost'}:${req.socket.localPort}${PHONE_PAGE}`;
  };

  /** Before launch, a page that has gone away gives its drone back. */
  function releaseAbsent() {
    if (!mission || mission.launchAt !== null) return;
    for (const [key, { drone, at }] of mission.claims) {
      if (now() - Math.max(at, lastPoll.get(netId(drone)) ?? 0) > CLAIM_TTL) mission.claims.delete(key);
    }
  }

  function missionView(req) {
    if (!mission) return null;
    releaseAbsent();
    const claims = [...mission.claims];
    return {
      id: mission.id, seed: mission.seed, fleet: mission.fleet, launchAt: mission.launchAt, logs,
      drones: claims.map(([, c]) => c.drone).sort((a, b) => a - b),
      joinUrl: joinUrl(req),
      // Only the big screen sees these. It hands them back if the helper restarts.
      ...(isLoopback(req) ? { claims: Object.fromEntries(claims.map(([key, c]) => [key, c.drone])) } : {}),
    };
  }

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://helper');
      if (url.pathname === '/' && req.method === 'GET') {
        // Only the laptop gets the big screen, so a phone can't start a second one.
        res.writeHead(302, { location: isLoopback(req) ? BIG_SCREEN : PHONE_PAGE });
        return res.end();
      }
      if (url.pathname === '/time' && req.method === 'GET') return send(res, 200, { now: now() });
      if (url.pathname === '/qr.svg' && req.method === 'GET') {
        if (!qrcode) return send(res, 503, { error: 'run npm install' });
        const code = qrcode(0, 'M');
        code.addData(joinUrl(req));
        code.make();
        return send(res, 200, Buffer.from(code.createSvgTag({ cellSize: 4, margin: 4, scalable: true })), 'image/svg+xml');
      }
      // The big screen starts a mission. A flying one is only replaced on
      // request, so a stray tab can't end a run: a screen that was reloaded or
      // reopened rejoins it, and a second screen is turned away.
      if (url.pathname === '/mission' && req.method === 'POST') {
        if (!isLoopback(req)) return send(res, 403, { error: 'open the big screen on the laptop' });
        const { seed, fleet = MAX_FLEET, restart = false, restore, tab } = JSON.parse(await readBody(req));
        if (restore) {
          // The helper restarted: the big screen hands the mission back.
          mission ??= { ...restore, claims: new Map(Object.entries(restore.claims ?? {}).map(([key, drone]) => [key, { drone, at: now() }])) };
          return send(res, 200, missionView(req));
        }
        if (!Number.isInteger(seed) || !Number.isInteger(fleet) || fleet < MIN_FLEET || fleet > MAX_FLEET) return send(res, 400, { error: 'bad mission' });
        if (mission?.launchAt != null && !restart) {
          const screenThere = now() - (lastPoll.get(LAPTOP_ID) ?? -Infinity) <= SCREEN_TTL;
          if (screenThere && tab !== mission.tab) return send(res, 409, { error: 'in use' });
          if (now() - mission.launchAt < RESUME_MS) {
            mission.tab = tab;
            return send(res, 200, { ...missionView(req), resume: true });
          }
        }
        // Phones keep their drones into the next run, while they reload to join it.
        const kept = [...(mission?.claims ?? [])].filter(([, c]) => c.drone <= fleet).map(([key, c]) => [key, { drone: c.drone, at: now() }]);
        mission = { id: now(), seed, fleet, tab, launchAt: null, claims: new Map(kept) };
        return send(res, 200, missionView(req));
      }
      if (url.pathname === '/mission' && req.method === 'GET') return send(res, 200, missionView(req) ?? {});
      if (url.pathname === '/launch' && req.method === 'POST') {
        if (!isLoopback(req)) return send(res, 403, { error: 'launch from the big screen' });
        if (!mission) return send(res, 409, { error: 'no mission' });
        releaseAbsent();
        mission.launchAt ??= now() + LAUNCH_DELAY_MS;
        return send(res, 200, missionView(req));
      }
      if (url.pathname === '/join' && req.method === 'POST') {
        const { key, prefer } = JSON.parse(await readBody(req));
        if (!ID.test(key ?? '')) return send(res, 400, { error: 'bad key' });
        if (!mission) return send(res, 409, { error: 'no mission' });
        releaseAbsent();
        if (mission.claims.has(key)) {
          mission.claims.get(key).at = now();    // it may take a moment to start polling
        } else {
          if (mission.launchAt !== null) return send(res, 409, { error: 'launched' });
          const taken = [...mission.claims.values()].map((c) => c.drone);
          const free = PHONE_DRONES.filter((d) => d <= mission.fleet && !taken.includes(d));
          if (!free.length) return send(res, 409, { error: 'full' });
          // A phone keeps its number from run to run if it can.
          mission.claims.set(key, { drone: free.includes(prefer) ? prefer : free[0], at: now() });
        }
        return send(res, 200, { ...missionView(req), drone: mission.claims.get(key).drone });
      }
      if (url.pathname === '/signal' && req.method === 'GET') {
        const id = url.searchParams.get('for') ?? '';
        if (!ID.test(id)) return send(res, 400, { error: 'bad id' });
        lastPoll.set(id, now());
        const messages = inboxes.get(id) ?? [];
        inboxes.delete(id);
        const peers = [...lastPoll].filter(([p, t]) => p !== id && now() - t <= PEER_TTL).map(([p]) => p);
        return send(res, 200, { messages, peers });
      }
      if (url.pathname === '/signal' && req.method === 'POST') {
        const { from, to, data } = JSON.parse(await readBody(req));
        if (!ID.test(from ?? '') || !ID.test(to ?? '')) return send(res, 400, { error: 'bad id' });
        const ip = localAddressOf(req);
        if (ip && data?.sdp) data.sdp = showAddress(data.sdp, ip);
        // Only a device's newest offer counts. Older ones pile up during an
        // outage and would tear down the new link when answered late.
        const inbox = (inboxes.get(to) ?? []).filter((m) => m.from !== from || m.data?.kind !== data?.kind);
        inbox.push({ from, data });
        inboxes.set(to, inbox.slice(-MAX_QUEUE));
        return send(res, 200, { ok: true });
      }
      if (url.pathname === '/report' && !logs) return send(res, 404, { error: 'not found' });
      if (url.pathname === '/report' && req.method === 'POST') {
        const { id, text } = JSON.parse(await readBody(req));
        if (!ID.test(id ?? '')) return send(res, 400, { error: 'bad id' });
        reports.set(id, { at: now(), ip: req.socket.remoteAddress, text: String(text).slice(-20000) });
        return send(res, 200, { ok: true });
      }
      if (url.pathname === '/report' && req.method === 'GET') return send(res, 200, Object.fromEntries(reports));
      if (req.method === 'GET') return await serveFile(url, res);
      send(res, 405, { error: 'method not allowed' });
    } catch {
      if (!res.headersSent) send(res, 400, { error: 'bad request' });
    }
  });
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 8080);
  process.on('unhandledRejection', (e) => console.error('Helper error:', e));
  const helper = createHelper();
  helper.on('error', (e) => {
    console.error(e.code === 'EADDRINUSE' ? `Port ${port} is in use. Stop the other server, or run: PORT=${port + 1} npm run phones` : e.message);
    process.exit(1);
  });
  helper.listen(port, '0.0.0.0', () => {
    console.log(`Big screen, on this laptop only: http://localhost:${port}/`);
    console.log(`Phones, on the same Wi-Fi: http://${pickLanAddress() ?? 'localhost'}:${port}${PHONE_PAGE}`);
    if (!qrcode) console.log('No QR code: run npm install. Phones can still use the address above.');
  });
}
