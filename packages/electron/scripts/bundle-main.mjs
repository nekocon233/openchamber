import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const updaterE2eBuild = process.env.OPENCHAMBER_UPDATER_E2E_BUILD === '1';
const repositoryPart = (name, fallback) => {
  const value = process.env[name]?.trim() || fallback;
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error(`${name} must be a GitHub owner or repository name`);
  }
  return value;
};
const updateOwner = repositoryPart('OPENCHAMBER_UPDATE_OWNER', 'nekocon233');
const updateRepo = repositoryPart('OPENCHAMBER_UPDATE_REPO', 'openchamber');

const result = await Bun.build({
  entrypoints: [
    path.join(root, 'entry.mjs'),
    path.join(root, 'main.mjs'),
    path.join(root, 'early-startup.mjs'),
  ],
  outdir: path.join(root, 'dist-bundle'),
  target: 'node',
  format: 'esm',
  external: [
    'electron',
    '@openchamber/web',
    '@openchamber/web/*',
    'bun-pty',
    'node-pty',
    './main.mjs',
    './early-startup.mjs',
  ],
  minify: false,
  sourcemap: 'none',
  naming: '[name].mjs',
  define: {
    __OPENCHAMBER_UPDATER_E2E_BUILD__: updaterE2eBuild ? 'true' : 'false',
    __OPENCHAMBER_UPDATE_OWNER__: JSON.stringify(updateOwner),
    __OPENCHAMBER_UPDATE_REPO__: JSON.stringify(updateRepo),
  },
});

if (!result.success) {
  for (const msg of result.logs) console.error(msg);
  process.exit(1);
}

console.log(`[electron] main process bundled -> dist-bundle/{entry,main,early-startup}.mjs (updater=${updateOwner}/${updateRepo}, E2E=${updaterE2eBuild})`);
