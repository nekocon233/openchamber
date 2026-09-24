import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { createCodexAppServer } from './app-server.js';
import { createJsonRpcConnection, JsonRpcError } from './rpc.js';

// A stand-in for `codex app-server`: it reads JSON-RPC lines from stdin and
// answers through `respond`, which tests script per method.
const createFakeChild = (respond) => {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 4242;
  child.exitCode = null;
  child.signalCode = null;
  child.received = [];
  let buffer = '';
  child.stdin.setEncoding('utf8');
  child.stdin.on('data', (text) => {
    buffer += text;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      child.received.push(message);
      respond(message, child);
    }
  });
  child.send = (message) => child.stdout.write(`${JSON.stringify(message)}\n`);
  child.exit = (code = 0) => {
    child.exitCode = code;
    child.stdout.end();
    child.emit('exit', code, null);
  };
  return child;
};

const handshake = (message, child) => {
  if (message.method === 'initialize') child.send({ id: message.id, result: { userAgent: 'fake' } });
};

describe('Codex JSON-RPC connection', () => {
  it('correlates responses, forwards notifications and answers server requests', async () => {
    const notifications = [];
    const child = createFakeChild((message, fake) => {
      if (message.method === 'thread/read') fake.send({ id: message.id, result: { thread: { id: 't' } } });
      if (message.method === 'thread/delete') fake.send({ id: message.id, error: { code: -32600, message: 'nope' } });
    });
    const connection = createJsonRpcConnection({
      child,
      onNotification: (method, params) => notifications.push({ method, params }),
      onRequest: async (method) => {
        if (method === 'item/tool/requestUserInput') return { answers: {} };
        throw new Error('declined');
      },
      onClose: () => {},
    });

    await expect(connection.request('thread/read', { threadId: 't' })).resolves.toEqual({ thread: { id: 't' } });
    await expect(connection.request('thread/delete', {})).rejects.toMatchObject({ code: -32600, message: 'nope' });

    child.send({ method: 'turn/started', params: { threadId: 't' } });
    child.send({ id: 'server-1', method: 'item/tool/requestUserInput', params: {} });
    child.send({ id: 'server-2', method: 'item/unknown', params: {} });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(notifications).toEqual([{ method: 'turn/started', params: { threadId: 't' } }]);
    expect(child.received).toContainEqual({ id: 'server-1', result: { answers: {} } });
    expect(child.received).toContainEqual({ id: 'server-2', error: { code: -32000, message: 'declined' } });
  });

  it('rejects pending requests when the stream ends', async () => {
    const child = createFakeChild(() => {});
    let closedWith = null;
    const connection = createJsonRpcConnection({ child, onNotification() {}, onRequest: async () => ({}), onClose: (error) => { closedWith = error; } });
    const pending = connection.request('thread/list');
    child.stdout.end();
    await expect(pending).rejects.toBeInstanceOf(JsonRpcError);
    expect(closedWith).toBeInstanceOf(JsonRpcError);
    expect(connection.isClosed()).toBe(true);
  });
});

describe('Codex app-server lifecycle', () => {
  const createServer = ({ executable = '/usr/bin/codex', children = [], onExit = () => {}, clock = { now: 0 } } = {}) => {
    const terminated = [];
    const server = createCodexAppServer({
      resolveExecutable: async () => executable,
      buildEnv: () => ({ PATH: '/usr/bin' }),
      onNotification: () => {},
      onServerRequest: async () => ({}),
      onExit,
      clientVersion: '1.0.0',
      now: () => clock.now,
      spawnProcess: (command, args) => {
        const child = createFakeChild((message, fake) => {
          handshake(message, fake);
          if (message.method === 'thread/list') fake.send({ id: message.id, result: { data: [] } });
        });
        child.command = command;
        child.args = args;
        children.push(child);
        return child;
      },
      terminateProcess: async (child) => {
        terminated.push(child);
        child.exit(0);
      },
    });
    return { server, children, terminated };
  };

  it('starts on first use with the handshake OpenChamber identifies itself by', async () => {
    const { server, children } = createServer();
    expect(server.isRunning()).toBe(false);
    await expect(server.request('thread/list')).resolves.toEqual({ data: [] });
    expect(children).toHaveLength(1);
    expect(children[0].args).toEqual(['app-server', '--listen', 'stdio://']);
    expect(children[0].received[0]).toMatchObject({
      method: 'initialize',
      params: { clientInfo: { name: 'openchamber', version: '1.0.0' }, capabilities: { experimentalApi: true } },
    });
    expect(children[0].received[1]).toEqual({ method: 'initialized' });
    await server.request('thread/list');
    expect(children).toHaveLength(1);
  });

  it('reports a missing CLI with a stable error code', async () => {
    const { server } = createServer({ executable: null });
    await expect(server.request('thread/list')).rejects.toMatchObject({ code: 'NATIVE_CLI_MISSING', status: 503 });
  });

  it('tells the runtime when the process exits and starts a new one on the next request', async () => {
    const exits = [];
    const clock = { now: 0 };
    const { server, children } = createServer({ onExit: (error) => exits.push(error.message), clock });
    await server.request('thread/list');
    children[0].exit(1);
    expect(exits).toHaveLength(1);
    expect(server.isRunning()).toBe(false);
    clock.now = 60_000;
    await server.request('thread/list');
    expect(children).toHaveLength(2);
  });

  it('stops the running process', async () => {
    const { server, children, terminated } = createServer();
    await server.request('thread/list');
    await server.stop();
    expect(terminated).toEqual([children[0]]);
    await expect(server.request('thread/list')).rejects.toThrow('stopped');
  });
});
