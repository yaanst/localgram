/*
 * Generator tests. Run with: node tests/generator.test.js
 *
 * For many seeds and every size we check that:
 *   - generation is deterministic (same seed => same puzzle),
 *   - clues match the solution,
 *   - the line solver alone reproduces the solution,
 *   - an independent brute-force backtracking solver (no line logic) finds
 *     exactly ONE solution, i.e. the puzzle is truly unique.
 */
'use strict';
const assert = require('assert');
const Core = require('../game.js');

/** All ways to place `clue` in a line of length n, as 0/1 arrays. */
function arrangements(clue, n) {
  const out = [];
  const line = new Array(n).fill(0);
  (function place(j, start) {
    if (j === clue.length) { out.push(line.slice()); return; }
    const rest = clue.slice(j + 1).reduce((a, b) => a + b + 1, 0);
    for (let s = start; s + clue[j] + rest <= n; s++) {
      for (let i = s; i < s + clue[j]; i++) line[i] = 1;
      place(j + 1, s + clue[j] + 1);
      for (let i = s; i < s + clue[j]; i++) line[i] = 0;
    }
  })(0, 0);
  return out;
}

/** Could a column prefix (first `len` cells) still be extended to fit `clue`? */
function prefixFits(prefix, clue, n) {
  // Runs completed so far must match the clue's start; an open run must not exceed its block.
  const runs = [];
  let run = 0;
  for (const v of prefix) {
    if (v) run++;
    else if (run) { runs.push(run); run = 0; }
  }
  for (let i = 0; i < runs.length; i++) if (runs[i] !== clue[i]) return false;
  let j = runs.length;
  let remaining = n - prefix.length;
  if (run) {
    if (j >= clue.length || run > clue[j]) return false;
    remaining -= clue[j] - run; // finish this block
    j++;
    if (j < clue.length) remaining -= 1; // gap after it
  }
  const need = clue.slice(j).reduce((a, b) => a + b, 0) + Math.max(0, clue.length - j - 1);
  return need <= remaining;
}

/** Count solutions by row-wise backtracking, stopping at `limit`. */
function countSolutions(rows, cols, limit = 2) {
  const n = rows.length;
  const options = rows.map((clue) => arrangements(clue, n));
  const grid = [];
  let count = 0;
  (function search(r) {
    if (count >= limit) return;
    if (r === n) {
      if (cols.every((clue, c) => Core.runsOf(grid.map((row) => row[c])).join() === clue.join())) count++;
      return;
    }
    for (const opt of options[r]) {
      grid.push(opt);
      if (cols.every((clue, c) => prefixFits(grid.map((row) => row[c]), clue, n))) search(r + 1);
      grid.pop();
      if (count >= limit) return;
    }
  })(0);
  return count;
}

let checked = 0;
const plan = { 5: 200, 10: 60, 15: 20 };
for (const [size, count] of Object.entries(plan)) {
  for (let i = 0; i < count; i++) {
    const seed = i % 2 ? `random-${i}` : `daily:2026-01-${String((i % 28) + 1).padStart(2, '0')}`;
    const p = Core.generatePuzzle(Number(size), seed);
    const again = Core.generatePuzzle(Number(size), seed);
    assert.deepStrictEqual(again.solution, p.solution, 'generation must be deterministic');

    const { rows, cols } = Core.cluesFor(p.solution);
    assert.deepStrictEqual(rows, p.rows);
    assert.deepStrictEqual(cols, p.cols);

    const logic = Core.solveByLogic(p.rows, p.cols);
    assert.ok(logic.solved, `line solver must solve ${size}x${size} seed ${seed}`);
    assert.deepStrictEqual(logic.grid, p.solution, 'line solver result must equal the solution');

    assert.strictEqual(countSolutions(p.rows, p.cols), 1, `unique solution for ${size}x${size} seed ${seed}`);
    checked++;
  }
}

// Line solver sanity checks.
assert.deepStrictEqual(Core.solveLine([-1, -1, -1], [1, 1]), [1, 0, 1]);
assert.deepStrictEqual(Core.solveLine([-1, -1, -1, -1, -1], [3]), [-1, -1, 1, -1, -1].map((v, i) => (i === 2 ? 1 : -1)));
assert.strictEqual(Core.solveLine([1, -1, 1], [2]), null, 'contradiction detected');
// A classic ambiguous puzzle (two diagonals) must NOT be solvable by logic.
assert.ok(!Core.solveByLogic([[1], [1]], [[1], [1]]).solved);

// The brute-force counter itself must see ambiguity.
assert.strictEqual(countSolutions([[1], [1]], [[1], [1]]), 2);

console.log(`OK: ${checked} generated puzzles verified unique and logic-solvable.`);
