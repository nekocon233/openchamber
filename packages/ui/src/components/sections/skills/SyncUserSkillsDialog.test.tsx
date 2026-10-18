import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';

import { registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { useSkillsCatalogStore } from '@/stores/useSkillsCatalogStore';
import type { SkillsUserSyncPlanItem, SkillsUserSyncResult } from '@/lib/api/types';

type TestRunPayload = {
  ok: boolean;
  results?: SkillsUserSyncResult[];
  updated?: number;
  skipped?: number;
  failed?: number;
  error?: { kind: string; message: string };
};

describe('SyncUserSkillsDialog', () => {
  let dom: Window;
  let root: Root | undefined;
  let container: HTMLElement;
  let restoreFetch = () => {};
  const requests: Array<{ path: string; body: unknown }> = [];
  const globals = new Map<string, PropertyDescriptor | undefined>();
  let planItems: SkillsUserSyncPlanItem[] = [];
  let runPayload: TestRunPayload = { ok: true };

  const flush = async () => {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  beforeEach(() => {
    dom = new Window({ url: 'http://localhost/' });
    const values = {
      window: dom, document: dom.document, navigator: dom.navigator,
      HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node,
      HTMLInputElement: dom.HTMLInputElement,
      DocumentFragment: dom.DocumentFragment, MutationObserver: dom.MutationObserver,
      ResizeObserver: dom.ResizeObserver, MouseEvent: dom.MouseEvent,
      PointerEvent: dom.PointerEvent, Event: dom.Event, CustomEvent: dom.CustomEvent,
      getComputedStyle: dom.getComputedStyle.bind(dom),
      requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
      cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
      IS_REACT_ACT_ENVIRONMENT: true,
    };
    for (const [key, value] of Object.entries(values)) {
      globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, { configurable: true, value });
    }
    requests.length = 0;
    planItems = [];
    runPayload = { ok: true, results: [], updated: 0, skipped: 0, failed: 0 };
    registerRuntimeAPIs(null);
    useSkillsCatalogStore.setState({ isSyncingUserSkills: false });

    const fetch = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost');
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      requests.push({ path: url.pathname, body });

      if (url.pathname === '/api/config/skills/user/sync' && method === 'POST') {
        if (body?.dryRun === true) return Response.json({ ok: true, plan: planItems });
        return Response.json(runPayload);
      }
      if (url.pathname === '/api/config/skills') return Response.json({ skills: [] });
      throw new Error(`Unexpected request: ${method} ${url.pathname}`);
    });
    restoreFetch = () => fetch.mockRestore();
    container = document.createElement('div');
    document.body.append(container);
  });

  afterEach(async () => {
    const mountedRoot = root;
    if (mountedRoot) await act(async () => { mountedRoot.unmount(); });
    root = undefined;
    restoreFetch();
    await dom.happyDOM.close();
    for (const [key, value] of globals) {
      if (value) Object.defineProperty(globalThis, key, value);
      else Reflect.deleteProperty(globalThis, key);
    }
    globals.clear();
  });

  const render = async () => {
    const { createRoot } = await import('react-dom/client');
    const { SyncUserSkillsDialog } = await import('./SyncUserSkillsDialog');
    const { I18nProvider } = await import('@/lib/i18n');
    const { TooltipProvider } = await import('@/components/ui/tooltip');
    const mountedRoot = createRoot(container);
    root = mountedRoot;
    await act(async () => {
      mountedRoot.render(
        <I18nProvider>
          <TooltipProvider>
            <SyncUserSkillsDialog open onOpenChange={() => {}} />
          </TooltipProvider>
        </I18nProvider>,
      );
    });
    await flush();
  };

  const button = (text: string) => {
    const result = [...document.querySelectorAll('button')].find((entry) => entry.textContent?.trim() === text);
    if (!result) throw new Error(`Missing button: ${text}`);
    return result;
  };

  const plan = (): SkillsUserSyncPlanItem[] => [
    { skillName: 'general-video', status: 'update', source: { agent: 'claude', plugin: 'hyperframes', version: '0.8.85' } },
    { skillName: 'hyperframes', status: 'current', source: { agent: 'claude', plugin: 'hyperframes', version: '0.8.85' } },
    { skillName: 'aidraw', status: 'external', source: null },
    { skillName: 'phaser-editor-workflow', status: 'noSource', source: null },
  ];

  test('lists what will be replaced and what stays, with the source plugin', async () => {
    planItems = plan();

    await render();

    expect(requests[0]).toMatchObject({ path: '/api/config/skills/user/sync', body: { dryRun: true } });
    expect(document.body.textContent).toContain('Sync user skills');
    expect(document.body.textContent).toContain('These skills will be replaced');
    expect(document.body.textContent).toContain('general-video');
    expect(document.body.textContent).toContain('Claude Code · hyperframes 0.8.85');
    expect(document.body.textContent).toContain('These skills will not be changed');
    expect(document.body.textContent).toContain('up to date');
    expect(document.body.textContent).toContain('symlink');
    expect(document.body.textContent).toContain('no plugin source');
  });

  test('says so when nothing can be replaced', async () => {
    planItems = plan().filter((item) => item.status !== 'update');

    await render();

    expect(document.body.textContent).toContain('Every skill is up to date or managed outside the plugins.');
    expect(button('Close')).toBeTruthy();
    expect([...document.querySelectorAll('button')].some((entry) => entry.textContent?.trim() === 'Replace all')).toBe(false);
  });

  test('replaces the skills and reports failures', async () => {
    planItems = plan();
    runPayload = {
      ok: true,
      updated: 1,
      skipped: 3,
      failed: 1,
      results: [
        { skillName: 'general-video', status: 'updated', source: { agent: 'claude', plugin: 'hyperframes', version: '0.8.85' } },
        { skillName: 'hyperframes', status: 'skipped', reason: 'current', source: null },
        { skillName: 'aidraw', status: 'skipped', reason: 'external', source: null },
        { skillName: 'phaser-editor-workflow', status: 'skipped', reason: 'noSource', source: null },
        { skillName: 'broken', status: 'failed', kind: 'copyFailed', source: null },
      ],
    };

    await render();
    await act(async () => { button('Replace all').click(); });
    await flush();

    const syncRequests = requests.filter((request) => request.path === '/api/config/skills/user/sync');
    expect(syncRequests).toHaveLength(2);
    expect(syncRequests[1].body).toEqual({ dryRun: false });
    expect(document.body.textContent).toContain('Updated');
    expect(document.body.textContent).toContain('Skipped');
    expect(document.body.textContent).toContain('Failed');
    expect(document.body.textContent).toContain('broken');
    expect(document.body.textContent).toContain('Could not replace this skill.');
  });

  test('shows a request failure instead of results', async () => {
    planItems = plan();
    runPayload = { ok: false, error: { kind: 'busy', message: 'A user skill sync is already running' } };

    await render();
    await act(async () => { button('Replace all').click(); });
    await flush();

    expect(document.body.textContent).toContain('Another sync is already running.');
  });
});
