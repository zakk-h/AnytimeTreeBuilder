import { readdirSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const frontend = resolve(dirname(fileURLToPath(import.meta.url)), '../InteractiveTreeBuilder');
const modules = join(frontend, 'node_modules');
const notices = [];
function packageNotice(directory) {
  const file = join(directory, 'package.json');
  if (!existsSync(file)) return;
  const pkg = JSON.parse(readFileSync(file, 'utf8'));
  const licenses = readdirSync(directory).filter(name => /^(licen[cs]e|copying|notice)(\.|$)/i.test(name));
  if (licenses.length) notices.push(`${pkg.name} ${pkg.version}\n${licenses.map(name => readFileSync(join(directory, name), 'utf8')).join('\n')}`);
  if (existsSync(join(directory, 'node_modules'))) scan(join(directory, 'node_modules'));
}
function scan(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const path = join(directory, entry.name);
    if (entry.name.startsWith('@')) {
      for (const child of readdirSync(path)) packageNotice(join(path, child));
    } else packageNotice(path);
  }
}
scan(modules);
mkdirSync(join(frontend, 'dist'), { recursive: true });
writeFileSync(join(frontend, 'dist', 'THIRD_PARTY_NOTICES.txt'),
  'Frontend dependency notices (including build tools)\n\n' + notices.sort().join('\n\n' + '='.repeat(72) + '\n\n'));
