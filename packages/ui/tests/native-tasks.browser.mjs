// Run with: bun packages/ui/tests/native-tasks.browser.mjs
// Renders the production task controls with an isolated native API, never a user session.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CdpClient, createPageTarget, evaluateValue, launchChrome, reservePort, resolveChrome, wait,
} from '../../../scripts/perf/cdp.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const fixture = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { I18nProvider, useI18nStore } from '@/lib/i18n';
import { CSSVariableGenerator } from '@/lib/theme/cssGenerator';
import { getDefaultTheme } from '@/lib/theme/themes';
import { createTestNativeAgentsAPI, createTestRuntimeAPIs } from '@/lib/native-agents/test-utils/runtime';
import { NativeTasksPane } from '@/components/chat/native-tasks/NativeTasksPane';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';

const params = new URLSearchParams(location.search);
const mobile = params.get('mobile') === 'true';
const stress = params.get('stress') === 'true';
useUIStore.setState({ isMobile: mobile });
useSessionUIStore.setState({ currentSessionId: 'ncl_11111111-1111-4111-8111-111111111111', currentSessionDirectory: '/fixture/project' });
const taskCount = stress ? 100 : 20;
const todoCount = stress ? 1000 : 100;
const stopped = new Set();
let revision = 1;
let outputReads = 0;
let stopRequests = 0;
const api = createTestNativeAgentsAPI({
  capabilities: async () => ({
    supported: true,
    backends: { claude: { cli: true, tasks: { checklist: true, background: true, output: true, stop: true } }, codex: { cli: false } },
    registry: { reset: false },
  }),
  checklist: async () => ({
    state: 'ready', identity: 'fixture-checklist', source: 'files', revision: 1,
    observedAt: 1000, complete: false, unreadable: 1,
    items: Array.from({ length: todoCount }, (_, index) => ({
      id: String(index + 1), subject: 'Checklist item ' + (index + 1),
      status: index === 0 ? 'in_progress' : index % 3 === 0 ? 'completed' : 'pending',
      description: 'Native checklist details ' + (index + 1), owner: 'fixture-worker',
      blocks: [], blockedBy: index === 1 ? ['1'] : [],
    })),
  }),
  sessionTasks: async () => ({
    state: 'active', generation: 'fixture-query', revision, omitted: 0,
    tasks: Array.from({ length: taskCount }, (_, index) => {
      const id = 'task-' + (index + 1);
      const ended = stopped.has(id);
      return {
        id, type: index === 1 ? 'local_agent' : 'local_bash', description: 'Background job ' + (index + 1),
        active: !ended, ambient: index === taskCount - 1, status: ended ? 'stopped' : 'running',
        canStop: !ended, outputAvailable: index === 0, summary: 'Task progress from the CLI',
        usage: { totalTokens: 200, toolUses: 3, durationMs: 4200 },
      };
    }),
  }),
  taskOutput: async () => {
    outputReads += 1;
    return { state: 'ready', text: 'Fixture output: all focused tests passed.\\n', truncated: true };
  },
  stopTask: async (_session, taskId) => { stopRequests += 1; stopped.add(taskId); revision += 1; },
});
const apis = createTestRuntimeAPIs(api, { sidebarState: {
  supported: false, load: async () => null, mutate: async () => null,
} });
Object.defineProperty(apis, 'settings', { value: {
  load: async () => ({ settings: {} }),
  save: async changes => changes,
} });
registerRuntimeAPIs(apis);
useI18nStore.getState().setLocale('en');
const theme = new CSSVariableGenerator().generate(getDefaultTheme(false));
const style = document.createElement('style');
style.textContent = ':root {' + theme + '}';
document.head.append(style);
window.fixtureStats = () => ({ outputReads, stopRequests, taskCount, todoCount });
function App() {
  const [open, setOpen] = React.useState(true);
  window.closeTasksView = () => setOpen(false);
  return <RuntimeAPIContext.Provider value={apis}><I18nProvider>
    <main className="min-h-screen bg-background text-foreground">
      {open ? <div className={mobile ? 'p-3' : 'mx-auto max-w-3xl p-6'}><NativeTasksPane onClose={() => setOpen(false)} /></div> : null}
    </main>
  </I18nProvider></RuntimeAPIContext.Provider>;
}
createRoot(document.getElementById('root')).render(<App />);
`;

const build = await Bun.build({
  entrypoints: ['native-task-fixture'], target: 'browser', minify: true,
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{"PROD":true,"DEV":false,"BASE_URL":"/"}' },
  plugins: [{
    name: 'native-task-fixture',
    setup(builder) {
      builder.onResolve({ filter: /^native-task-fixture$/ }, () => ({ path: 'entry', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: fixture, loader: 'tsx', resolveDir: repo }));
      builder.onResolve({ filter: /^@\// }, ({ path }) => ({ path: Bun.resolveSync(join(repo, 'packages/ui/src', path.slice(2)), repo) }));
      builder.onResolve({ filter: /^@openchamber\/ui\// }, ({ path }) => ({ path: Bun.resolveSync(join(repo, 'packages/ui/src', path.slice('@openchamber/ui/'.length)), repo) }));
    },
  }],
});
assert.ok(build.success, build.logs.join('\n'));
const javascript = await build.outputs[0].text();
const assets = join(repo, 'packages/web/dist/assets');
const css = readdirSync(assets).filter((name) => /^(index|main)-.*\.css$/.test(name))
  .map((name) => readFileSync(join(assets, name), 'utf8')).join('\n');
const artifactDir = mkdtempSync(join(tmpdir(), 'openchamber-native-tasks-'));
const profileDir = join(artifactDir, 'chrome-profile');
const server = Bun.serve({
  hostname: '127.0.0.1', port: 0,
  fetch(request) {
    const pathname = new URL(request.url).pathname;
    if (pathname === '/app.js') return new Response(javascript, { headers: { 'Content-Type': 'application/javascript' } });
    if (pathname === '/fixture.css') return new Response(css, { headers: { 'Content-Type': 'text/css' } });
    if (pathname.startsWith('/assets/') && !pathname.includes('..')) {
      return new Response(Bun.file(join(repo, 'packages/web/dist', pathname)));
    }
    return new Response('<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script type="module" src="/app.js"></script>', {
      headers: { 'Content-Type': 'text/html' },
    });
  },
});
const port = await reservePort();
const chrome = launchChrome({ chrome: resolveChrome(), port, profileDir, headless: true });
let client;
const exceptions = [];
const waitFor = async (expression) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await evaluateValue(client, expression)) return;
    await wait(50);
  }
  throw new Error(`Browser condition did not become true: ${expression}; exceptions: ${JSON.stringify(exceptions)}`);
};
const clickButton = async (label) => {
  const selector = `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(label)} || b.getAttribute('aria-label') === ${JSON.stringify(label)})`;
  await waitFor(`Boolean(${selector})`);
  await evaluateValue(client, `${selector}.click()`);
};
try {
  const target = await createPageTarget(port);
  client = new CdpClient(target.webSocketDebuggerUrl);
  await client.connect();
  await client.send('Runtime.enable');
  await client.send('Page.enable');
  client.on('Runtime.exceptionThrown', (event) => exceptions.push(event.exceptionDetails));
  for (const scenario of [{ mobile: false, stress: false }, { mobile: true, stress: false }, { mobile: false, stress: true }]) {
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: scenario.mobile ? 390 : 1280, height: scenario.mobile ? 844 : 900, deviceScaleFactor: 1, mobile: scenario.mobile,
    });
    const loaded = client.once('Page.loadEventFired');
    await client.send('Page.navigate', { url: `http://127.0.0.1:${server.port}/?mobile=${scenario.mobile}&stress=${scenario.stress}` });
    await loaded;
    await waitFor('typeof window.fixtureStats === "function"');
    await evaluateValue(client, 'window.fixtureStarted = performance.now()');
    await waitFor('document.body.textContent.includes("Checklist item 1")');
    const listOpenMs = await evaluateValue(client, 'performance.now() - window.fixtureStarted');
    const checklistRows = await evaluateValue(client, 'document.querySelectorAll("[data-native-checklist-id]").length');
    assert.equal(checklistRows, scenario.stress ? 1000 : 100, 'All checklist entries are reachable');
    assert.equal((await evaluateValue(client, 'window.fixtureStats()')).outputReads, 0, 'Opening a task list must not read output files');
    const screenshot = await client.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(artifactDir, `${scenario.mobile ? 'mobile' : 'desktop'}${scenario.stress ? '-stress' : ''}.png`), Buffer.from(screenshot.data, 'base64'));
    await clickButton('Background tasks');
    await waitFor('document.body.textContent.includes("Background job 1")');
    await evaluateValue(client, `[...document.querySelectorAll('button')].find(b => b.textContent.includes('Background job 1')).click()`);
    await waitFor('document.body.textContent.includes("Fixture output:")');
    assert.equal((await evaluateValue(client, 'window.fixtureStats()')).outputReads, 1, 'Only the expanded task reads output');
    await clickButton('Stop this task');
    await waitFor('window.fixtureStats().stopRequests === 1');
    const backgroundScreenshot = await client.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(artifactDir, `${scenario.mobile ? 'mobile' : 'desktop'}${scenario.stress ? '-stress' : ''}-background.png`), Buffer.from(backgroundScreenshot.data, 'base64'));
    await clickButton('Refresh');
    await waitFor('document.querySelector("[data-native-task-id=task-1]")?.textContent.includes("Stopped")');
    assert.ok(await evaluateValue(client, 'document.querySelector("[data-native-task-id=task-2]")?.textContent.includes("Running")'), 'Stopping one task leaves other tasks running');
    assert.equal((await evaluateValue(client, 'window.fixtureStats()')).stopRequests, 1, 'Confirmation does not resubmit stop');
    const frames = await evaluateValue(client, `(async () => {
      const started = performance.now();
      for (let i = 0; i < 10; i++) await new Promise(requestAnimationFrame);
      return { count: 10, elapsed: performance.now() - started };
    })()`);
    assert.ok(frames.elapsed < 2000, 'The browser remains frame-live');
    const readsBeforeClose = (await evaluateValue(client, 'window.fixtureStats()')).outputReads;
    await evaluateValue(client, 'window.closeTasksView()');
    await waitFor('!document.querySelector("[data-native-tasks-body]")');
    await wait(100);
    assert.equal((await evaluateValue(client, 'window.fixtureStats()')).outputReads, readsBeforeClose, 'Closing the view stops output work');
    assert.deepEqual(exceptions, [], 'No browser runtime exceptions');
    console.log(JSON.stringify({ ...scenario, listOpenMs, frames, ...await evaluateValue(client, 'window.fixtureStats()') }));
  }
  console.log(`Screenshots: ${artifactDir}`);
} finally {
  client?.socket.close();
  if (chrome.exitCode === null && chrome.signalCode === null) {
    const exited = new Promise((resolve) => chrome.once('exit', resolve));
    chrome.kill();
    await exited;
  }
  server.stop(true);
  rmSync(profileDir, { recursive: true, force: true });
}
