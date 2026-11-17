/*
 * LocalGram — an offline Nonogram (Picross) PWA.
 *
 * This file has two parts:
 *   1. Core: pure puzzle logic (seeded RNG, clue computation, line solver,
 *      generator). It has no DOM dependency and is exported for Node tests.
 *   2. App: the browser UI (rendering, input, timer, storage, service worker).
 *      It only runs when a `document` exists.
 */
'use strict';

/* ======================================================================
 * 1. CORE — pure puzzle logic
 * ==================================================================== */
const Core = (() => {
  /** Cell values used by the solver and the player grid. */
  const UNKNOWN = -1; // solver only: not yet deduced
  const EMPTY = 0;
  const FILLED = 1;

  /** Hash a string into a 32-bit seed (FNV-1a). */
  function hashString(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  /** Mulberry32: tiny, fast, seeded PRNG returning floats in [0, 1). */
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** Lengths of consecutive filled runs in a line, e.g. [1,1,0,1] -> [2,1]. */
  function runsOf(line) {
    const runs = [];
    let run = 0;
    for (const v of line) {
      if (v === FILLED) run++;
      else if (run) { runs.push(run); run = 0; }
    }
    if (run) runs.push(run);
    return runs;
  }

  /** Row and column clues for a solution grid (array of rows). */
  function cluesFor(grid) {
    const n = grid.length;
    const rows = grid.map(runsOf);
    const cols = [];
    for (let c = 0; c < n; c++) cols.push(runsOf(grid.map((row) => row[c])));
    return { rows, cols };
  }

  /**
   * Line solver: given a partially known line and its clue, return the line
   * with every cell that is forced in *all* valid arrangements filled in,
   * or null if no arrangement fits (contradiction).
   *
   * Method: dynamic programming over (position, number of blocks placed).
   * The line is padded with one trailing EMPTY so every block can be
   * treated as "block + at least one gap cell".
   *   F[i][j] — cells [0, i) can hold the first j blocks.
   *   B[i][j] — cells [i, end) can hold blocks j..k-1.
   * A cell may be empty / filled if some arrangement through it exists.
   * Complexity O(n² · k), plenty fast for 15-cell lines.
   */
  function solveLine(line, clue) {
    const n = line.length;
    const L = n + 1;
    const cells = line.concat([EMPTY]);
    const k = clue.length;

    // emptyBefore[i] = number of known-EMPTY cells in [0, i): lets us test
    // "no EMPTY in a range" in O(1).
    const emptyBefore = new Array(L + 1).fill(0);
    for (let i = 0; i < L; i++) emptyBefore[i + 1] = emptyBefore[i] + (cells[i] === EMPTY ? 1 : 0);
    // Can block j start at position s (cells s..s+len-1 fillable, s+len a gap)?
    const fits = (s, j) => {
      const e = s + clue[j];
      return e < L && emptyBefore[e] - emptyBefore[s] === 0 && cells[e] !== FILLED;
    };

    const F = Array.from({ length: L + 1 }, () => new Array(k + 1).fill(false));
    F[0][0] = true;
    for (let i = 0; i < L; i++) {
      for (let j = 0; j <= k; j++) {
        if (!F[i][j]) continue;
        if (cells[i] !== FILLED) F[i + 1][j] = true;
        if (j < k && fits(i, j)) F[i + clue[j] + 1][j + 1] = true;
      }
    }
    if (!F[L][k]) return null;

    const B = Array.from({ length: L + 1 }, () => new Array(k + 1).fill(false));
    B[L][k] = true;
    for (let i = L - 1; i >= 0; i--) {
      for (let j = k; j >= 0; j--) {
        let ok = cells[i] !== FILLED && B[i + 1][j];
        if (!ok && j < k && fits(i, j)) ok = B[i + clue[j] + 1][j + 1];
        B[i][j] = ok;
      }
    }

    const canEmpty = new Array(n).fill(false);
    const fillDiff = new Array(n + 1).fill(0); // difference array for "can be filled"
    for (let i = 0; i < n; i++) {
      for (let j = 0; j <= k; j++) {
        if (!F[i][j]) continue;
        if (cells[i] !== FILLED && B[i + 1][j]) canEmpty[i] = true;
        if (j < k && fits(i, j) && B[i + clue[j] + 1][j + 1]) {
          fillDiff[i]++;
          fillDiff[i + clue[j]]--;
          // The mandatory gap after the block is empty in this arrangement.
          if (i + clue[j] < n) canEmpty[i + clue[j]] = true;
        }
      }
    }

    const out = line.slice();
    let acc = 0;
    for (let i = 0; i < n; i++) {
      acc += fillDiff[i];
      const canFill = acc > 0;
      if (canFill && !canEmpty[i]) out[i] = FILLED;
      else if (!canFill && canEmpty[i]) out[i] = EMPTY;
      else if (!canFill && !canEmpty[i]) return null;
    }
    return out;
  }

  /**
   * Solve a puzzle by line logic alone (no guessing). Repeatedly applies
   * solveLine to every row and column until nothing changes.
   * Returns { solved, contradiction, grid }.
   */
  function solveByLogic(rowClues, colClues) {
    const h = rowClues.length;
    const w = colClues.length;
    const grid = Array.from({ length: h }, () => new Array(w).fill(UNKNOWN));
    // Only revisit lines whose cells changed since we last looked at them.
    const dirtyRows = new Array(h).fill(true);
    const dirtyCols = new Array(w).fill(true);
    let progress = true;
    while (progress) {
      progress = false;
      for (let r = 0; r < h; r++) {
        if (!dirtyRows[r]) continue;
        dirtyRows[r] = false;
        const res = solveLine(grid[r], rowClues[r]);
        if (!res) return { solved: false, contradiction: true, grid };
        for (let c = 0; c < w; c++) {
          if (res[c] !== grid[r][c]) { grid[r][c] = res[c]; dirtyCols[c] = true; progress = true; }
        }
      }
      for (let c = 0; c < w; c++) {
        if (!dirtyCols[c]) continue;
        dirtyCols[c] = false;
        const col = grid.map((row) => row[c]);
        const res = solveLine(col, colClues[c]);
        if (!res) return { solved: false, contradiction: true, grid };
        for (let r = 0; r < h; r++) {
          if (res[r] !== grid[r][c]) { grid[r][c] = res[r]; dirtyRows[r] = true; progress = true; }
        }
      }
    }
    const solved = grid.every((row) => row.every((v) => v !== UNKNOWN));
    return { solved, contradiction: false, grid };
  }

  /** Fill probability per size: dense enough to give logic a foothold. */
  const DENSITY = { 5: 0.55, 10: 0.55, 15: 0.55 };

  /**
   * Generate a puzzle of the given size from a seed string.
   * Random grids are drawn from the seeded RNG until one is fully solvable
   * by line logic, which guarantees a unique solution. Same seed => same
   * puzzle on every device.
   */
  function generatePuzzle(size, seed) {
    const rng = mulberry32(hashString(`${seed}|${size}`));
    const density = DENSITY[size] || 0.6;
    for (let attempt = 1; attempt <= 5000; attempt++) {
      const solution = Array.from({ length: size }, () =>
        Array.from({ length: size }, () => (rng() < density ? FILLED : EMPTY)));
      const { rows, cols } = cluesFor(solution);
      // Skip grids with a blank row or column: they make dull pictures.
      if (rows.some((r) => !r.length) || cols.some((c) => !c.length)) continue;
      if (solveByLogic(rows, cols).solved) {
        return { size, seed: String(seed), solution, rows, cols, attempts: attempt };
      }
    }
    throw new Error(`Could not generate a ${size}x${size} puzzle for seed ${seed}`);
  }

  /** Local date as YYYY-MM-DD (used to seed the daily puzzle). */
  function localDateKey(d = new Date()) {
    const pad = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  return {
    UNKNOWN, EMPTY, FILLED,
    hashString, mulberry32, runsOf, cluesFor, solveLine, solveByLogic,
    generatePuzzle, localDateKey,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Core;

/* ======================================================================
 * 2. APP — browser UI
 * ==================================================================== */
if (typeof document !== 'undefined') (function App() {
  const { FILLED, EMPTY, generatePuzzle, runsOf, localDateKey } = Core;
  const CROSS = 2; // player grid values: EMPTY (0), FILLED (1), CROSS (2)
  const STORE_KEY = 'localgram:v1';
  const MAX_HISTORY = 300; // undo steps kept in storage
  const $ = (id) => document.getElementById(id);

  /* ---------------- Persistent storage (localStorage) ----------------
   * One JSON object:
   *   settings  — mode, size, tool, check mistakes, haptics
   *   progress  — one in-progress puzzle per "mode-size" slot
   *   completed — puzzle id -> { time, at }
   *   best      — size -> best time in ms
   */
  const DEFAULTS = {
    settings: { mode: 'daily', size: 10, tool: 'fill', check: false, haptics: true },
    progress: {},
    completed: {},
    best: {},
  };

  function loadStore() {
    let data = null;
    try { data = JSON.parse(localStorage.getItem(STORE_KEY)); } catch (e) { /* corrupt or blocked */ }
    data = data && typeof data === 'object' ? data : {};
    return {
      settings: { ...DEFAULTS.settings, ...(data.settings || {}) },
      progress: data.progress || {},
      completed: data.completed || {},
      best: data.best || {},
    };
  }

  function saveStore() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch (e) { /* storage full/blocked */ }
  }

  const store = loadStore();

  /* ---------------- Game state ---------------- */
  let puzzle = null;   // { size, seed, solution, rows, cols }
  let slot = null;     // the store.progress entry being played
  let grid = [];       // flat array, player marks
  let undoStack = [];  // each entry: [[index, oldValue, newValue], ...]
  let redoStack = [];
  let solved = false;
  let elapsedBase = 0;    // ms accumulated before the current run
  let runningSince = null; // timestamp when the timer last resumed
  let drag = null;        // active pointer stroke
  let cellEls = [];
  let cellBase = [];      // static class names per cell (grid lines)

  const el = {
    board: $('board'), cells: $('cells'), rowClues: $('row-clues'), colClues: $('col-clues'),
    timer: $('timer'), status: $('status'), undo: $('undo'), redo: $('redo'),
    restart: $('restart'), newRandom: $('new-random'), check: $('opt-check'), haptics: $('opt-haptics'),
    win: $('win'), winText: $('win-text'), winImage: $('win-image'), toast: $('toast'), confetti: $('confetti'),
  };

  const n = () => puzzle.size;
  const puzzleId = () => `${slot.seed}:${puzzle.size}`;
  const randomSeed = () => `random:${Math.floor(Math.random() * 0xffffffff).toString(36)}`;

  /* ---------------- Loading puzzles ---------------- */

  /** Load (or create) the puzzle for the current mode and size. */
  function loadSlot() {
    const { mode, size } = store.settings;
    const key = `${mode}-${size}`;
    let p = store.progress[key];
    if (mode === 'daily') {
      const seed = `daily:${localDateKey()}`;
      if (!p || p.seed !== seed) p = freshSlot(seed);
    } else if (!p) {
      p = freshSlot(randomSeed());
    }
    store.progress[key] = p;
    slot = p;
    puzzle = generatePuzzle(size, p.seed);

    const cells = size * size;
    grid = (p.grid && p.grid.length === cells ? p.grid.split('') : new Array(cells).fill('0')).map(Number);
    undoStack = p.undo || [];
    redoStack = p.redo || [];
    solved = !!p.solved;
    elapsedBase = p.elapsed || 0;
    runningSince = null;

    buildBoard();
    updateControls();
    if (!solved) resumeTimer();
    renderTimer();
    saveStore();
  }

  function freshSlot(seed) {
    return { seed, grid: '', undo: [], redo: [], elapsed: 0, solved: false };
  }

  /** Write the current game into its slot and save everything. */
  function persist() {
    if (!slot) return;
    slot.grid = grid.join('');
    slot.undo = undoStack.slice(-MAX_HISTORY);
    slot.redo = redoStack.slice(-MAX_HISTORY);
    slot.elapsed = currentElapsed();
    slot.solved = solved;
    saveStore();
  }

  /* ---------------- Timer ---------------- */
  const currentElapsed = () => elapsedBase + (runningSince ? Date.now() - runningSince : 0);

  function resumeTimer() {
    if (!solved && !runningSince && document.visibilityState === 'visible') runningSince = Date.now();
  }
  function pauseTimer() {
    elapsedBase = currentElapsed();
    runningSince = null;
  }
  function formatTime(ms) {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
  }
  function renderTimer() { el.timer.textContent = formatTime(currentElapsed()); }
  setInterval(renderTimer, 500);

  /* ---------------- Rendering ---------------- */

  /** Build clue and cell elements for the current puzzle. */
  function buildBoard() {
    const size = n();
    el.board.style.setProperty('--n', size);
    el.board.classList.toggle('solved', solved);

    el.colClues.replaceChildren(...puzzle.cols.map((clue) => clueEl(clue)));
    el.rowClues.replaceChildren(...puzzle.rows.map((clue) => clueEl(clue)));

    cellEls = [];
    cellBase = [];
    const frag = document.createDocumentFragment();
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        let cls = 'cell';
        if (c === size - 1) cls += ' edge-r'; else if ((c + 1) % 5 === 0) cls += ' major-r';
        if (r === size - 1) cls += ' edge-b'; else if ((r + 1) % 5 === 0) cls += ' major-b';
        const d = document.createElement('div');
        cellEls.push(d);
        cellBase.push(cls);
        frag.appendChild(d);
      }
    }
    el.cells.replaceChildren(frag);
    layout();
    grid.forEach((_, i) => paintCell(i));
    updateClues();
    renderStatus();
  }

  function clueEl(clue) {
    const d = document.createElement('div');
    d.className = 'clue';
    for (const num of clue.length ? clue : [0]) {
      const s = document.createElement('span');
      s.textContent = num;
      d.appendChild(s);
    }
    return d;
  }

  /**
   * Size cells so the board fits the screen width. Row clues take a variable
   * width, so estimate it from the longest clue, then give the rest to cells.
   * 10x10 cells are never smaller than 28px (board scrolls sideways instead).
   */
  function layout() {
    const size = n();
    const avail = Math.min(document.documentElement.clientWidth, 560) - 16 - 4 - 4; // gutters, border, clue padding
    let cell = 40;
    let font = 14;
    for (let pass = 0; pass < 3; pass++) {
      font = Math.max(10, Math.min(15, Math.round(cell * 0.46)));
      const rowW = Math.max(...puzzle.rows.map((clue) =>
        clue.reduce((w, num) => w + String(num).length * font * 0.62, 0) + (clue.length - 1) * font * 0.45));
      cell = Math.floor((avail - rowW - 4) / size);
    }
    const minCell = size <= 10 ? 28 : 18;
    cell = Math.max(minCell, Math.min(44, cell));
    font = Math.max(10, Math.min(15, Math.round(cell * 0.46)));
    el.board.style.setProperty('--cell', `${cell}px`);
    el.board.style.setProperty('--clue-font', `${font}px`);
  }

  const isError = (i) =>
    (grid[i] === FILLED && puzzle.solution[(i / n()) | 0][i % n()] !== FILLED) ||
    (grid[i] === CROSS && puzzle.solution[(i / n()) | 0][i % n()] === FILLED);

  function paintCell(i) {
    const v = grid[i];
    let cls = cellBase[i];
    if (v === FILLED) cls += ' f';
    else if (v === CROSS) cls += ' x';
    if (store.settings.check && !solved && isError(i)) cls += ' err';
    cellEls[i].className = cls;
  }

  /** Dim every clue whose line currently matches it. */
  function updateClues() {
    const size = n();
    for (let r = 0; r < size; r++) {
      const line = grid.slice(r * size, r * size + size);
      el.rowClues.children[r].classList.toggle('done', sameClue(runsOf(line), puzzle.rows[r]));
    }
    for (let c = 0; c < size; c++) {
      const line = [];
      for (let r = 0; r < size; r++) line.push(grid[r * size + c]);
      el.colClues.children[c].classList.toggle('done', sameClue(runsOf(line), puzzle.cols[c]));
    }
  }
  const sameClue = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

  function renderStatus() {
    const { mode, size } = store.settings;
    const done = store.completed[puzzleId()];
    const best = store.best[size];
    const parts = [];
    if (mode === 'daily') {
      const d = new Date();
      parts.push(`Daily · ${d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}`);
    } else {
      parts.push(`Random #${slot.seed.split(':')[1]}`);
    }
    if (done) parts.push(`✓ ${formatTime(done.time)}`);
    if (best) parts.push(`Best ${size}×${size}: ${formatTime(best)}`);
    el.status.textContent = parts.join(' · ');
  }

  function updateControls() {
    const s = store.settings;
    document.querySelectorAll('#mode-picker button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.mode === s.mode));
    document.querySelectorAll('#size-picker button').forEach((b) => b.setAttribute('aria-pressed', Number(b.dataset.size) === s.size));
    document.querySelectorAll('#tool-picker button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.tool === s.tool));
    el.undo.disabled = solved || !undoStack.length;
    el.redo.disabled = solved || !redoStack.length;
    el.check.checked = s.check;
    el.haptics.checked = s.haptics;
  }

  /* ---------------- Input: tap and drag painting ----------------
   * A stroke starts on a cell. Its effect is decided once, from that cell:
   *   - tool value differs from the cell -> set cells to the tool value,
   *   - cell already has the tool value  -> clear cells.
   * Only cells that had the same value as the starting cell are changed,
   * so a stroke never wipes unrelated marks. After the first move the
   * stroke locks to the row or column it started in.
   */
  function cellFromEvent(e) {
    const rect = el.cells.getBoundingClientRect();
    const border = 2;
    const size = n();
    const step = (rect.width - border * 2) / size;
    const clamp = (v) => Math.max(0, Math.min(size - 1, v));
    return {
      r: clamp(Math.floor((e.clientY - rect.top - border) / step)),
      c: clamp(Math.floor((e.clientX - rect.left - border) / step)),
    };
  }

  function onPointerDown(e) {
    if (solved || drag) return;
    if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 2) return;
    e.preventDefault();
    el.cells.setPointerCapture(e.pointerId);
    const { r, c } = cellFromEvent(e);
    const tool = e.button === 2 ? 'cross' : store.settings.tool; // right-click = X on desktop
    const toolValue = tool === 'fill' ? FILLED : CROSS;
    const from = grid[r * n() + c];
    drag = { id: e.pointerId, r0: r, c0: c, from, to: from === toolValue ? EMPTY : toolValue, axis: null, changes: [] };
    paintAt(r, c);
    updateClues();
  }

  function onPointerMove(e) {
    if (!drag || e.pointerId !== drag.id) return;
    e.preventDefault();
    let { r, c } = cellFromEvent(e);
    if (!drag.axis) {
      if (r === drag.r0 && c === drag.c0) return;
      drag.axis = Math.abs(r - drag.r0) > Math.abs(c - drag.c0) ? 'col' : 'row';
    }
    if (drag.axis === 'row') r = drag.r0; else c = drag.c0;
    // Paint the whole segment so fast swipes don't skip cells.
    const [a, b] = drag.axis === 'row' ? [drag.c0, c] : [drag.r0, r];
    const stepDir = a <= b ? 1 : -1;
    for (let k = a; k !== b + stepDir; k += stepDir) {
      if (drag.axis === 'row') paintAt(drag.r0, k); else paintAt(k, drag.c0);
    }
    updateClues();
  }

  function paintAt(r, c) {
    const i = r * n() + c;
    if (grid[i] !== drag.from || drag.from === drag.to) return;
    drag.changes.push([i, drag.from, drag.to]);
    grid[i] = drag.to;
    paintCell(i);
    haptic(drag.to === EMPTY ? 5 : 10);
  }

  function onPointerUp(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const { changes } = drag;
    drag = null;
    if (!changes.length) return;
    undoStack.push(changes);
    if (undoStack.length > MAX_HISTORY) undoStack.shift();
    redoStack = [];
    afterChange();
  }

  /** Common bookkeeping after the grid changed. */
  function afterChange() {
    updateClues();
    checkWin();
    updateControls();
    persist();
  }

  el.cells.addEventListener('pointerdown', onPointerDown);
  el.cells.addEventListener('pointermove', onPointerMove);
  el.cells.addEventListener('pointerup', onPointerUp);
  el.cells.addEventListener('pointercancel', onPointerUp);
  el.cells.addEventListener('contextmenu', (e) => e.preventDefault());
  // Belt and braces for older iOS: stop touch scrolling/zoom on the grid.
  el.cells.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
  el.cells.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });

  /* ---------------- Undo / redo / restart ---------------- */
  function applyHistory(from, to, useOld) {
    const entry = from.pop();
    if (!entry || solved) return;
    for (const [i, oldV, newV] of useOld ? [...entry].reverse() : entry) {
      grid[i] = useOld ? oldV : newV;
      paintCell(i);
    }
    to.push(entry);
    haptic(8);
    afterChange();
  }
  el.undo.addEventListener('click', () => applyHistory(undoStack, redoStack, true));
  el.redo.addEventListener('click', () => applyHistory(redoStack, undoStack, false));

  el.restart.addEventListener('click', () => {
    if (!confirm('Restart this puzzle? Marks and time will be reset.')) return;
    grid.fill(EMPTY);
    undoStack = [];
    redoStack = [];
    solved = false;
    elapsedBase = 0;
    runningSince = null;
    delete store.completed[puzzleId()];
    el.board.classList.remove('solved');
    grid.forEach((_, i) => paintCell(i));
    resumeTimer();
    renderTimer();
    renderStatus();
    afterChange();
  });

  function newRandom() {
    const s = store.settings;
    if (s.mode === 'random' && !solved && grid.some((v) => v !== EMPTY) &&
        !confirm('Start a new random puzzle? Current progress will be lost.')) return;
    persist();
    pauseTimer();
    s.mode = 'random';
    store.progress[`random-${s.size}`] = freshSlot(randomSeed());
    loadSlot();
  }
  el.newRandom.addEventListener('click', newRandom);

  /* ---------------- Win ---------------- */
  function checkWin() {
    if (solved) return;
    const size = n();
    for (let i = 0; i < grid.length; i++) {
      if ((grid[i] === FILLED) !== (puzzle.solution[(i / size) | 0][i % size] === FILLED)) return;
    }
    // The solution is unique, so matching filled cells means solved.
    solved = true;
    pauseTimer();
    const time = elapsedBase;
    const prevBest = store.best[size];
    const isBest = !prevBest || time < prevBest;
    if (isBest) store.best[size] = time;
    store.completed[puzzleId()] = { time, at: Date.now() };
    grid.forEach((_, i) => paintCell(i));
    el.board.classList.add('solved');
    renderTimer();
    renderStatus();
    haptic([30, 60, 30, 60, 120]);
    celebrate();
    setTimeout(() => showWin(time, isBest, prevBest), 700);
  }

  function showWin(time, isBest, prevBest) {
    drawSolution(el.winImage);
    el.winText.textContent = isBest
      ? `Time ${formatTime(time)} — new best for ${n()}×${n()}!`
      : `Time ${formatTime(time)} · Best ${formatTime(prevBest)}`;
    el.win.hidden = false;
    $('win-next').focus();
  }

  /** Draw the solved picture as pixel art. */
  function drawSolution(canvas) {
    const size = n();
    const ctx = canvas.getContext('2d');
    const px = canvas.width / size;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--fill').trim() || '#000';
    puzzle.solution.forEach((row, r) => row.forEach((v, c) => {
      if (v === FILLED) ctx.fillRect(Math.floor(c * px), Math.floor(r * px), Math.ceil(px), Math.ceil(px));
    }));
  }

  function celebrate() {
    const colors = ['#2f6fed', '#e0453a', '#f5b700', '#2bb673', '#9b59b6'];
    const frag = document.createDocumentFragment();
    for (let k = 0; k < 60; k++) {
      const piece = document.createElement('i');
      piece.style.left = `${Math.random() * 100}%`;
      piece.style.background = colors[k % colors.length];
      piece.style.animationDuration = `${1.6 + Math.random() * 1.6}s`;
      piece.style.animationDelay = `${Math.random() * 0.4}s`;
      piece.style.setProperty('--dx', `${(Math.random() - 0.5) * 160}px`);
      frag.appendChild(piece);
    }
    el.confetti.replaceChildren(frag);
    setTimeout(() => el.confetti.replaceChildren(), 4000);
  }

  $('win-close').addEventListener('click', () => { el.win.hidden = true; });
  $('win-next').addEventListener('click', () => { el.win.hidden = true; newRandom(); });

  /* ---------------- Settings & pickers ---------------- */
  function switchTo(changes) {
    persist();
    pauseTimer();
    Object.assign(store.settings, changes);
    el.win.hidden = true;
    loadSlot();
  }
  $('mode-picker').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b && b.dataset.mode !== store.settings.mode) switchTo({ mode: b.dataset.mode });
  });
  $('size-picker').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b && Number(b.dataset.size) !== store.settings.size) switchTo({ size: Number(b.dataset.size) });
  });
  $('tool-picker').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    store.settings.tool = b.dataset.tool;
    haptic(5);
    updateControls();
    saveStore();
  });
  el.check.addEventListener('change', () => {
    store.settings.check = el.check.checked;
    grid.forEach((_, i) => paintCell(i));
    saveStore();
  });
  el.haptics.addEventListener('change', () => {
    store.settings.haptics = el.haptics.checked;
    haptic(15);
    saveStore();
  });
  // Hide the vibration option where the API doesn't exist (e.g. iOS Safari).
  if (!('vibrate' in navigator)) el.haptics.closest('label').hidden = true;

  function haptic(pattern) {
    if (store.settings.haptics && navigator.vibrate) {
      try { navigator.vibrate(pattern); } catch (e) { /* ignored */ }
    }
  }

  /* ---------------- Lifecycle ---------------- */
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      pauseTimer();
      persist();
    } else {
      // A new day may have started while the app was in the background.
      if (store.settings.mode === 'daily' && slot.seed !== `daily:${localDateKey()}`) loadSlot();
      else resumeTimer();
    }
  });
  window.addEventListener('pagehide', persist);
  window.addEventListener('resize', () => puzzle && layout());

  /* ---------------- Service worker (offline support) ---------------- */
  function showToast(text, onClick) {
    el.toast.textContent = text;
    el.toast.hidden = false;
    el.toast.onclick = onClick || (() => { el.toast.hidden = true; });
  }

  if ('serviceWorker' in navigator) {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      // A new version took over. Progress is saved, so reloading is safe.
      if (hadController) showToast('Update installed — tap to reload', () => location.reload());
    });
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('SW registration failed', err));
    });
  }

  loadSlot();
})();
