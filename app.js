import qrcode from './vendor/qrcode.mjs';
import {
  buildStreamBytes, Encoder, Decoder, parseSymbol, bytesToBinaryString,
} from './protocol.js';

const $ = (id) => document.getElementById(id);
const fmtBytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} kB` : `${(n / 1048576).toFixed(2)} MB`);
const fmtTime = (s) => (s < 60 ? `${s.toFixed(1)} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`);

// ---------------------------------------------------------------- tabs
function showTab(name) {
  $('tab-send').setAttribute('aria-selected', name === 'send');
  $('tab-recv').setAttribute('aria-selected', name === 'recv');
  $('view-send').hidden = name !== 'send';
  $('view-recv').hidden = name !== 'recv';
  // The packages-received map is in the top band and only shown while receiving.
  $('chunk-map').hidden = name !== 'recv';
  if (name === 'recv') drawChunkMap();
  if (name !== 'recv') stopCamera();
  try { localStorage.setItem('qrsend6-tab', name); } catch {}
}
$('tab-send').onclick = () => showTab('send');
$('tab-recv').onclick = () => showTab('recv');

// ---------------------------------------------------------------- settings dialog
const settingsDlg = $('settings');
$('btn-settings').onclick = () => {
  settingsDlg.showModal();
  // Opening must not focus (and so highlight or open) the first control, the Format picker.
  if (settingsDlg.contains(document.activeElement)) document.activeElement.blur();
};
// Tapping the backdrop closes it
settingsDlg.addEventListener('click', (e) => { if (e.target === settingsDlg) settingsDlg.close(); });

// ---------------------------------------------------------------- refresh: tap the logo four times
const logo = document.querySelector('.logo');
let logoTaps = [];
logo.addEventListener('click', () => {
  const now = Date.now();
  logoTaps = logoTaps.filter((t) => now - t < 2000);
  logoTaps.push(now);
  if (logoTaps.length < 4) return;
  logoTaps = [];
  const splash = document.createElement('div');
  splash.id = 'splash';
  splash.setAttribute('role', 'status');
  const img = document.createElement('img');
  img.src = logo.src;
  img.alt = 'QR XFER';
  const msg = document.createElement('p');
  msg.textContent = 'Refreshing …';
  splash.append(img, msg);
  document.body.append(splash);
  setTimeout(() => location.reload(), 900);
});

// ---------------------------------------------------------------- wake lock
let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && 'wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => (wakeLock = null));
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {}
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && (playing || cameraOn)) keepAwake(true);
});

// =====================================================================
// SENDER
// =====================================================================
let sourceFile = null;
let payloadBytes = null; // Uint8Array that will be sent
let payloadType = '';
let payloadName = '';
let prepareToken = 0;

const opt = {
  format: $('opt-format'), maxSide: $('opt-maxside'), quality: $('opt-quality'),
  perPacket: $('opt-perpacket'), chunk: $('opt-chunk'), interval: $('opt-interval'), ecc: $('opt-ecc'),
  countdown: $('opt-countdown'),
};

function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem('qrsend6-opts') || '{}');
    for (const k in opt) if (s[k] != null) opt[k].value = s[k];
  } catch {}
  $('out-quality').textContent = opt.quality.value;
}
function saveSettings() {
  try {
    const s = {};
    for (const k in opt) s[k] = opt[k].value;
    localStorage.setItem('qrsend6-opts', JSON.stringify(s));
  } catch {}
}

function setSourceFile(file) {
  sourceFile = file || null;
  if (sourceFile) $('file-label').textContent = sourceFile.name;
  prepare();
}
$('file').addEventListener('change', (e) => setSourceFile(e.target.files[0]));

// Drag and drop: drop a file anywhere on the file card, same as choosing it with the picker.
const dropZone = $('file').closest('.card');
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
let dragDepth = 0;
dropZone.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  dropZone.classList.add('drag-over');
});
dropZone.addEventListener('dragover', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});
dropZone.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) dropZone.classList.remove('drag-over');
});
dropZone.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  dropZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];   // any file type; if several are dropped, the first one is used
  if (file) setSourceFile(file);
});
// A file dropped outside the card must not make the browser open it and leave the app.
for (const type of ['dragover', 'drop']) window.addEventListener(type, (e) => { if (hasFiles(e)) e.preventDefault(); });
for (const k of ['format', 'maxSide', 'quality']) opt[k].addEventListener('input', () => { saveSettings(); updateCompressOptions(); prepare(); });
for (const k of ['perPacket', 'chunk', 'interval', 'ecc', 'countdown']) opt[k].addEventListener('input', () => { saveSettings(); updateEstimate(); });
opt.quality.addEventListener('input', () => ($('out-quality').textContent = opt.quality.value));

async function decodeImage(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  }
}

function canvasToBlob(canvas, type, q) {
  return new Promise((res) => canvas.toBlob(res, type, q));
}

// Any file type can be sent. The image options (format, size, quality) only apply to images.
const isImageFile = (f) => (f.type || '').startsWith('image/');
function showImageOptions(on) {
  for (const el of document.querySelectorAll('[data-image-only]')) el.hidden = !on;
}
// Size and quality only matter when the image is re-encoded, not when the original file is kept.
function updateCompressOptions() {
  for (const el of document.querySelectorAll('[data-compress-only]')) el.hidden = opt.format.value === 'original';
  $('format-heading').textContent = opt.format.selectedOptions[0]?.textContent || '';
}

async function prepare() {
  const token = ++prepareToken;
  $('btn-start').disabled = true;
  if (!sourceFile) return;
  $('estimate').textContent = 'Preparing file …';
  let asImage = isImageFile(sourceFile);
  showImageOptions(asImage);
  const format = opt.format.value;
  let bytes, type, name = sourceFile.name, img = null;
  if (asImage && format !== 'original') {
    // Formats the browser cannot decode (e.g. HEIC) are sent as they are.
    try { img = await decodeImage(sourceFile); } catch { asImage = false; showImageOptions(false); }
  }
  if (!asImage || format === 'original') {
    bytes = new Uint8Array(await sourceFile.arrayBuffer());
    type = sourceFile.type || 'application/octet-stream';
  } else {
    const w0 = img.width, h0 = img.height;
    const maxSide = Math.max(16, +opt.maxSide.value || 1600);
    const scale = Math.min(1, maxSide / Math.max(w0, h0));
    const w = Math.max(1, Math.round(w0 * scale)), h = Math.max(1, Math.round(h0 * scale));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, w, h);
    let blob = await canvasToBlob(c, format, +opt.quality.value);
    if (!blob || blob.type !== format) blob = await canvasToBlob(c, 'image/jpeg', +opt.quality.value);
    bytes = new Uint8Array(await blob.arrayBuffer());
    type = blob.type;
    const ext = type === 'image/webp' ? 'webp' : 'jpg';
    name = name.replace(/\.[^.]+$/, '') + '.' + ext;
  }
  if (token !== prepareToken) return;
  payloadBytes = bytes; payloadType = type; payloadName = name;
  const blobUrl = URL.createObjectURL(new Blob([bytes], { type }));
  const prev = $('preview');
  if (prev.dataset.url) URL.revokeObjectURL(prev.dataset.url);
  const sizeInfo = `${fmtBytes(bytes.length)}` + (bytes.length !== sourceFile.size ? ` (original ${fmtBytes(sourceFile.size)})` : '');
  const plainInfo = [name, asImage ? '' : (type || 'unknown type'), sizeInfo].filter(Boolean).join(' · ');
  $('file-info').textContent = plainInfo;
  prev.hidden = !asImage;
  if (asImage) {
    prev.onload = () => {
      $('file-info').textContent = `${name} · ${prev.naturalWidth}×${prev.naturalHeight} · ${sizeInfo}`;
    };
    prev.onerror = () => { prev.hidden = true; };   // an image type the browser cannot display
    prev.src = blobUrl; prev.dataset.url = blobUrl;
  } else {
    prev.removeAttribute('src'); prev.dataset.url = blobUrl;
  }
  $('preview-wrap').hidden = false;
  updateEstimate();
}

function updateEstimate() {
  if (!payloadBytes) return;
  const chunk = Math.max(50, +opt.chunk.value || 380);
  const per = Math.max(1, +opt.perPacket.value || 10);
  const interval = Math.max(30, +opt.interval.value || 300);
  const metaLen = new TextEncoder().encode(JSON.stringify({ name: payloadName, type: payloadType, size: payloadBytes.length, crc: 4294967295 })).length;
  const K = Math.ceil((2 + metaLen + payloadBytes.length) / chunk);
  const t = (share) => fmtTime((K / share / per) * (interval / 1000));
  $('estimate').textContent =
    `${K} data codes first, then parity codes only (${per} per packet, ${fmtBytes(Math.round((per * chunk) / (interval / 1000)))}/s). ` +
    `Data codes take ${t(1)}. The receiver is done after about ${t(1)} if it reads everything, ${t(0.8)} with 20 % loss, ${t(0.5)} with 50 % loss.`;
  $('btn-start').disabled = false;
}

// ---------------------------------------------------------------- player
let playing = false, paused = false;
let enc = null, current = [], timer = 0;
let perPacket = 10, interval = 300, ecc = 'M';
const pc = $('player-canvas');
const pctx = pc.getContext('2d', { alpha: false });

function qrCanvas(bytes) {
  const qr = qrcode(0, ecc);
  qr.addData(bytesToBinaryString(bytes), 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  const c = document.createElement('canvas');
  c.width = n; c.height = n;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(n, n);
  for (let r = 0; r < n; r++) for (let col = 0; col < n; col++) {
    const v = qr.isDark(r, col) ? 0 : 255, o = (r * n + col) * 4;
    img.data[o] = img.data[o + 1] = img.data[o + 2] = v; img.data[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function bestGrid(count, W, H) {
  let best = { cols: 1, rows: count, cell: 0 };
  for (let cols = 1; cols <= count; cols++) {
    const rows = Math.ceil(count / cols);
    const cell = Math.min(W / cols, H / rows);
    if (cell > best.cell) best = { cols, rows, cell };
  }
  return best;
}

function resizePlayer() {
  const dpr = window.devicePixelRatio || 1;
  pc.width = Math.round(pc.clientWidth * dpr);
  pc.height = Math.round(pc.clientHeight * dpr);
  drawPacket();
}

// Countdown before sending: a big number in the middle of the screen, so the receiver has time to aim.
let countdownEnd = 0, countdownLeft = 0;
function drawCountdown() {
  const dpr = window.devicePixelRatio || 1;
  const W = pc.width, H = pc.height - Math.round($('player-bar').offsetHeight * dpr);
  const left = paused ? countdownLeft : Math.max(0, countdownEnd - performance.now());
  pctx.fillStyle = '#fff';
  pctx.fillRect(0, 0, W, pc.height);
  pctx.fillStyle = '#15181d';
  pctx.textAlign = 'center'; pctx.textBaseline = 'middle';
  pctx.font = `700 ${Math.round(Math.min(W, H) * 0.45)}px -apple-system, "Segoe UI", sans-serif`;
  pctx.fillText(String(Math.ceil(left / 1000)), W / 2, H / 2);
  pctx.font = `${Math.round(18 * dpr)}px -apple-system, "Segoe UI", sans-serif`;
  pctx.fillStyle = '#5d6673';
  pctx.fillText('Sending starts – aim the receiving camera at this screen', W / 2, H / 2 + Math.min(W, H) * 0.32);
  $('player-status').textContent = `Starting in ${Math.ceil(left / 1000)} s · ${enc.K} data codes`;
}
function countdownTick() {
  if (!playing || paused) return;
  if (performance.now() >= countdownEnd) { countdownEnd = 0; tick(); return; }
  drawCountdown();
  timer = setTimeout(countdownTick, 100);
}

function drawPacket() {
  if (!playing) return;
  if (countdownEnd) { drawCountdown(); return; }
  const W = pc.width, barH = Math.round($('player-bar').offsetHeight * (window.devicePixelRatio || 1));
  const H = pc.height - barH;
  pctx.fillStyle = '#fff';
  pctx.fillRect(0, 0, W, pc.height);
  const g = bestGrid(perPacket, W, H);
  const offX = (W - g.cols * g.cell) / 2, offY = (H - g.rows * g.cell) / 2;
  pctx.imageSmoothingEnabled = false;
  current.forEach((q, k) => {
    const n = q.width + 6; // 3 modules quiet zone each side
    const mod = Math.max(1, Math.floor(g.cell / n));
    const size = mod * q.width;
    const x = Math.round(offX + (k % g.cols) * g.cell + (g.cell - size) / 2);
    const y = Math.round(offY + Math.floor(k / g.cols) * g.cell + (g.cell - size) / 2);
    pctx.drawImage(q, x, y, size, size);
  });
  const n = enc.count, K = enc.K;
  $('player-status').textContent = (n <= K ? `Data ${n}/${K}` : `Data done (${K}) · parity ${n - K}`) +
    ` · ${interval} ms · ${perPacket} per packet`;
}

// Each packet is the next codes from the encoder: first all data codes, then endless parity codes.
function tick() {
  if (!playing || paused) return;
  current = [];
  for (let k = 0; k < perPacket; k++) current.push(qrCanvas(enc.next()));
  drawPacket();
  timer = setTimeout(tick, interval);
}

function startPlayer() {
  if (!payloadBytes) return;
  const chunkSize = Math.max(50, +opt.chunk.value || 380);
  perPacket = Math.max(1, +opt.perPacket.value || 10);
  interval = Math.max(30, +opt.interval.value || 300);
  ecc = opt.ecc.value;
  const tid = (crypto.getRandomValues(new Uint32Array(1))[0]) >>> 0;
  enc = new Encoder(buildStreamBytes(payloadBytes, { name: payloadName, type: payloadType }), chunkSize, tid);
  if (enc.K > 0xffff) { alert('Too many codes – increase bytes per QR code or send a smaller file.'); return; }
  current = []; paused = false; playing = true;
  $('btn-pause').textContent = 'Pause';
  $('player').hidden = false;
  document.documentElement.requestFullscreen?.().catch(() => {});
  keepAwake(true);
  const secs = Math.max(0, Math.min(120, +opt.countdown.value || 0));
  countdownEnd = secs > 0 ? performance.now() + secs * 1000 : 0;
  resizePlayer();
  clearTimeout(timer);
  if (countdownEnd) countdownTick(); else tick();
}

function stopPlayer() {
  playing = false;
  clearTimeout(timer);
  $('player').hidden = true;
  keepAwake(false);
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
}

$('btn-start').onclick = startPlayer;
$('btn-stop').onclick = stopPlayer;
$('btn-pause').onclick = () => {
  paused = !paused;
  $('btn-pause').textContent = paused ? 'Resume' : 'Pause';
  if (countdownEnd) {
    // Pausing during the countdown freezes the number. Resume counts on from there.
    if (paused) countdownLeft = Math.max(0, countdownEnd - performance.now());
    else { countdownEnd = performance.now() + countdownLeft; clearTimeout(timer); countdownTick(); }
    return;
  }
  if (!paused) { clearTimeout(timer); tick(); }
};
$('btn-slower').onclick = () => { interval = Math.min(5000, Math.round(interval * 1.25)); drawPacket(); };
$('btn-faster').onclick = () => { interval = Math.max(30, Math.round(interval / 1.25)); drawPacket(); };
// The top band stays visible while sending. The player starts right below it (CSS var --band-h),
// so QR codes never end up under the band or the phone's notch. Re-measure whenever the band's
// height changes, e.g. when the phone is rotated, and redraw so every QR code stays a square.
const band = document.querySelector('header.top');
function syncBand() {
  document.documentElement.style.setProperty('--band-h', `${band.offsetHeight}px`);
  if (playing) requestAnimationFrame(resizePlayer);
}
new ResizeObserver(syncBand).observe(band);
window.addEventListener('resize', syncBand);
window.addEventListener('orientationchange', () => setTimeout(syncBand, 150));
window.visualViewport?.addEventListener('resize', syncBand);
syncBand();
document.addEventListener('keydown', (e) => { if (playing && e.key === 'Escape') stopPlayer(); });

// =====================================================================
// RECEIVER
// =====================================================================
const video = $('video');
let stream = null, cameraOn = false, dec = new Decoder(), done = false, paritySeen = 0;
let direct = new Set();      // data codes read directly (by number)
let dupSeen = 0, lastCodeAt = 0, lastFps = null, resultOk = true;
let workers = [], readyWorkers = 0, framesDone = 0, codesSeen = 0, fpsT0 = performance.now();
let lastResultUrl = null, resultBlob = null, resultName = '';
const grab = document.createElement('canvas');
const gctx = grab.getContext('2d', { willReadFrequently: true });

function initWorkers() {
  if (workers.length) return;
  const n = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 2) - 1));
  for (let i = 0; i < n; i++) {
    // index.html (built) defines window.__makeWorker to start the worker from inline sources;
    // the development page starts decoder-worker.js directly.
    const w = window.__makeWorker ? window.__makeWorker() : new Worker('decoder-worker.js');
    w.busy = true; // until ready
    w.spare = null;
    w.onmessage = (e) => onWorkerMessage(w, e.data);
    w.onerror = (e) => setError('Decoder error: ' + (e.message || e));
    workers.push(w);
  }
}

function onWorkerMessage(w, msg) {
  if (msg.type === 'ready') { w.busy = false; readyWorkers++; return; }
  if (msg.type === 'error') { setError('Could not load the QR decoder: ' + msg.message); return; }
  if (msg.type === 'result') {
    w.busy = false;
    w.spare = msg.buffer;
    framesDone++;
    for (const bytes of msg.codes) onCode(bytes);
  }
}

function onCode(bytes) {
  const sym = parseSymbol(bytes);
  if (!sym) return;
  codesSeen++;
  lastCodeAt = performance.now();
  if (dec.tid === null || sym.tid !== dec.tid) {
    // New transfer: transfer time is counted from the first code received.
    done = false; paritySeen = 0; dupSeen = 0; direct = new Set();
    tStart = performance.now(); tEnd = 0;
    $('result').hidden = true;
  }
  if (done && sym.tid === dec.tid) return;
  const r = dec.add(sym);
  if (r === 'dup') dupSeen++;
  if (r === 'new' || r === 'redundant') {
    if (sym.flags & 1) direct.add(sym.seed); else paritySeen++;
    drawChunkMap();
    if (dec.complete && !done) finish();
  }
}

// How many missing data codes the parity covers so far (one useful parity code per missing code).
const parityCovered = () => Math.max(0, dec.decoded - direct.size);

// Explains to the receiver what is happening right now.
function updatePhase() {
  const el = $('recv-phase'), now = performance.now();
  let text, cls = '';
  if (recvError) { text = '⚠ ' + recvError; cls = 'warn'; }
  else if (!cameraOn && !done) { text = 'Camera is off. Press "Start camera".'; }
  else if (done) { text = resultOk ? '✔ Done. The file was received and verified.' : '⚠ Done, but the checksum does not match.'; cls = resultOk ? 'ok' : 'warn'; }
  else if (!dec.K) { text = 'Waiting for the sender. Aim the camera at the screen showing the QR codes.'; }
  else {
    const K = dec.K, missing = K - direct.size, cov = parityCovered(), left = K - dec.decoded;
    if (now - lastCodeAt > 2500) {
      text = `No codes seen right now (${((now - lastCodeAt) / 1000).toFixed(0)} s). Aim at the sender. ${left} codes missing.`; cls = 'warn';
    } else if (!paritySeen) {
      text = `Receiving data: ${direct.size} of ${K} codes read.` + (missing && direct.size ? ' Gaps are filled when parity arrives.' : '');
    } else {
      text = `The sender is sending parity. ${missing} data codes missing, parity covers ${cov} of them. ${left} more codes needed.`;
    }
  }
  el.textContent = text;
  el.className = 'recv-phase ' + cls;
  const parts = [];
  if (dec.K) parts.push(`read directly ${direct.size}/${dec.K}`, `useful parity ${parityCovered()}`, `duplicate codes re-read ${dupSeen}`);
  if (cameraOn && lastFps != null) parts.push(`${lastFps.toFixed(1)} frames/s analyzed`, `camera ${video.videoWidth}×${video.videoHeight}`);
  if (!done || !parts.length) setStatus(parts.join(' · ') || 'No codes yet');
}

function setStatus(t) { $('recv-status').textContent = t; }
let recvError = '';
function setError(t) { recvError = t; }

// Transfer time and percent transferred
let tStart = 0, tEnd = 0;
const fmtClock = (ms) => {
  const t = Math.max(0, ms) / 1000, m = Math.floor(t / 60), sec = t - m * 60;
  return `${m}:${sec.toFixed(1).padStart(4, '0')}`;
};
const fmtMBs = (bps) => (bps / 1048576).toFixed(3);
function updateProgressText() {
  const pct = dec.K ? (100 * dec.decoded) / dec.K : 0;
  $('recv-pct').textContent = `${pct < 100 && pct > 99 ? 99 : Math.floor(pct)} %`;
  const ms = tStart ? (tEnd || performance.now()) - tStart : 0;
  $('recv-time').textContent = fmtClock(ms);
  // Speed: received file data (bytes) per second, in MB/s
  const bytes = dec.K ? Math.min(dec.streamLen, dec.decoded * dec.B) : 0;
  $('recv-speed').textContent = fmtMBs(ms > 0 ? bytes / (ms / 1000) : 0);
  $('recv-time-label').textContent = tEnd ? 'transfer time (done)' : 'transfer time';
}
setInterval(() => { updateProgressText(); updatePhase(); }, 100);

// The map: green = data code read directly, yellow = replaced with parity, gray = missing.
// Pale yellow means the parity for the code is received and will be resolved once all gaps are covered.
function drawChunkMap() {
  const cm = $('chunk-map');
  const dpr = window.devicePixelRatio || 1;
  cm.width = Math.round(cm.clientWidth * dpr); cm.height = Math.round((cm.clientHeight || 16) * dpr);
  const ctx = cm.getContext('2d');
  const css = getComputedStyle(document.documentElement);
  ctx.fillStyle = css.getPropertyValue('--missing'); ctx.fillRect(0, 0, cm.width, cm.height);
  $('progress-bar').style.width = dec.K ? `${(100 * dec.decoded) / dec.K}%` : '0';
  if (!dec.K) return;
  const n = dec.K, w = cm.width / n, ok = css.getPropertyValue('--ok'), par = css.getPropertyValue('--parity');
  let cov = dec.complete ? n : parityCovered();
  for (let i = 0; i < n; i++) {
    if (direct.has(i)) { ctx.globalAlpha = 1; ctx.fillStyle = ok; }
    else if (cov > 0) { cov--; ctx.globalAlpha = dec.complete ? 1 : 0.45; ctx.fillStyle = par; }
    else continue;
    ctx.fillRect(Math.floor(i * w), 0, Math.ceil(w), cm.height);
  }
  ctx.globalAlpha = 1;
}

function updateStats() {
  if (!cameraOn) return;
  const now = performance.now(), dt = (now - fpsT0) / 1000;
  if (dt >= 1) {
    lastFps = framesDone / dt;
    framesDone = 0; fpsT0 = now;
  }
}

function pump() {
  if (!cameraOn) return;
  updateStats();
  if (!done && video.readyState >= 2) {
    const w = workers.find((x) => !x.busy);
    if (w) {
      const vw = video.videoWidth, vh = video.videoHeight;
      if (grab.width !== vw || grab.height !== vh) { grab.width = vw; grab.height = vh; }
      gctx.drawImage(video, 0, 0, vw, vh);
      const img = gctx.getImageData(0, 0, vw, vh);
      w.busy = true;
      w.postMessage({ width: vw, height: vh, buffer: img.data.buffer }, [img.data.buffer]);
    }
  }
  if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(pump);
  else requestAnimationFrame(pump);
}

async function listCameras() {
  try {
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
    const sel = $('opt-camera');
    const cur = stream?.getVideoTracks()[0]?.getSettings().deviceId;
    sel.innerHTML = '';
    devs.forEach((d, i) => {
      const o = document.createElement('option');
      o.value = d.deviceId; o.textContent = d.label || `Camera ${i + 1}`;
      if (d.deviceId === cur) o.selected = true;
      sel.appendChild(o);
    });
    sel.hidden = devs.length < 2;
  } catch {}
}

async function startCamera(deviceId) {
  if (!navigator.mediaDevices?.getUserMedia) {
    setError('The camera requires HTTPS (or localhost) and a browser with camera support.');
    return;
  }
  stopCamera();
  initWorkers();
  const [w, h] = $('opt-res').value.split('x').map(Number);
  const video_c = { width: { ideal: w }, height: { ideal: h }, frameRate: { ideal: 30 } };
  if (deviceId) video_c.deviceId = { exact: deviceId };
  else video_c.facingMode = { ideal: 'environment' };
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: video_c, audio: false });
  } catch (e) {
    setError('Could not access the camera: ' + e.message);
    return;
  }
  const track = stream.getVideoTracks()[0];
  try {
    const caps = track.getCapabilities?.() || {};
    if (caps.focusMode?.includes('continuous')) await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
  } catch {}
  video.srcObject = stream;
  await video.play().catch(() => {});
  cameraOn = true;
  recvError = '';
  $('video-hint').hidden = true;
  $('btn-camera').textContent = 'Stop camera';
  keepAwake(true);
  listCameras();
  fpsT0 = performance.now(); framesDone = 0;
  pump();
}

function stopCamera() {
  cameraOn = false;
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  video.srcObject = null;
  $('video-hint').hidden = false;
  $('btn-camera').textContent = 'Start camera';
  if (!playing) keepAwake(false);
}

$('btn-camera').onclick = () => (cameraOn ? stopCamera() : startCamera($('opt-camera').value || undefined));
$('opt-camera').onchange = () => cameraOn && startCamera($('opt-camera').value);
$('opt-res').onchange = () => cameraOn && startCamera($('opt-camera').value || undefined);
$('btn-reset').onclick = () => {
  dec = new Decoder(); done = false; codesSeen = 0; paritySeen = 0; dupSeen = 0; direct = new Set(); lastCodeAt = 0; tStart = 0; tEnd = 0;
  updateProgressText();
  $('result').hidden = true; $('progress-bar').style.width = '0';
  drawChunkMap();
  setStatus('Waiting for QR codes …');
};

function finish() {
  done = true;
  tEnd = performance.now();
  updateProgressText();
  const { meta, file, ok } = dec.assemble();
  resultOk = ok;
  drawChunkMap();
  resultName = meta.name || 'file';
  resultBlob = new Blob([file], { type: meta.type || 'application/octet-stream' });
  if (lastResultUrl) URL.revokeObjectURL(lastResultUrl);
  lastResultUrl = URL.createObjectURL(resultBlob);
  // Only images get a preview; any other file type just offers the download.
  const resultImg = $('result-img');
  if ((meta.type || '').startsWith('image/')) {
    resultImg.hidden = false;
    resultImg.onerror = () => { resultImg.hidden = true; };
    resultImg.src = lastResultUrl;
  } else {
    resultImg.hidden = true;
    resultImg.removeAttribute('src');
  }
  $('btn-download').href = lastResultUrl;
  $('btn-download').download = resultName;
  $('result-info').textContent =
    `${resultName} · ${fmtBytes(file.length)} · ${dec.K} data codes: ${direct.size} read directly, ${dec.K - direct.size} recovered with parity · ` +
    `transferred in ${fmtClock(tEnd - tStart)} (${fmtMBs(file.length / Math.max(0.001, (tEnd - tStart) / 1000))} MB/s) · ` +
    (ok ? 'checksum OK ✔' : 'CHECKSUM FAILED – the file may be damaged');
  $('result').hidden = false;
  setStatus(`${direct.size} codes read directly (green) · ${dec.K - direct.size} recovered with parity (yellow) · ${dupSeen} duplicate codes re-read`);
  $('result').scrollIntoView({ behavior: 'smooth' });
  if (navigator.vibrate) navigator.vibrate(150);
}

$('btn-share').onclick = async () => {
  if (!resultBlob) return;
  const f = new File([resultBlob], resultName, { type: resultBlob.type });
  if (navigator.canShare?.({ files: [f] })) {
    try { await navigator.share({ files: [f], title: resultName }); } catch {}
  } else {
    $('btn-download').click();
  }
};

window.addEventListener('resize', drawChunkMap);

// ---------------------------------------------------------------- init
loadSettings();
updateCompressOptions();
let startTab = 'send';
try { startTab = new URLSearchParams(location.search).get('mode') || localStorage.getItem('qrsend6-tab') || 'send'; } catch {}
showTab(startTab === 'recv' ? 'recv' : 'send');
drawChunkMap();
if (!window.isSecureContext) {
  setError('Note: the page was not loaded over HTTPS – the camera will not work here.');
}
