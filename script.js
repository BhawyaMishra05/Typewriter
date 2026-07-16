/* ================================================
   THE TYPEWRITER  —  script.js
   Paper slides LEFT as you type (translateX).
   On Enter → carriage snaps back (translateX→0), page grows downward
   snaps back. Ink colour, bleed, sound, save image.
   ================================================ */
'use strict';

// ── KEYBOARD LAYOUT ──────────────────────────────
const ROWS = [
  ['`','1','2','3','4','5','6','7','8','9','0','-','=','⌫|1.5'],
  ['Tab|1.5','q','w','e','r','t','y','u','i','o','p','[',']','\\'],
  ['Caps|2','a','s','d','f','g','h','j','k','l',';',"'",'↵|2'],
  ['⇧|2.5','z','x','c','v','b','n','m',',','.','/','⇧|2.5'],
  ['Space|6'],
];

const KEY_CHAR = {
  'Space': ' ', '↵': '\n', '⌫': 'BACKSPACE',
  'Tab': '\t',  'Caps': 'CAPS', '⇧': 'SHIFT',
};

const SHIFT_MAP = {
  '1':'!','2':'@','3':'#','4':'$','5':'%','6':'^','7':'&',
  '8':'*','9':'(','0':')','-':'_','=':'+','[':'{',']':'}',
  '\\':'|',';':':','\'':'"',',':'<','.':'>','/':'?','`':'~',
};

// ── STATE ────────────────────────────────────────
let lines         = [''];      // array of strings, one per line
let currentLine   = 0;
let inkColor      = '#1a1208';
let soundOn       = true;
let inkBleedOn    = true;
let capsLock      = false;
let shiftActive   = false;
let isHandlingKey = false;     // guard against double-fire

// carriage / paper transform state
let charIndex     = 0;         // chars typed on current line (for carriage + paper slide)
const CHAR_WIDTH  = 10.5;      // px per monospace char (approx at 1.06rem Courier Prime)
const LINE_HEIGHT = 28;        // px per line (must match CSS)
const MAX_SLIDE   = 340;       // max px the paper slides left before we wrap

// visual queue
let charQueue  = [];
let queueTimer = null;
const QUEUE_MS = 26;

// ── DOM ──────────────────────────────────────────
const paperSheet      = document.getElementById('paperSheet');
const paperContent    = document.getElementById('paperContent');
const carriageEl      = document.getElementById('carriageIndicator');
const soundToggle     = document.getElementById('soundToggle');
const inkBleedToggle  = document.getElementById('inkBleedToggle');
const clearBtn        = document.getElementById('clearBtn');
const saveBtn         = document.getElementById('saveBtn');
const saveImgBtn      = document.getElementById('saveImgBtn');
const inkColorPicker  = document.getElementById('inkColorPicker');
const toastEl         = document.getElementById('toast');
const paperViewport   = document.getElementById('paperViewport');

// ── BUILD KEYBOARD ───────────────────────────────
function buildKeyboard() {
  const kb = document.getElementById('keyboard');
  kb.innerHTML = '';
  ROWS.forEach(row => {
    const rowEl = document.createElement('div');
    rowEl.className = 'key-row';
    row.forEach(def => {
      const [label, wide] = def.split('|');
      const btn = document.createElement('button');
      btn.className   = 'key';
      btn.dataset.key = label;
      btn.type        = 'button';
      if (wide) btn.dataset.wide = wide;
      const cap = document.createElement('div');
      cap.className   = 'key-cap';
      cap.textContent = label;
      btn.appendChild(cap);
      rowEl.appendChild(btn);
    });
    kb.appendChild(rowEl);
  });
}

// ── AUDIO ────────────────────────────────────────
let audioCtx;
function ac() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}
function playClick(type) {
  if (!soundOn) return;
  try {
    const ctx = ac(), now = ctx.currentTime;
    const gain = ctx.createGain();
    gain.connect(ctx.destination);

    if (type === 'key') {
      const buf  = ctx.createBuffer(1, ctx.sampleRate * 0.055, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < data.length; i++)
        data[i] = (Math.random()*2-1) * Math.pow(1 - i/data.length, 3.5);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass'; f.frequency.value = 1900; f.Q.value = 1.4;
      src.connect(f); f.connect(gain);
      gain.gain.setValueAtTime(0.3, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.055);
      src.start(now);

    } else if (type === 'return') {
      const osc = ctx.createOscillator();
      osc.connect(gain);
      osc.type = 'sine';
      osc.frequency.setValueAtTime(870, now);
      osc.frequency.exponentialRampToValueAtTime(640, now + 0.14);
      gain.gain.setValueAtTime(0.16, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
      osc.start(now); osc.stop(now + 0.18);

    } else if (type === 'backspace') {
      const buf  = ctx.createBuffer(1, ctx.sampleRate * 0.045, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < data.length; i++)
        data[i] = (Math.random()*2-1) * Math.pow(1 - i/data.length, 5);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(gain);
      gain.gain.setValueAtTime(0.14, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.045);
      src.start(now);
    }
  } catch(_) {}
}

// ── PAPER + CARRIAGE MOTION ──────────────────────
/*
  Paper slides LEFT as characters are added to the line.
  translateX = -(charIndex * CHAR_WIDTH)
  (translateY removed — page grows naturally, user scrolls to see prev lines)
*/
function updateTransform(animate) {
  const tx = -(charIndex * CHAR_WIDTH);
  // No translateY — the paper grows naturally and the user scrolls up to see prev lines
  if (!animate) paperSheet.style.transition = 'none';
  else          paperSheet.style.transition = 'transform 0.07s linear';
  paperSheet.style.transform = `translateX(${tx}px)`;
}

function updateCarriage() {
  // Carriage indicator moves right as paper moves left
  const viewW     = carriageEl.parentElement.offsetWidth;
  const progress  = Math.min(charIndex * CHAR_WIDTH / MAX_SLIDE, 1);
  const leftPct   = 8 + progress * 74;   // 8% → 82%
  carriageEl.style.left = leftPct + '%';
}

// After newline: snap carriage back + nudge paper up
function carriageReturn() {
  carriageEl.style.transition = 'left 0.2s cubic-bezier(0.4,0,0.2,1)';
  carriageEl.style.left = '8%';
  setTimeout(() => {
    carriageEl.style.transition = 'left 0.05s linear';
  }, 220);
}

// ── LINE DOM MANAGEMENT ──────────────────────────
let lineEls = [];   // DOM elements, one per line
let cursorEl;

function initDOM() {
  paperContent.innerHTML = '';
  lineEls = [];
  cursorEl = document.createElement('span');
  cursorEl.className = 'cursor';
  cursorEl.textContent = '|';

  const lineEl = createLineEl();
  lineEl.appendChild(cursorEl);
  paperContent.appendChild(lineEl);
  lineEls.push(lineEl);
}

function createLineEl() {
  const d = document.createElement('div');
  d.className = 'type-line';
  d.style.color = inkColor;
  return d;
}

// Rebuild a line's character spans from its string
function rebuildLine(lineIdx) {
  const el  = lineEls[lineIdx];
  const str = lines[lineIdx];
  // remove all nodes except cursor if it's here
  while (el.firstChild) el.removeChild(el.firstChild);
  for (const ch of str) {
    el.appendChild(makeCharSpan(ch));
  }
  // re-append cursor if this is the active line
  if (lineIdx === currentLine) el.appendChild(cursorEl);
}

function makeCharSpan(ch) {
  if (inkBleedOn) {
    const span = document.createElement('span');
    span.className = 'ink-char ink-on';
    span.dataset.char = ch;
    span.textContent = ch;
    span.style.color = inkColor;
    return span;
  } else {
    return document.createTextNode(ch);
  }
}

// ── QUEUE FLUSH ──────────────────────────────────
function flushQueue() {
  if (!charQueue.length) { queueTimer = null; return; }
  const item = charQueue.shift();

  if (item.type === 'add') {
    addCharToDOM(item.ch);
  } else if (item.type === 'del') {
    delCharFromDOM();
  } else if (item.type === 'newline') {
    newlineDOM();
  }

  queueTimer = setTimeout(flushQueue, QUEUE_MS);
}

function enqueue(item) {
  charQueue.push(item);
  if (!queueTimer) queueTimer = setTimeout(flushQueue, QUEUE_MS);
}

// ── DOM OPERATIONS ───────────────────────────────
function addCharToDOM(ch) {
  const lineEl = lineEls[currentLine];
  // insert char span before cursor
  const span = makeCharSpan(ch);
  lineEl.insertBefore(span, cursorEl);
  charIndex++;
  updateTransform(true);
  updateCarriage();
  // Keep cursor in view as the line grows
  requestAnimationFrame(() => {
    cursorEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
}

function delCharFromDOM() {
  const lineEl = lineEls[currentLine];
  // find last node before cursor
  const nodes = Array.from(lineEl.childNodes);
  const cursorIdx = nodes.indexOf(cursorEl);
  if (cursorIdx > 0) {
    lineEl.removeChild(nodes[cursorIdx - 1]);
    charIndex = Math.max(0, charIndex - 1);
    updateTransform(true);
    updateCarriage();
  } else if (currentLine > 0) {
    // backspace across a line — move cursor to end of previous line
    lineEl.removeChild(cursorEl);
    currentLine--;
    lines.splice(currentLine + 1, 1);
    charIndex = lines[currentLine].length;
    lineEls[currentLine].appendChild(cursorEl);
    // remove old line element
    const old = lineEls.splice(currentLine + 1, 1)[0];
    paperContent.removeChild(old);
    updateTransform(true);
    updateCarriage();
  }
}

function newlineDOM() {
  const lineEl = lineEls[currentLine];
  lineEl.removeChild(cursorEl);

  // data model: add a new blank line and move to it
  currentLine++;
  lines.splice(currentLine, 0, '');
  charIndex = 0; // paper slides back to X=0 via updateTransform

  const newEl = createLineEl();
  newEl.appendChild(cursorEl);

  const afterEl = lineEls[currentLine - 1].nextSibling;
  if (afterEl) paperContent.insertBefore(newEl, afterEl);
  else         paperContent.appendChild(newEl);

  lineEls.splice(currentLine, 0, newEl);

  carriageReturn();
  updateTransform(true); // translateX resets to 0 (carriage return)
  updateCarriage();
  // Scroll so the new line is always visible at the bottom of the viewport
  requestAnimationFrame(() => {
    cursorEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
}

// ── PROCESS INPUT ────────────────────────────────
function processChar(ch) {
  if (ch === 'CAPS')  { capsLock = !capsLock; return; }
  if (ch === 'SHIFT') return;

  if (ch === 'BACKSPACE') {
    // Real typewriters cannot erase — backspace is disabled
    showToast('Typewriters cannot erase. Embrace the mistake ✦');
    return;
  }

  if (ch === '\n') {
    // data model is updated inside newlineDOM, not here
    playClick('return');
    enqueue({ type: 'newline' });
    return;
  }

  // Tab → 4 spaces, each added as individual chars so charIndex stays in sync
  if (ch === '\t') {
    for (let i = 0; i < 4; i++) {
      lines[currentLine] += ' ';
      playClick('key');
      enqueue({ type: 'add', ch: ' ' });
    }
    return;
  }

  lines[currentLine] += ch;
  playClick('key');
  enqueue({ type: 'add', ch });
}

// ── PHYSICAL KEYBOARD ────────────────────────────
document.addEventListener('keydown', e => {
  if (isHandlingKey) return;
  isHandlingKey = true;
  setTimeout(() => { isHandlingKey = false; }, 0);

  if (e.key === 'Shift')    { shiftActive = true; return; }
  if (e.key === 'CapsLock') { capsLock = !capsLock; hlKey('Caps', true); return; }

  // Prevent browser scroll on space/arrows
  if (['Space','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.code)) {
    e.preventDefault();
  }
  if (e.key === 'Tab') e.preventDefault();

  let ch;
  if      (e.key === 'Backspace') { ch = 'BACKSPACE'; hlKey('⌫', true); }
  else if (e.key === 'Enter')     { ch = '\n';         hlKey('↵', true); }
  else if (e.key === 'Tab')       { ch = '\t';         hlKey('Tab', true); }
  else if (e.key === ' ')         { ch = ' ';          hlKey('Space', true); }
  else if (e.key.length === 1) {
    const raw = e.key;
    ch = shiftActive ? (SHIFT_MAP[raw] || raw.toUpperCase())
       : capsLock && raw.match(/[a-z]/) ? raw.toUpperCase()
       : raw;
    hlKey(raw.toLowerCase(), true);
  } else return;

  processChar(ch);
});

document.addEventListener('keyup', e => {
  if (e.key === 'Shift') { shiftActive = false; return; }
  const map = { Backspace:'⌫', Enter:'↵', Tab:'Tab', ' ':'Space' };
  hlKey(map[e.key] || e.key.toLowerCase(), false);
});

// ── ON-SCREEN KEYBOARD ───────────────────────────
const kb = document.getElementById('keyboard');

kb.addEventListener('mousedown', e => e.preventDefault()); // don't steal focus

kb.addEventListener('click', e => {
  const btn = e.target.closest('.key');
  if (!btn) return;
  const label = btn.dataset.key;
  let ch = KEY_CHAR[label];

  if (ch === undefined) {
    const raw = label;
    ch = shiftActive ? (SHIFT_MAP[raw] || raw.toUpperCase())
       : capsLock && raw.match(/[a-zA-Z]/) ? raw.toUpperCase()
       : raw;
  }

  animKey(btn);
  addRipple(btn);

  if (ch === 'SHIFT') { shiftActive = !shiftActive; return; }
  processChar(ch);
});

kb.addEventListener('touchstart', e => {
  const btn = e.target.closest('.key');
  if (!btn) return;
  e.preventDefault();
  btn.click();
}, { passive: false });

// ── KEY VISUALS ──────────────────────────────────
function hlKey(label, down) {
  document.querySelectorAll('.key').forEach(btn => {
    const k = btn.dataset.key;
    if (k === label || k.toLowerCase() === label ||
        (KEY_CHAR[k] && KEY_CHAR[k] === label)) {
      down ? btn.classList.add('pressed') : btn.classList.remove('pressed');
    }
  });
}
function animKey(btn) {
  btn.classList.add('pressed');
  setTimeout(() => btn.classList.remove('pressed'), 85);
}
function addRipple(btn) {
  const r = document.createElement('div');
  r.className = 'key-ripple';
  btn.appendChild(r);
  r.addEventListener('animationend', () => r.remove(), { once: true });
}

// ── INK COLOUR ───────────────────────────────────
function setInkColor(color) {
  inkColor = color;
  document.documentElement.style.setProperty('--ink', color);
  document.documentElement.style.setProperty('--cursor-clr', color);
  // update existing line elements
  lineEls.forEach(el => { el.style.color = color; });
}

document.querySelectorAll('.ink-swatch:not(.ink-custom)').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.ink-swatch').forEach(s => s.classList.remove('active'));
    btn.classList.add('active');
    setInkColor(btn.dataset.ink);
    inkColorPicker.value = btn.dataset.ink;
  });
});

inkColorPicker.addEventListener('input', () => {
  document.querySelectorAll('.ink-swatch').forEach(s => s.classList.remove('active'));
  document.querySelector('.ink-custom').classList.add('active');
  setInkColor(inkColorPicker.value);
});

// ── THEME ────────────────────────────────────────
document.querySelectorAll('.swatch').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.swatch').forEach(s => s.classList.remove('active'));
    btn.classList.add('active');
    document.body.dataset.theme = btn.dataset.theme;
    showToast('Theme: ' + btn.dataset.theme);
  });
});

// ── TOGGLES ──────────────────────────────────────
soundToggle.addEventListener('change',   () => { soundOn     = soundToggle.checked; });
inkBleedToggle.addEventListener('change',() => { inkBleedOn  = inkBleedToggle.checked; });

// ── CLEAR ────────────────────────────────────────
clearBtn.addEventListener('click', () => {
  lines     = [''];
  currentLine = 0;
  charIndex   = 0;
  charQueue   = [];
  if (queueTimer) { clearTimeout(queueTimer); queueTimer = null; }
  initDOM();
  paperSheet.style.transition = 'none';
  paperSheet.style.transform  = 'translateX(0)';
  carriageEl.style.left = '8%';
  showToast('Page cleared.');
});

// ── SAVE TEXT ────────────────────────────────────
saveBtn.addEventListener('click', () => {
  const text = lines.join('\n').trim();
  if (!text) { showToast('Nothing to save yet!'); return; }
  const blob = new Blob([text], { type: 'text/plain' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = 'typewriter-' + new Date().toISOString().slice(0,10) + '.txt';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast('Text saved!');
});

// ── SAVE IMAGE ───────────────────────────────────
/*
  We snapshot the paperSheet element itself (the full paper, not
  the clipped viewport) so the user gets the whole typed page.
  We temporarily reset the transform so the content is fully visible.
*/
saveImgBtn.addEventListener('click', async () => {
  if (typeof html2canvas === 'undefined') {
    showToast('html2canvas not loaded — try again shortly.');
    return;
  }

  showToast('Capturing image…');

  // 1. Grab current transform and temporarily clear it
  const savedTransform    = paperSheet.style.transform;
  const savedTransition   = paperSheet.style.transition;
  paperSheet.style.transition = 'none';
  paperSheet.style.transform  = 'translateX(0)';

  // 2. Brief rAF so browser paints before capture
  await new Promise(r => requestAnimationFrame(r));
  await new Promise(r => setTimeout(r, 60));

  try {
    const canvas = await html2canvas(paperSheet, {
      scale: 2,
      useCORS: true,
      backgroundColor: getComputedStyle(document.documentElement)
                         .getPropertyValue('--paper-bg').trim() || '#f5f0e8',
      logging: false,
    });

    canvas.toBlob(blob => {
      const url = URL.createObjectURL(blob);
      const a   = document.createElement('a');
      a.href = url;
      a.download = 'typewriter-' + new Date().toISOString().slice(0,10) + '.png';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showToast('Image saved!');
    }, 'image/png');

  } catch (err) {
    showToast('Image capture failed.');
    console.error(err);
  } finally {
    // 3. Restore transform
    paperSheet.style.transition = savedTransition;
    paperSheet.style.transform  = savedTransform;
  }
});

// ── TOAST ────────────────────────────────────────
let toastTimer;
function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2400);
}

// ── INIT ─────────────────────────────────────────
buildKeyboard();
initDOM();
updateTransform(false);
updateCarriage();

// Prevent page scroll on space / arrow keys
window.addEventListener('keydown', e => {
  if (['Space','ArrowUp','ArrowDown'].includes(e.code)) e.preventDefault();
}, { capture: true });