import fs from 'fs';
import path from 'path';

const root = process.cwd();
const envPath = path.join(root, '.env');
const templatePath = path.join(root, 'public', 'friscy-golden', 'manifest.template.json');
const outputPath = path.join(root, 'public', 'friscy-golden', 'manifest.json');

const readEnv = () => {
  const env = {};
  if (!fs.existsSync(envPath)) return env;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    if (!line || line.trim().startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    env[key] = value;
  }
  return env;
};

const env = readEnv();
if (!fs.existsSync(templatePath)) {
  console.error('Missing manifest template:', templatePath);
  process.exit(1);
}

const template = JSON.parse(fs.readFileSync(templatePath, 'utf8'));

const injectEnv = (value) => {
  if (typeof value !== 'string') return value;
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, key) => {
    const envVal = env[key];
    if (envVal == null) return '';
    return envVal;
  });
};

const walk = (node) => {
  if (Array.isArray(node)) return node.map(walk);
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = walk(v);
    return out;
  }
  return injectEnv(node);
};

const rendered = walk(template);
fs.writeFileSync(outputPath, JSON.stringify(rendered, null, 2));
console.log('Rendered', outputPath);
