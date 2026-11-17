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
