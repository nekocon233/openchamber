import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolveTargetArchitecture } from './target-architecture.mjs';

// OpenCode is a separate executable and cannot import modules inside app.asar.
// Bundle the plugin and model adapters together, including their JS dependencies.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = path.resolve(root, '../web');
const source = path.join(web, 'server/lib/claude-execution');
const resources = path.join(root, 'resources');
await fs.mkdir(resources, { recursive: true });
const staging = await fs.mkdtemp(path.join(resources, 'claude-execution-staging-'));
try {
  const result = await Bun.build({
    entrypoints: ['plugin.js', 'provider-plugin.js', 'openai-provider.js', 'anthropic-provider.js', 'compatible-provider.js'].map((name) => path.join(source, name)),
    outdir: staging,
    target: 'bun', format: 'esm', splitting: true,
    naming: { entry: '[name].js', chunk: 'chunk-[hash].js', asset: '[name].[ext]' },
  });
  if (!result.success) throw new AggregateError(result.logs, 'Could not bundle Claude execution');
  const require = createRequire(path.join(web, 'package.json'));
  const sdkPath = require.resolve('@anthropic-ai/claude-agent-sdk');
  const sdkRequire = createRequire(sdkPath);
  const sdkRoot = path.dirname(sdkPath);
  const architecture = resolveTargetArchitecture().node;
  const nativePackage = `@anthropic-ai/claude-agent-sdk-${process.platform}-${architecture}`;
  const nativeRoot = path.dirname(sdkRequire.resolve(`${nativePackage}/package.json`));
  await fs.cp(nativeRoot, path.join(staging, 'node_modules', nativePackage), { recursive: true, dereference: true });
  for (const filename of ['manifest.json', 'manifest.zst.json']) await fs.copyFile(path.join(sdkRoot, filename), path.join(staging, filename));
  await fs.writeFile(path.join(staging, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  const destination = path.join(resources, 'claude-execution');
  await fs.rm(destination, { recursive: true, force: true });
  await fs.rename(staging, destination);
  console.log('[electron] Claude execution plugin and native runtime staged');
} catch (error) {
  await fs.rm(staging, { recursive: true, force: true });
  throw error;
}
