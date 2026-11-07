// main.js — wires the presentation together.
import { initScene } from './scene.js';
import { createNetwork } from './network.js';
import { initRescue } from './rescue.js';

const $ = (id) => document.getElementById(id);

initScene();

// ───────── live network graph ─────────
const phHub = $('phHub'), phLive = $('phLive'), btnFail = $('btnFailHub'), btnRadio = $('btnRadio');
const net = createNetwork({
  canvas: $('net'),
  steps: $('steps'),
  note: $('netNote'),
  readout: { base: $('roBase'), live: $('roLive'), hub: $('roHub'), cov: $('roCov') },
  onChange(st) {
    phHub.textContent = st.hubDown ? 'electing…' : st.hub == null ? '—' : `drone ${st.hub}`;
    phLive.textContent = `${st.live} / 9`;
    btnFail.disabled = st.hubDown;
    btnRadio.textContent = st.radio ? 'Cut all radio' : 'Restore radio';
    btnRadio.classList.toggle('on', !st.radio);
  },
});
window.ridgeline = net;   // for checking it from the console
btnFail.addEventListener('click', () => net.failHub());
btnRadio.addEventListener('click', () => net.toggleRadio());
$('btnReplay').addEventListener('click', () => net.replay());

// ───────── phone preview: drives the same graph ─────────
const toast = $('phToast');
let toastTimer;
const say = (msg) => { toast.textContent = msg; clearTimeout(toastTimer); toastTimer = setTimeout(() => { toast.textContent = ''; }, 3500); };
document.querySelectorAll('.ph-btn').forEach((b) => b.addEventListener('click', () => {
  const act = b.dataset.act;
  if (act === 'hub') { const id = net.failHub(); say(id ? `Hub drone ${id} down. Swarm electing a new hub…` : 'The hub is already down. Election in progress.'); }
  if (act === 'drone') { const id = net.failRandom(); say(id ? `Drone ${id} down. Its strip will be covered.` : 'No drones left to fail.'); }
  if (act === 'radio') { const on = net.toggleRadio(); say(on ? 'Radio back. Memories syncing.' : 'Radio cut. Every drone flies on alone.'); }
}));

// ───────── QR to the live demo ─────────
// Point it at the team's deployed or LAN address on the day: ?demo=https://… or edit DEMO_URL.
const DEMO_URL = '';
const params = new URLSearchParams(location.search);
const demoUrl = params.get('demo') || DEMO_URL || new URL('../demo/', location.href).href;
const qrUrl = $('qrUrl');
qrUrl.href = demoUrl; qrUrl.textContent = demoUrl.replace(/^https?:\/\//, '');
if (/^(localhost|127\.|\[::1\])/.test(new URL(demoUrl).host)) {
  const hint = $('qrHint');
  hint.hidden = false;
  hint.textContent = 'This address only works on this computer. Add ?demo=http://<your-LAN-IP>:8080/demo/ to the page URL so phones can open it.';
}
function drawQR() {
  if (!window.qrcode) { $('qr').textContent = 'QR library offline: use the link below.'; return; }
  const qr = window.qrcode(0, 'M');
  qr.addData(demoUrl); qr.make();
  const n = qr.getModuleCount();
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
  $('qr').innerHTML = `<svg viewBox="-2 -2 ${n + 4} ${n + 4}" shape-rendering="crispEdges"><rect x="-2" y="-2" width="${n + 4}" height="${n + 4}" fill="#fff"/><path d="${d}" fill="#06142a"/></svg>`;
}
if (window.qrcode) drawQR(); else addEventListener('load', drawQR);

// ───────── rescue scene ─────────
initRescue($('rescueSvg'), $('rescueCaps'));
