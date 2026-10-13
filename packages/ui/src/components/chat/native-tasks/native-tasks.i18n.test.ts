import { expect, test } from 'bun:test';
import { dict as en } from '@/lib/i18n/messages/en';
import { dict as de } from '@/lib/i18n/messages/de';
import { dict as es } from '@/lib/i18n/messages/es';
import { dict as fr } from '@/lib/i18n/messages/fr';
import { dict as ja } from '@/lib/i18n/messages/ja';
import { dict as ko } from '@/lib/i18n/messages/ko';
import { dict as pl } from '@/lib/i18n/messages/pl';
import { dict as pt } from '@/lib/i18n/messages/pt-BR';
import { dict as tr } from '@/lib/i18n/messages/tr';
import { dict as uk } from '@/lib/i18n/messages/uk';
import { dict as cn } from '@/lib/i18n/messages/zh-CN';
import { dict as tw } from '@/lib/i18n/messages/zh-TW';

test('every shipped locale translates task controls, feedback and placeholders', () => {
  const keys = Object.keys(en).filter((key) => key.startsWith('chat.nativeTasks.'));
  for (const dictionary of [de, es, fr, ja, ko, pl, pt, tr, uk, cn, tw]) {
    const entries = new Map(Object.entries(dictionary));
    for (const [key, value] of Object.entries(en).filter(([key]) => keys.includes(key))) {
      const translated = entries.get(key);
      expect(translated).toBeTruthy();
      expect(translated?.match(/\{[^}]+\}/g)?.sort() ?? []).toEqual(value.match(/\{[^}]+\}/g)?.sort() ?? []);
      // Loanwords and units legitimately match; explanatory messages must not.
      if (value.length > 55) expect(translated).not.toBe(value);
    }
  }
});
