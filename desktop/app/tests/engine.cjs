const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { resolve, join } = require('node:path');
const { NativeEngine } = require('../engine.cjs');

async function main() {
  const executable = resolve(process.argv[2]);
  const engine = new NativeEngine(executable);
  try {
    const base = await engine.start();
    assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
    let word = 812;
    const X = [], y = [];
    for (let i = 0; i < 1024; ++i) {
      word ^= word << 13; word ^= word >>> 17; word ^= word << 5;
      const row = Array.from({ length: 20 }, (_, f) => (word >>> f) & 1);
      X.push(row); y.push(row.reduce((a, b) => a + b, 0) % 2);
    }
    const response = await fetch(base + '/api/session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ feature_names: Array.from({ length: 20 }, (_, i) => 'bit' + i), class_names: ['no', 'yes'], X, y, settings: { depth_budget: 8, lambda_reg: .002, rashomon_mult: 2 } }),
    });
    assert.equal(response.status, 202);
    const cookie = response.headers.get('set-cookie').split(';')[0];
    let status;
    const readyDeadline = Date.now() + 20_000;
    do {
      status = await (await fetch(base + '/api/session', { headers: { Cookie: cookie } })).json();
      assert.ok(Date.now() < readyDeadline && status.phase !== 'failed', JSON.stringify(status));
      if (!status.ready) await new Promise(resolve => setTimeout(resolve, 5));
    } while (!status.ready);
    assert.equal(status.phase, 'running', 'Fixture finished before testing active enumeration shutdown');
    await engine.stop();
    assert.equal((await engine.exited).code, 0, engine.logs.join('\n'));
    await assert.rejects(fetch(base + '/api/health', { signal: AbortSignal.timeout(1000) }));
  } finally { await engine.stop(); }

  // Abruptly kill a desktop-like parent: the engine must notice EOF by itself.
  const script = `const {NativeEngine}=require(${JSON.stringify(join(__dirname, '..', 'engine.cjs'))}); new NativeEngine(${JSON.stringify(executable)}).start().then(url=>{console.log('READY '+url);setInterval(()=>{},1000)}).catch(e=>{console.error(e);process.exit(1)});`;
  const parent = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  const base = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Parent fixture startup timed out: ' + logs)), 25_000);
    parent.stdout.on('data', data => {
      logs += data;
      const match = /READY (http:\/\/127\.0\.0\.1:\d+)/.exec(logs);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    });
    parent.stderr.on('data', data => { logs += data; });
    parent.on('error', error => { clearTimeout(timeout); reject(error); });
    parent.on('exit', () => { clearTimeout(timeout); reject(new Error(logs)); });
  }).catch(error => { parent.kill('SIGKILL'); throw error; });
  parent.kill('SIGKILL');
  const deadline = Date.now() + 15_000;
  while (true) {
    try { await fetch(base + '/api/health', { signal: AbortSignal.timeout(500) }); }
    catch { break; }
    assert.ok(Date.now() < deadline, 'Engine kept running after its parent crashed');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  console.log('Managed native startup, live enumeration, cooperative exit and parent-crash cleanup passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
