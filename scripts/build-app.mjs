#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const platform = { win32: 'windows', darwin: 'macos', linux: 'linux' }[process.platform];
const source = join(root, 'dist', 'desktop', `AnytimeTreeBuilder-${platform}-${process.arch}`);
const app = join(root, 'desktop', 'app');
const staging = join(root, 'desktop', 'native');
const manifest = JSON.parse(readFileSync(join(source, 'build-info.json'), 'utf8'));
if (manifest.platform !== platform || manifest.architecture !== process.arch)
  throw new Error('Build the native engine for this platform before packaging the application.');
const binary = process.platform === 'win32' ? 'AnytimeTreeBuilder.exe' : 'AnytimeTreeBuilder';
const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex');
if (sha(join(source, binary)) !== manifest.executable_sha256) throw new Error('Native engine checksum mismatch. Rebuild it first.');
function run(command, args) {
  const result = spawnSync(command, args, { cwd: app, stdio: 'inherit', shell: process.platform === 'win32' && command === 'npm', env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false', ELECTRON_BUILDER_COMPRESSION_LEVEL: process.env.ELECTRON_BUILDER_COMPRESSION_LEVEL ?? '3' } });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.signal}).`);
}
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
cpSync(source, staging, { recursive: true });
if (process.platform === 'darwin') rmSync(join(staging, 'Open AnytimeTreeBuilder.command'));
cpSync(join(root, 'desktop', 'APPLICATION.txt'), join(staging, 'README.txt'));
run('npm', ['ci']);
run('npm', ['run', 'package', '--', `--${{ win32: 'win', darwin: 'mac', linux: 'linux' }[process.platform]}`, `--${process.arch}`]);
const output = join(root, 'dist', 'apps');
for (const name of readdirSync(output)) {
  if (/\.(exe|dmg|zip|AppImage|deb|tar\.gz)$/.test(name))
    writeFileSync(join(output, name + '.sha256'), `${sha(join(output, name))}  ${name}\n`);
}
console.log(`\nDesktop application packages: ${output}\nThese open their own window and manage the native C++ engine automatically.`);
