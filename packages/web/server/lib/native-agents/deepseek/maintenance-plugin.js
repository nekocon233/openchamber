// Loaded only into OpenChamber's owned DSH process through --patch. fd 3 is
// an inherited private pipe, never a listener or a browser Remote endpoint.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Socket } from 'node:net';
import { createInterface } from 'node:readline';
import { z } from 'zod';

export const inject = ['sessionPersistence', 'agents', 'workspaceRegistry'];
export async function apply(ctx) {
  const require = createRequire(process.env.OPENCHAMBER_DSH_PACKAGE);
  const { default: Jsonl } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session-persistence-jsonl')).href);
  const channel = new Socket({ fd: 3, readable: true, writable: true });
  const reader = createInterface({ input: channel });
  channel.on('error', () => reader.close());
  ctx.effect(() => () => { reader.close(); channel.destroy(); });
  const send = (value) => channel.write(`${JSON.stringify(value)}\n`);
  if (!(ctx.sessionPersistence instanceof Jsonl)) { send({ type: 'unsupported' }); return; }
  const config = ctx.sessionPersistence.config;
  send({ type: 'ready', root: config.root, compression: config.compression ?? 'zstd' });
  const request = z.object({ type: z.literal('inspect'), id: z.string().uuid() });
  let work = Promise.resolve();
  reader.on('line', (line) => {
    work = work.catch(() => {}).then(async () => {
      const input = request.parse(JSON.parse(line));
      try {
        const items = await ctx.sessionPersistence.list();
        const active = [];
        for (const { header } of items) {
          const activity = await ctx.waterfall('workspace/session-activity', { sessionId: header.id }, () => Promise.resolve([]));
          if (activity.length) active.push(header.id);
        }
        send({ type: 'inspection', id: input.id, active, sessions: items.map(({ header }) => ({ id: header.id, parent: header.parentSession, origin: header.origin })) });
      } catch { send({ type: 'error', id: input.id }); }
    }).catch(() => {});
  });
}
