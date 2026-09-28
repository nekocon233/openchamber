import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'bun:test';

import { I18nProvider } from '@/lib/i18n';
import { SessionBackgroundBadge } from './SessionBackgroundBadge';

const render = (count: number) => renderToStaticMarkup(<I18nProvider><SessionBackgroundBadge count={count} /></I18nProvider>);

test('labels the count with a complete sentence for one and for many tasks', () => {
  expect(render(1)).toContain('aria-label="1 background task running"');
  expect(render(3)).toContain('aria-label="3 background tasks running"');
  expect(render(3)).toContain('>3</span>');
});
