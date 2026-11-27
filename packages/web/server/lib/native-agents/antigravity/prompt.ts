import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { invalidRequestError, NativeAgentError } from '../errors.js';
import { antigravityImageReference, antigravityPromptText, type PromptFilePart, type PromptPart } from '../prompt-parts.js';
import type { RegistrySendRecordInput } from '../registry.js';

const IMAGE_EXTENSIONS = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/gif', 'gif'],
  ['image/webp', 'webp'],
]);

export function planAntigravityPrompt(parts: readonly PromptPart[]) {
  const images = new Map<PromptFilePart, { filename: string; bytes: Buffer }>();
  const fingerprintText = antigravityPromptText(parts, (part, data) => {
    const extension = IMAGE_EXTENSIONS.get(data.mime);
    if (!extension) throw invalidRequestError(`Unsupported Antigravity image type: ${data.mime}`);
    const bytes = Buffer.from(data.base64, 'base64');
    if (!bytes.length || bytes.toString('base64').replace(/=+$/, '') !== data.base64.replace(/=+$/, '')) {
      throw invalidRequestError('An Antigravity image attachment is malformed');
    }
    const basename = part.filename?.split(/[\\/]/).at(-1) ?? 'image';
    const stem = path.parse(basename).name.replace(/[^\p{L}\p{N}_. -]/gu, '_').slice(0, 60).trim() || 'image';
    const filename = `${images.size}-${stem}.${extension}`;
    images.set(part, { filename, bytes });
    return `Attached image: ${filename} ${createHash('sha256').update(bytes).digest('hex')}`;
  });

  return {
    fingerprintText,
    async materialize() {
      if (!images.size) return { text: fingerprintText };
      const directory = await mkdtemp(path.join(tmpdir(), 'openchamber-agy-images-'));
      const cleanup = () => rm(directory, { recursive: true, force: true });
      try {
        for (const { filename, bytes } of images.values()) {
          await writeFile(path.join(directory, filename), bytes, { flag: 'wx', mode: 0o600 });
        }
        const text = antigravityPromptText(parts, (part) => {
          const image = images.get(part);
          if (!image) throw invalidRequestError('Antigravity image attachment was not prepared');
          return antigravityImageReference(path.join(directory, image.filename));
        });
        return { text, cleanup };
      } catch (error) {
        await cleanup();
        throw error;
      }
    },
  };
}

export function canReuseAntigravitySend(receipt: RegistrySendRecordInput['antigravity'], requestFingerprint: string): boolean {
  if (receipt?.requestFingerprint && receipt.requestFingerprint !== requestFingerprint) {
    throw invalidRequestError('This message ID belongs to a different Antigravity prompt');
  }
  if (receipt?.requestFingerprint === requestFingerprint && (receipt.inputDelivery === 'written' || receipt.stepIndex !== undefined)) return true;
  if (receipt?.inputDelivery === 'not-written') return false;
  throw new NativeAgentError('The earlier Antigravity prompt could not be confirmed. Check the conversation before sending again.', {
    code: 'NATIVE_PROMPT_OUTCOME_UNKNOWN', status: 502,
  });
}
