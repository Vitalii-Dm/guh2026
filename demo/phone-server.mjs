// phone-server.mjs — the helper that introduces devices to each other. It serves
// the pages and passes connection offers between them. It holds no swarm data,
// and devices stop needing it once they are connected. Built-in modules only.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import qrcode from 'qrcode-generator';
import { LAUNCH_DELAY_MS, MAX_FLEET, MIN_FLEET, PHONE_DRONES } from './mission.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
// The address may be public through a tunnel, so only these folders are served.
const PUBLIC_DIRS = new Set(['demo', 'recovery']);
const START_PAGE = '/demo/?phones=1';
const PEER_TTL = 5000;     // ms since its last poll before a device stops being listed
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

async function serveFile(pathname, res) {
  const file = resolve(ROOT, `.${decodeURIComponent(pathname)}${pathname.endsWith('/') ? 'index.html' : ''}`);
  const [top, ...rest] = file.slice(ROOT.length).split(sep);
  if (!file.startsWith(ROOT) || !PUBLIC_DIRS.has(top) || !rest.length || rest.some((p) => p.startsWith('.'))) return send(res, 404, { error: 'not found' });
  try {
    send(res, 200, await readFile(file), TYPES[extname(file)] ?? 'application/octet-stream');
  } catch {
    send(res, 404, { error: 'not found' });
  }
}

function lanAddress() {
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return null;
}

/** A device's local address as seen by the helper, or null if unknown or not local. */
export function localAddressOf(req) {
  if (req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']) return null; // came through a tunnel
  const ip = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
  if (ip === '127.0.0.1' || ip === '::1') return lanAddress();
  return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip) ? ip : null;
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
export function createHelper({ now = Date.now } = {}) {
  const lastPoll = new Map();   // device id -> time of its last poll
  const inboxes = new Map();    // device id -> messages waiting for it
  const reports = new Map();    // device id -> its latest log, for reading rehearsals on the laptop
  let mission = null;           // { id, seed, fleet, launchAt, claims: phone key -> drone }

  const joinUrl = (req) => `http://${lanAddress() ?? 'localhost'}:${req.socket.localPort}/demo/phone.html`;

  const missionView = (req) => mission && {
    id: mission.id, seed: mission.seed, fleet: mission.fleet, launchAt: mission.launchAt,
    drones: [...mission.claims.values()].sort((a, b) => a - b),
    joinUrl: joinUrl(req),
  };

  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://helper');
    try {
      if (url.pathname === '/' && req.method === 'GET') {
        res.writeHead(302, { location: START_PAGE });
        return res.end();
      }
      if (url.pathname === '/time' && req.method === 'GET') return send(res, 200, { now: now() });
      if (url.pathname === '/qr.svg' && req.method === 'GET') {
        const code = qrcode(0, 'M');
        code.addData(joinUrl(req));
        code.make();
        return send(res, 200, Buffer.from(code.createSvgTag({ cellSize: 4, margin: 4, scalable: true })), 'image/svg+xml');
      }
      // A big screen starts a mission, which replaces any earlier one.
      if (url.pathname === '/mission' && req.method === 'POST') {
        const { seed, fleet = MAX_FLEET } = JSON.parse(await readBody(req));
        if (!Number.isInteger(seed) || !Number.isInteger(fleet) || fleet < MIN_FLEET || fleet > MAX_FLEET) return send(res, 400, { error: 'bad mission' });
        mission = { id: now(), seed, fleet, launchAt: null, claims: new Map() };
        return send(res, 200, missionView(req));
      }
      if (url.pathname === '/mission' && req.method === 'GET') return send(res, 200, missionView(req) ?? {});
      if (url.pathname === '/launch' && req.method === 'POST') {
        if (!mission) return send(res, 409, { error: 'no mission' });
        mission.launchAt ??= now() + LAUNCH_DELAY_MS;
        return send(res, 200, missionView(req));
      }
      if (url.pathname === '/join' && req.method === 'POST') {
        const { key } = JSON.parse(await readBody(req));
        if (!ID.test(key ?? '')) return send(res, 400, { error: 'bad key' });
        if (!mission) return send(res, 409, { error: 'no mission' });
        if (!mission.claims.has(key)) {
          if (mission.launchAt !== null) return send(res, 409, { error: 'launched' });
          const free = PHONE_DRONES.find((d) => ![...mission.claims.values()].includes(d));
          if (free === undefined) return send(res, 409, { error: 'full' });
          mission.claims.set(key, free);
        }
        return send(res, 200, { ...missionView(req), drone: mission.claims.get(key) });
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
      if (url.pathname === '/report' && req.method === 'POST') {
        const { id, text } = JSON.parse(await readBody(req));
        if (!ID.test(id ?? '')) return send(res, 400, { error: 'bad id' });
        reports.set(id, { at: now(), ip: req.socket.remoteAddress, text: String(text).slice(-20000) });
        return send(res, 200, { ok: true });
      }
      if (url.pathname === '/report' && req.method === 'GET') return send(res, 200, Object.fromEntries(reports));
      if (req.method === 'GET') return await serveFile(url.pathname, res);
      send(res, 405, { error: 'method not allowed' });
    } catch {
      if (!res.headersSent) send(res, 400, { error: 'bad request' });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 8080);
  createHelper().listen(port, '0.0.0.0', () => {
    console.log(`Helper running. On this machine: http://localhost:${port}/`);
    for (const list of Object.values(networkInterfaces())) {
      for (const a of list) if (a.family === 'IPv4' && !a.internal) console.log(`On the same network: http://${a.address}:${port}/`);
    }
  });
}
