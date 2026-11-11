import { describe, expect, test } from 'bun:test';
import { LOCALES } from '../runtime';
import { ciRunsI18n } from './ci-runs.i18n';

describe('CI runs translations', () => {
  test('all locales provide translated messages with matching placeholders', () => {
    const english: Record<string, string> = ciRunsI18n.en;
    for (const locale of LOCALES) {
      const messages: Record<string, string> = ciRunsI18n[locale];
      expect(Object.keys(messages)).toEqual(Object.keys(english));
      for (const [key, value] of Object.entries(english)) {
        expect(messages[key]).toBeTruthy();
        if (locale !== 'en') expect(messages[key]).not.toBe(value);
        expect([...(messages[key].match(/\{[^}]+\}/g) ?? [])].sort()).toEqual([...(value.match(/\{[^}]+\}/g) ?? [])].sort());
      }
    }
  });
});
