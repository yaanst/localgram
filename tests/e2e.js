/*
 * End-to-end check in a mobile viewport using Playwright.
 *
 *   # serve the repo under a sub-folder, like GitHub Pages does:
 *   mkdir -p /tmp/site && ln -s "$PWD" /tmp/site/localgram
 *   python3 -m http.server 8123 --directory /tmp/site
 *   node tests/e2e.js http://localhost:8123/localgram/ [screenshot-dir]
 *
 * Checks: layout, drag lock, undo, service worker registration,
 * solving + win dialog, offline reload.
 */
'use strict';
const assert = require('assert');
const path = require('path');
const { chromium, devices } = require('playwright');
const Core = require('../game.js');

const URL = process.argv[2] || 'http://localhost:8123/localgram/';
const SHOTS = process.argv[3] || null;
const shot = async (page, name) => SHOTS && page.screenshot({ path: path.join(SHOTS, `${name}.png`) });

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ ...devices['Pixel 7'] });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('dialog', (d) => d.accept());

  await page.goto(URL);
  await page.waitForSelector('#cells .cell');

  // 1. Service worker registers and takes control.
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  assert.ok(await page.evaluate(() => !!navigator.serviceWorker.controller), 'page controlled by SW');
  console.log('✓ service worker registered and controlling the page');

  // 2. Default is the 10x10 daily; cells >= 28px and board fits the width.
  const cells = page.locator('#cells .cell');
  const cellBox = await cells.first().boundingBox();
  const boardBox = await page.locator('#board').boundingBox();
  const vw = page.viewportSize().width;
  assert.strictEqual(await cells.count(), 100);
  assert.ok(cellBox.width >= 28, `10x10 cell is ${cellBox.width}px`);
  assert.ok(boardBox.x >= 0 && boardBox.x + boardBox.width <= vw, 'board fits the screen');
  console.log(`✓ 10x10 layout: cell ${cellBox.width.toFixed(1)}px, board ${boardBox.width.toFixed(0)}/${vw}px`);
  await shot(page, '1-daily-10');

  // 3. Drag locks to the starting row: a swipe that drifts down stays in row 0.
  const center = async (i) => { const b = await cells.nth(i).boundingBox(); return [b.x + b.width / 2, b.y + b.height / 2]; };
  const [x0, y0] = await center(0);
  const [x3, y3] = await center(13); // row 1, col 3
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move(x3, y0 + 2, { steps: 4 });
  await page.mouse.move(x3, y3, { steps: 4 });
  await page.mouse.up();
  const filled = await page.$$eval('#cells .cell', (els) => els.map((e, i) => (e.classList.contains('f') ? i : -1)).filter((i) => i >= 0));
  assert.deepStrictEqual(filled, [0, 1, 2, 3], `drag locked to row: ${filled}`);
  console.log('✓ drag paints a locked row segment');

  await page.click('#undo');
  assert.strictEqual(await page.locator('#cells .cell.f').count(), 0);
  console.log('✓ undo reverts the whole stroke');

  // 4. Switch to 5x5 and solve it by tapping the known solution.
  await page.click('#size-picker [data-size="5"]');
  const store = await page.evaluate(() => JSON.parse(localStorage.getItem('localgram:v1')));
  const puzzle = Core.generatePuzzle(5, store.progress['daily-5'].seed);
  const solutionIdx = puzzle.solution.flat().map((v, i) => (v ? i : -1)).filter((i) => i >= 0);
  for (const i of solutionIdx) await cells.nth(i).tap();
  await page.waitForSelector('#win:not([hidden])', { timeout: 3000 });
  assert.match(await page.textContent('#win-text'), /Time/);
  await shot(page, '2-win');
  console.log('✓ solving shows the win dialog');
  await page.click('#win-close');

  // 5. Offline reload still works (served from the SW cache).
  await context.setOffline(true);
  await page.reload();
  await page.waitForSelector('#cells .cell');
  assert.strictEqual(await cells.count(), 25, 'offline reload restores the 5x5 board');
  assert.ok(await page.locator('#board.solved').count(), 'solved state persisted');
  await page.click('#mode-picker [data-mode="random"]');
  await page.click('#size-picker [data-size="15"]');
  assert.strictEqual(await cells.count(), 225);
  await shot(page, '3-offline-random-15');
  console.log('✓ app reloads and generates puzzles offline');

  // 6. Dark mode renders.
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.click('#size-picker [data-size="10"]');
  await shot(page, '4-dark-random-10');

  // 7. Manual theme overrides the system setting, and survives a reload.
  const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const DARK = 'rgb(22, 24, 29)';
  const LIGHT = 'rgb(246, 244, 239)';
  assert.strictEqual(await bg(), DARK, 'Auto follows dark system');
  await page.click('#theme-picker [data-theme="light"]');
  assert.strictEqual(await bg(), LIGHT, 'Light overrides dark system');
  await page.reload();
  await page.waitForSelector('#cells .cell');
  assert.strictEqual(await bg(), LIGHT, 'Light choice persists');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.click('#theme-picker [data-theme="dark"]');
  assert.strictEqual(await bg(), DARK, 'Dark overrides light system');
  await shot(page, '5-theme-dark-override');
  await page.click('#theme-picker [data-theme="system"]');
  assert.strictEqual(await bg(), LIGHT, 'Auto follows light system again');
  console.log('✓ theme picker overrides the system setting and persists');

  assert.deepStrictEqual(errors, [], `no page errors: ${errors}`);
  await browser.close();
  console.log('All e2e checks passed.');
})().catch((e) => { console.error(e); process.exit(1); });
