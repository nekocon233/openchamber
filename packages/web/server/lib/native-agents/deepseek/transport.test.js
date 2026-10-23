import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import WebSocket from 'ws';
import { spawnCliProcess } from '../process.js';
import { createDeepseekTransport } from './transport.js';
import { accepted, modelCatalog, sessionCreated } from './protocol.js';
import { createDeepseekConfiguration } from './configuration.js';

const transports = [];
afterEach(async () => { for (const transport of transports.splice(0)) await transport.shutdown(); });
const setup = (overrides = {}) => {
  let starts = 0;
  const children = [];
  const transport = createDeepseekTransport({
    resolveExecutable: async () => process.execPath,
    buildEnv: () => ({ ...process.env, DSH_TEST_DIRECTORY: '/workspace' }),
    enterpriseMode: () => false,
    spawnProcess: (executable, args, options) => {
      starts += 1;
      const child = spawnCliProcess(executable, [fileURLToPath(new URL('./fixtures/server.mjs', import.meta.url)), ...args], options);
      children.push(child);
      return child;
    },
    ...overrides,
  });
  transports.push(transport);
  return { transport, starts: () => starts, children };
};

const socketProbe = () => {
  const sockets = [];
  class ObservedWebSocket extends WebSocket {
    constructor(...args) { super(...args); sockets.push(this); }
  }
  return { sockets, WebSocketClass: ObservedWebSocket };
};

describe('DeepSeek process and protocol boundary', () => {
  it('gates remote configuration reads and writes before spawn and on policy changes', async () => {
    let blocked = true;
    const { transport, starts } = setup({ enterpriseMode: () => blocked });
    const configuration = createDeepseekConfiguration({ transport });
    const input = { revision: 0, baseURL: null, modelIDs: ['test-model'], apiKey: 'fixture-api-key' };
    await expect(configuration.read()).rejects.toMatchObject({ status: 403, code: 'enterprise_mode' });
    await expect(configuration.save(input)).rejects.toMatchObject({ status: 403, code: 'enterprise_mode' });
    expect(starts()).toBe(0);
    blocked = false;
    expect(await configuration.save(input)).toMatchObject({ status: 'saved' });
    blocked = true;
    await expect(configuration.read()).rejects.toMatchObject({ status: 403, code: 'enterprise_mode' });
    expect(starts()).toBe(1);
  });

  it('refuses enterprise mode and a missing CLI before spawning', async () => {
    const blocked = setup({ enterpriseMode: () => true });
    await expect(blocked.transport.request('session/modelCatalog', {}, modelCatalog)).rejects.toMatchObject({ status: 403, code: 'enterprise_mode' });
    expect(blocked.starts()).toBe(0);
    const missing = setup({ resolveExecutable: async () => null });
    await expect(missing.transport.request('session/modelCatalog', {}, modelCatalog)).rejects.toMatchObject({ status: 503, code: 'NATIVE_CLI_MISSING' });
    expect(missing.starts()).toBe(0);
  });

  it('starts once for concurrent reads and rejects malformed results as backend errors', async () => {
    const { transport, starts } = setup();
    await Promise.all([transport.request('session/modelCatalog', {}, modelCatalog), transport.request('session/modelCatalog', {}, modelCatalog)]);
    expect(starts()).toBe(1);
    await expect(transport.request('fixture/invalid', {}, modelCatalog)).rejects.toMatchObject({ status: 502, code: 'NATIVE_DEEPSEEK_PROTOCOL' });
    await expect(transport.request('fixture/held', {}, z.json())).rejects.toMatchObject({ status: 409, code: 'NATIVE_DEEPSEEK_WRITER_HELD' });
  });

  it('restarts only on the next request after process exit', async () => {
    let disconnected;
    const exited = new Promise((resolve) => { disconnected = resolve; });
    const { transport, starts, children } = setup({ onDisconnect: disconnected });
    await transport.request('fixture/exit', {}, z.boolean());
    await exited;
    await expect.poll(() => children[0].exitCode).toBe(0);
    expect(starts()).toBe(1);
    expect((await transport.request('session/modelCatalog', {}, modelCatalog)).groups).toHaveLength(1);
    expect(starts()).toBe(2);
  });

  it('replaces a silently closed socket once for concurrent callers and ignores its late close', async () => {
    const probe = socketProbe();
    let disconnects = 0;
    const { transport, starts } = setup({ ...probe, onDisconnect: () => { disconnects += 1; } });
    await transport.request('session/modelCatalog', {}, modelCatalog);
    const old = probe.sockets[0];
    const lateClose = old.listeners('close');
    old.removeAllListeners('close');
    old.terminate();
    await expect.poll(() => old.readyState).toBe(WebSocket.CLOSED);

    await Promise.all(Array.from({ length: 8 }, () => transport.request('session/modelCatalog', {}, modelCatalog)));
    expect(probe.sockets).toHaveLength(2);
    expect(disconnects).toBe(1);
    expect(starts()).toBe(1);
    for (const close of lateClose) close(1006, Buffer.alloc(0));
    expect((await transport.request('session/modelCatalog', {}, modelCatalog)).groups).toHaveLength(1);
    expect(probe.sockets[1].readyState).toBe(WebSocket.OPEN);
    expect(starts()).toBe(1);
  });

  it('retires an ended event stream before reusing its still-open socket', async () => {
    const probe = socketProbe();
    let disconnects = 0;
    const { transport, starts } = setup({ ...probe, onDisconnect: () => { disconnects += 1; } });
    await transport.request('fixture/end-events', {}, z.boolean());
    await expect.poll(() => disconnects).toBe(1);
    expect((await transport.request('session/modelCatalog', {}, modelCatalog)).groups).toHaveLength(1);
    expect(probe.sockets).toHaveLength(2);
    expect(starts()).toBe(1);
  });

  it('reconnects after a missing first frame without interrupting or replaying a pending prompt', async () => {
    const probe = socketProbe();
    const { transport, starts } = setup({ ...probe, requestTimeoutMs: 150 });
    const session = await transport.request('session/create', { request: { cwd: '/workspace' } }, sessionCreated);
    await transport.request('fixture/connection-options', { delayPromptResponse: 500 }, z.boolean());
    const prompt = transport.request('session/prompt', { request: {
      sessionId: session.sessionId, requestId: 'reconnect-prompt', mode: 'queue', content: [{ type: 'text', text: 'Pending prompt' }],
    } }, accepted);
    const live = await transport.open('workspace/follow', {}, () => {});
    await live.first;
    const stalled = await transport.open('fixture/no-first', {}, () => {});
    const concurrent = await transport.open('fixture/no-first', {}, () => {});
    await Promise.all([stalled, concurrent].map((handle) => expect(handle.first).rejects.toMatchObject({ code: 'NATIVE_DEEPSEEK_UNAVAILABLE' })));
    await expect(live.done).rejects.toMatchObject({ code: 'NATIVE_DEEPSEEK_UNAVAILABLE' });
    await expect.poll(() => probe.sockets.length).toBe(2);
    const recovered = await transport.open('workspace/follow', {}, () => {});
    await expect(recovered.first).resolves.toMatchObject({ type: 'baseline' });
    await expect(prompt).resolves.toEqual({ accepted: true });
    const page = await transport.request('session/page', { request: { address: { sessionId: session.sessionId }, throughSeq: 1000, maxMessages: 100 } }, z.object({ records: z.array(z.object({ event: z.object({ type: z.string() }) })) }));
    expect(page.records.filter((record) => record.event.type === 'user/message')).toHaveLength(1);
    expect(starts()).toBe(1);
    recovered.cancel();
  });

  it('bounds recovery to one connection attempt when the ready frame is also missing', async () => {
    const probe = socketProbe();
    const { transport, starts } = setup({ ...probe, requestTimeoutMs: 100 });
    await transport.request('fixture/connection-options', { suppressReady: true }, z.boolean());
    const stalled = await transport.open('fixture/no-first', {}, () => {});
    await expect(stalled.first).rejects.toMatchObject({ code: 'NATIVE_DEEPSEEK_UNAVAILABLE' });
    await expect.poll(() => probe.sockets[1]?.readyState).toBe(WebSocket.CLOSED);
    expect(probe.sockets).toHaveLength(2);
    await expect(Promise.all(Array.from({ length: 8 }, () => transport.request('session/modelCatalog', {}, modelCatalog))))
      .rejects.toMatchObject({ code: 'NATIVE_DEEPSEEK_UNAVAILABLE' });
    expect(probe.sockets).toHaveLength(3);
    expect(starts()).toBe(1);
  });

  it('bounds a recovery handshake that never opens', async () => {
    const probe = socketProbe();
    const { transport, starts } = setup({ ...probe, requestTimeoutMs: 100 });
    await transport.request('fixture/connection-options', { suppressUpgrade: true }, z.boolean());
    const stalled = await transport.open('fixture/no-first', {}, () => {});
    await expect(stalled.first).rejects.toMatchObject({ code: 'NATIVE_DEEPSEEK_UNAVAILABLE' });
    await expect.poll(() => probe.sockets[1]?.readyState).toBe(WebSocket.CLOSED);
    expect(probe.sockets).toHaveLength(2);
    expect(starts()).toBe(1);
  });

  it('does not revive a connection when shutdown races first-frame recovery', async () => {
    const probe = socketProbe();
    let releaseDisconnect;
    const held = new Promise((resolve) => { releaseDisconnect = resolve; });
    const { transport } = setup({ ...probe, requestTimeoutMs: 100, onDisconnect: () => held });
    await transport.request('session/modelCatalog', {}, modelCatalog);
    const stalled = await transport.open('fixture/no-first', {}, () => {});
    await expect(stalled.first).rejects.toMatchObject({ code: 'NATIVE_DEEPSEEK_UNAVAILABLE' });
    const shutdown = transport.shutdown();
    releaseDisconnect();
    await shutdown;
    expect(probe.sockets).toHaveLength(1);
    await expect(transport.request('session/modelCatalog', {}, modelCatalog)).rejects.toMatchObject({ code: 'NATIVE_DEEPSEEK_UNAVAILABLE' });
  });

  it('ends its owned process when enterprise policy changes before another request', async () => {
    let blocked = false;
    let disconnected;
    const exited = new Promise((resolve) => { disconnected = resolve; });
    const { transport } = setup({ enterpriseMode: () => blocked, onDisconnect: disconnected });
    await transport.request('session/modelCatalog', {}, modelCatalog);
    blocked = true;
    await expect(transport.request('session/modelCatalog', {}, modelCatalog)).rejects.toMatchObject({ code: 'enterprise_mode' });
    await exited;
  });
});
