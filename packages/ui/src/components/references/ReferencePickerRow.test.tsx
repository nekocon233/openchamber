import React from 'react';
import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { GitHubChecksSummary, GitHubPullReference, GitHubPullStatus } from '@/lib/api/types';
import { I18nProvider } from '@/lib/i18n';
import type { CachedValue } from './referenceCache';
import { ReferencePickerRow } from './ReferencePickerRow';

const reference: GitHubPullReference = {
  kind: 'pull', number: 7, title: 'Fix navigation', url: 'https://github.com/acme/app/pull/7',
  body: '', bodyTruncated: false, createdAt: null, updatedAt: null, author: null, labels: [], commentCount: 0,
  sourceRepo: { owner: 'acme', repo: 'app', source: 'origin' }, state: 'open', draft: false,
  head: 'feature', base: 'main', headSha: 'sha', headRepo: null,
};
const ready = (checks: GitHubChecksSummary | null): CachedValue<GitHubPullStatus | null> => ({
  status: 'ready', value: { owner: 'acme', repo: 'app', number: 7, checks, mergeable: null, mergeableState: null },
});
const render = (pullStatus: CachedValue<GitHubPullStatus | null>, showChecks = true) => renderToStaticMarkup(
  <I18nProvider><ReferencePickerRow item={{ source: 'github', reference }} pullStatus={pullStatus} showChecks={showChecks}
    highlighted={false} checked={null} diffIncluded={false} now={0} onHighlight={() => {}} onToggle={() => {}} onActivate={() => {}} />
  </I18nProvider>,
);

test('check results show their meaning and counts without opening the PR', () => {
  expect(render(ready({ state: 'success', total: 4, success: 4, failure: 0, pending: 0 }))).toContain('4/4 checks passed');
  expect(render(ready({ state: 'failure', total: 4, success: 2, failure: 1, pending: 1 }))).toContain('1/4 checks failed');
  expect(render(ready({ state: 'pending', total: 4, success: 2, failure: 0, pending: 2, queued: 1 }))).toContain('2/4 checks pending');
  expect(render(ready({ state: 'pending', total: 4, success: 2, failure: 0, pending: 2, queued: 2 }))).toContain('2/4 checks queued');
});

test('empty checks, unavailable results and loading failures remain distinct', () => {
  expect(render(ready({ state: 'unknown', total: 0, success: 0, failure: 0, pending: 0 }))).toContain('No checks');
  expect(render(ready({ state: 'unknown', total: 2, success: 0, failure: 0, pending: 0 }))).toContain('Check status unknown');
  for (const state of [ready(null), { status: 'ready', value: null } satisfies CachedValue<GitHubPullStatus | null>]) {
    const html = render(state);
    expect(html).toContain('Checks unavailable');
    expect(html).not.toContain('No checks');
  }
  const failure = render({ status: 'error', error: 'Network unavailable' });
  expect(failure).toContain('Could not load checks');
  expect(failure).not.toContain('No checks');
  expect(render({ status: 'idle' })).toContain('Loading checks');
  expect(render({ status: 'loading' })).toContain('Loading checks');
});

test('other list consumers keep their existing compact rows', () => {
  expect(render(ready({ state: 'success', total: 4, success: 4, failure: 0, pending: 0 }), false)).not.toContain('checks passed');
});
