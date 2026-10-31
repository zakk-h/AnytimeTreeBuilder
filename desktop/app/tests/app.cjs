const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { _electron } = require('playwright-core');
const { exerciseTraining } = require('./training.cjs');

async function main() {
  const profile = mkdtempSync(join(tmpdir(), 'Anytime Tree Builder '));
  let desktop;
  let child;
  let output = '';
  try {
    desktop = await _electron.launch({
      executablePath: resolve(process.argv[2]),
      args: [`--user-data-dir=${profile}`, ...JSON.parse(process.env.ATB_TEST_ARGS || '[]')],
      cwd: profile, timeout: 40_000,
    });
    child = desktop.process();
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    const page = await desktop.firstWindow({ timeout: 30_000 });
    const errors = [];
    const requests = [];
    page.on('pageerror', error => errors.push(String(error)));
    page.on('request', request => requests.push(request.url()));
    await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    const base = new URL(page.url()).origin;
    assert.equal(await page.evaluate(() => typeof require), 'undefined');
    assert.equal(await page.evaluate(() => typeof process), 'undefined');
    const preferences = await desktop.evaluate(({ BrowserWindow }) => {
      const p = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
      return { node: p.nodeIntegration, sandbox: p.sandbox, isolation: p.contextIsolation, security: p.webSecurity };
    });
    assert.deepEqual(preferences, { node: false, sandbox: true, isolation: true, security: true });
    await page.getByRole('button', { name: 'Upload', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Upload dataset' }).click();
    await page.locator('.live-file input').setInputFiles({ name: 'dataset.csv', mimeType: 'text/csv', buffer: Buffer.from('workingday,label\n0,no\n0,no\n1,yes\n1,yes\n') });
    await page.getByLabel('Maximum depth', { exact: true }).fill('2');
    await page.getByRole('button', { name: 'Start ArborEnum', exact: true }).click();
    await page.waitForFunction(() => window.ARBORENUM_CURRENT_BUILDER_PAYLOAD?.graph?.metadata?.session_id);
    await page.waitForFunction(() => !document.querySelector('.native-query-status'));
    await page.getByRole('button', { name: 'Optimal', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.native-query-status'));
    assert.ok(await page.locator('.arborenum-node-leaf').count() > 0);
    const reply = page.waitForResponse(response => response.url().includes('/api/node?'));
    await page.getByRole('button', { name: 'Update options', exact: true }).click();
    assert.equal((await reply).status(), 200);
    assert.equal(await page.evaluate(async () => (await (await fetch('/api/session')).json()).full_graph_exports), 0);
    assert.ok(!requests.some(url => url.includes('/api/snapshot')));
    assert.equal(await page.evaluate(async () => { try { await fetch('https://example.com/'); return true; } catch { return false; } }), false);
    await page.evaluate(() => window.open('https://example.com/'));
    assert.equal((await desktop.windows()).length, 1);
    await exerciseTraining(page);
    if (process.env.ATB_SCREENSHOT) await page.screenshot({ path: process.env.ATB_SCREENSHOT });
    assert.deepEqual(errors, []);
    const closed = desktop.waitForEvent('close', { timeout: 20_000 });
    await desktop.evaluate(({ BrowserWindow }) => { setTimeout(() => BrowserWindow.getAllWindows()[0].close(), 0); });
    await closed;
    let timer;
    const code = await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Desktop process did not exit: ' + output)), 15_000); })]).finally(() => clearTimeout(timer));
    assert.equal(code, 0, output);
    assert.ok(!output.includes('did not stop cooperatively'), output);
    await assert.rejects(fetch(base + '/api/health', { signal: AbortSignal.timeout(1000) }), 'Native engine survived window close');
    console.log('Packaged desktop window, CSV upload, native completion/refresh, renderer isolation, blocked external navigation and window-close cleanup passed');
  } finally {
    if (desktop && child?.exitCode === null) await desktop.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
