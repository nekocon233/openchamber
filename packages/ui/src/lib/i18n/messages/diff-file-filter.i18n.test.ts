import { describe, expect, test } from 'bun:test';
import { LOCALES } from '../runtime';
import { diffFileFilterI18n } from './diff-file-filter.i18n';

describe('Changes file type translations', () => {
  test('all locales provide translated messages with matching placeholders', () => {
    const english: Record<string, string> = diffFileFilterI18n.en;
    for (const locale of LOCALES) {
      const messages: Record<string, string> = diffFileFilterI18n[locale];
      expect(Object.keys(messages)).toEqual(Object.keys(english));
      for (const [key, value] of Object.entries(english)) {
        expect(messages[key]).toBeTruthy();
        if (locale !== 'en') expect(messages[key]).not.toBe(value);
        expect(messages[key].match(/\{[^}]+\}/g) ?? []).toEqual(value.match(/\{[^}]+\}/g) ?? []);
      }
    }
  });
});
