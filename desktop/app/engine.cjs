const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { createInterface } = require('node:readline');

class NativeEngine extends EventEmitter {
  constructor(executable) {
    super();
    this.executable = executable;
    this.logs = [];
    this.stopping = false;
  }

  async start() {
    this.child = spawn(this.executable, ['--managed', '--no-browser', '--port', '0'], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, RENDER_EXTERNAL_HOSTNAME: '' },
    });
    // Closing this pipe is the cross-platform, cooperative shutdown protocol.
    this.child.stdin.on('error', () => {});
    this.exited = new Promise(resolve => this.child.once('close', (code, signal) => {
      resolve({ code, signal });
      this.emit('exit', { code, signal });
    }));
    const log = line => { this.logs.push(line); if (this.logs.length > 40) this.logs.shift(); };
    const output = createInterface({ input: this.child.stdout });
    const errors = createInterface({ input: this.child.stderr });
    output.on('line', log);
    errors.on('line', log);
    this.url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The native engine did not start within 20 seconds.')), 20_000);
      const finish = value => { clearTimeout(timer); output.off('line', line); resolve(value); };
      const line = text => {
        const match = /^Interactive Tree Builder: (http:\/\/127\.0\.0\.1:\d+)$/.exec(text);
        if (match) finish(match[1]);
      };
      output.on('line', line);
      this.child.once('error', error => { clearTimeout(timer); reject(error); });
      this.exited.then(({ code, signal }) => {
        clearTimeout(timer);
        reject(new Error(`The native engine exited during startup (${code ?? signal}).`));
      });
    });
    // The engine announces its bound socket before entering its HTTP loop.
    const deadline = Date.now() + 15_000;
    while (true) {
      try {
        const response = await fetch(this.url + '/api/health', { signal: AbortSignal.timeout(1000) });
        const health = await response.json();
        if (!response.ok || health.service !== 'arborenum-native-builder' || health.protocol !== 2)
          throw new Error('Unexpected native engine protocol.');
        break;
      } catch (error) {
        if (this.child.exitCode !== null || Date.now() >= deadline) throw error;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    console.log(`AnytimeTreeBuilder engine pid=${this.child.pid}`);
    return this.url;
  }

  stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.stopPromise = (async () => {
      if (!this.child || this.child.exitCode !== null || this.child.signalCode !== null) return;
      this.child.stdin.end();
      let timer;
      const deadline = new Promise(resolve => { timer = setTimeout(() => resolve(false), 12_000); });
      const cooperative = await Promise.race([this.exited.then(() => true), deadline]);
      clearTimeout(timer);
      if (!cooperative) {
        console.error('Native engine did not stop cooperatively; terminating the process.');
        this.child.kill('SIGKILL');
        await this.exited;
      }
    })();
    return this.stopPromise;
  }
}

module.exports = { NativeEngine };
