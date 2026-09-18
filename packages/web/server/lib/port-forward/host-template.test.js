import { describe, expect, test } from 'bun:test';

import {
  buildForwardHost,
  matchForwardHost,
  normalizeForwardHostTemplate,
  parseForwardHostTemplate,
} from './host-template.js';

const parsed = parseForwardHostTemplate('oc--{port}.example.com');

describe('parseForwardHostTemplate', () => {
  test('splits the template around its placeholder', () => {
    expect(parsed).toEqual({ template: 'oc--{port}.example.com', prefix: 'oc--', suffix: '.example.com' });
  });

  test('accepts a placeholder that occupies a whole label', () => {
    expect(parseForwardHostTemplate('{port}.example.com')).toEqual({
      template: '{port}.example.com',
      prefix: '',
      suffix: '.example.com',
    });
  });

  test('lowercases before splitting, so one hostname has one spelling', () => {
    expect(parseForwardHostTemplate('OC--{port}.Example.COM').template).toBe('oc--{port}.example.com');
  });

  test.each([
    ['no placeholder', 'oc.example.com'],
    ['two placeholders', 'oc--{port}-{port}.example.com'],
    ['empty', '   '],
    ['a scheme', 'https://oc--{port}.example.com'],
    ['a port', 'oc--{port}.example.com:443'],
    ['a path', 'oc--{port}.example.com/app'],
    ['a wildcard', '*--{port}.example.com'],
    ['a trailing dot', 'oc--{port}.example.com.'],
    ['a single label', 'oc--{port}'],
    ['non-ASCII', 'oc--{port}.例え.com'],
    ['an IP address', '127.0.0.{port}'],
    ['an underscore', 'oc_{port}.example.com'],
  ])('rejects %s', (_label, value) => {
    expect(() => parseForwardHostTemplate(value)).toThrow();
    expect(normalizeForwardHostTemplate(value)).toBeNull();
  });

  test('rejects a digit beside the placeholder, which would make a host ambiguous', () => {
    // `oc15173.example.com` would read as both port 5173 and port 15173.
    expect(() => parseForwardHostTemplate('oc1{port}.example.com')).toThrow();
    expect(() => parseForwardHostTemplate('oc--{port}1.example.com')).toThrow();
  });
});

describe('buildForwardHost', () => {
  test('substitutes the port', () => {
    expect(buildForwardHost(parsed, 5173)).toBe('oc--5173.example.com');
  });
});

describe('matchForwardHost', () => {
  test('reads the port back out', () => {
    expect(matchForwardHost(parsed, 'oc--5173.example.com')).toBe(5173);
  });

  test('ignores the port the browser appends', () => {
    expect(matchForwardHost(parsed, 'oc--5173.example.com:443')).toBe(5173);
  });

  test('is case-insensitive, as DNS is', () => {
    expect(matchForwardHost(parsed, 'OC--5173.Example.com')).toBe(5173);
  });

  test('round-trips every buildable port', () => {
    for (const port of [1, 80, 3000, 5173, 65535]) {
      expect(matchForwardHost(parsed, buildForwardHost(parsed, port))).toBe(port);
    }
  });

  test.each([
    ['an unrelated host', 'example.com'],
    ['the OpenChamber host itself', 'oc.example.com'],
    ['a suffix that only looks right', 'oc--5173.example.com.evil.example'],
    ['a prefix that only looks right', 'xoc--5173.example.com'],
    ['a different zone', 'oc--5173.notexample.com'],
    ['a deeper name under the zone', 'oc--5173.sub.example.com'],
    ['a non-numeric port', 'oc--abc.example.com'],
    ['an empty port', 'oc--.example.com'],
    ['a port above the range', 'oc--65536.example.com'],
    ['a six-digit port', 'oc--123456.example.com'],
    ['a leading zero', 'oc--05173.example.com'],
    ['a missing host header', undefined],
    ['an empty host header', ''],
  ])('refuses %s', (_label, host) => {
    expect(matchForwardHost(parsed, host)).toBeNull();
  });

  test('refuses a bare-label template match against the wrong depth', () => {
    const bare = parseForwardHostTemplate('{port}.example.com');
    expect(matchForwardHost(bare, '5173.example.com')).toBe(5173);
    expect(matchForwardHost(bare, 'a5173.example.com')).toBeNull();
    expect(matchForwardHost(bare, '5173.sub.example.com')).toBeNull();
  });
});
