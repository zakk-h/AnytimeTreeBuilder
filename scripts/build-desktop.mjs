#!/usr/bin/env node
// Build-time tooling only. The packaged application runs the native C++ engine.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, chmodSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const flags = new Set(process.argv.slice(2));
for (const flag of flags) if (!['--ui-ready', '--static', '--engine-only'].includes(flag)) throw new Error(`Unknown option: ${flag}`);
const platform = { win32: 'windows', darwin: 'macos', linux: 'linux' }[process.platform];
if (!platform || !['x64', 'arm64'].includes(process.arch)) throw new Error('Supported builds: Windows, macOS and Linux on x64/arm64.');
const name = `AnytimeTreeBuilder-${platform}-${process.arch}`;
const build = join(root, 'build', `desktop-${platform}-${process.arch}`);
const output = join(root, 'dist', 'desktop');
const packageDir = join(output, name);
const frontend = join(root, 'InteractiveTreeBuilder');
const ui = join(frontend, 'dist', 'index.html');
const executable = process.platform === 'win32' ? 'AnytimeTreeBuilder.exe' : 'AnytimeTreeBuilder';

function run(command, args, cwd = root) {
  console.log(`\n> ${command} ${args.join(' ')}`);
  // npm's Windows launcher is a .cmd file. Only fixed npm commands use a shell;
  // CMake and all paths/other arguments always use direct process arguments.
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' && command === 'npm' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.signal}).`);
}

const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 12)) throw new Error('Builds require Node.js 22.12+; running a downloaded app does not require Node.');
run('cmake', ['--version']);
if (!flags.has('--ui-ready')) {
  run('npm', ['ci'], frontend);
  run('npm', ['run', 'typecheck'], frontend);
  run('npm', ['test'], frontend);
  run('npm', ['run', 'build'], frontend);
}
if (!existsSync(ui)) throw new Error('Build the frontend before using --ui-ready.');
const notices = join(frontend, 'dist', 'THIRD_PARTY_NOTICES.txt');
if (!flags.has('--ui-ready') || !existsSync(notices)) run(process.execPath, [join(root, 'scripts', 'frontend-notices.mjs')]);
const jobs = process.env.BUILD_JOBS ?? '2';
if (!/^\d+$/.test(jobs) || Number(jobs) < 1 || Number(jobs) > 64) throw new Error('BUILD_JOBS must be an integer from 1 to 64.');
const configure = ['-S', join(root, 'ArborEnum', 'native'), '-B', build,
  '-DCMAKE_BUILD_TYPE=Release', '-DBUILD_TESTING=ON', '-DARBORENUM_DESKTOP=ON',
  `-DARBORENUM_EMBED_UI=${ui}`, `-DARBORENUM_STATIC_RUNTIME=${flags.has('--static') ? 'ON' : 'OFF'}`];
if (process.platform === 'darwin') configure.push('-DCMAKE_OSX_DEPLOYMENT_TARGET=13.0');
run('cmake', configure);
run('cmake', ['--build', build, '--config', 'Release', '--parallel', jobs]);
run('ctest', ['--test-dir', build, '-C', 'Release', '--output-on-failure']);

// Replace only this platform's generated package, never the source or other OS builds.
rmSync(packageDir, { recursive: true, force: true });
mkdirSync(packageDir, { recursive: true });
run('cmake', ['--install', build, '--config', 'Release', '--prefix', packageDir]);
if (process.platform !== 'win32') chmodSync(join(packageDir, executable), 0o755);
if (process.platform === 'darwin') {
  writeFileSync(join(packageDir, 'Open AnytimeTreeBuilder.command'), '#!/bin/sh\ncd -- "$(dirname -- "$0")" || exit 1\nexec ./AnytimeTreeBuilder\n', { mode: 0o755 });
  // Ad-hoc signing is sufficient for local executable integrity. This is not
  // Developer ID signing/notarization and the package does not claim otherwise.
  run('/usr/bin/codesign', ['--force', '--sign', '-', join(packageDir, executable)]);
}
copyFileSync(join(root, 'desktop', 'README.txt'), join(packageDir, 'README.txt'));
copyFileSync(join(root, 'ArborEnum', 'examples', 'bike_processed.csv'), join(packageDir, 'example.csv'));
copyFileSync(join(root, 'PROVENANCE.md'), join(packageDir, 'PROVENANCE.md'));
const licenses = join(packageDir, 'licenses');
mkdirSync(licenses, { recursive: true });
for (const file of ['httplib.LICENSE', 'json.LICENSE']) copyFileSync(join(root, 'ArborEnum', 'native', 'vendor', file), join(licenses, file));
copyFileSync(notices, join(licenses, 'THIRD_PARTY_NOTICES.txt'));
copyFileSync(join(frontend, 'package-lock.json'), join(licenses, 'frontend-package-lock.json'));
const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root, encoding: 'utf8' });
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
writeFileSync(join(packageDir, 'build-info.json'), JSON.stringify({
  platform, architecture: process.arch, revision: revision.status === 0 ? revision.stdout.trim() : 'unknown',
  source_dirty: status.status === 0 ? Boolean(status.stdout.trim()) : null,
  built_at: new Date().toISOString(), static_runtime: flags.has('--static'),
  executable_sha256: hash(join(packageDir, executable)), embedded_ui_sha256: hash(ui),
}, null, 2) + '\n');
const archive = join(output, `${name}.zip`);
run('cmake', ['-E', 'tar', 'cf', archive, '--format=zip', name], output);
writeFileSync(`${archive}.sha256`, `${hash(archive)}  ${name}.zip\n`);
console.log(`\nPortable app: ${packageDir}\nDownloadable ZIP: ${archive}\nRunning it requires no Node.js, Python, compiler or separate HTML file.`);
if (!flags.has('--engine-only')) run(process.execPath, [join(root, 'scripts', 'build-app.mjs')]);
