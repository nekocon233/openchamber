import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';

import { registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { useSkillsCatalogStore } from '@/stores/useSkillsCatalogStore';

type TestPlanItem = {
  skillName: string;
  skillDir: string;
  scope: string;
  source: string;
  sourceId: string;
  sourceRef: string;
};

type TestRunResult = {
  skillName: string;
  scope: string;
  source: string;
  status: string;
  kind?: string;
  reason?: string;
};

type TestRunPayload = {
  ok: boolean;
  results?: TestRunResult[];
  updated?: number;
  skipped?: number;
  failed?: number;
  error?: { kind: string; message: string };
};

describe('UpdateInstalledSkillsDialog', () => {
  let dom: Window;
  let root: Root | undefined;
  let container: HTMLElement;
  let restoreFetch = () => {};
  const requests: Array<{ path: string; body: unknown }> = [];
  const globals = new Map<string, PropertyDescriptor | undefined>();
  let planItems: TestPlanItem[] = [];
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
    useSkillsCatalogStore.setState({ isUpdatingInstalled: false });

    const fetch = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost');
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      requests.push({ path: url.pathname, body });

      if (url.pathname === '/api/config/skills/catalog/update' && method === 'POST') {
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
    const { UpdateInstalledSkillsDialog } = await import('./UpdateInstalledSkillsDialog');
    const { I18nProvider } = await import('@/lib/i18n');
    const { TooltipProvider } = await import('@/components/ui/tooltip');
    const mountedRoot = createRoot(container);
    root = mountedRoot;
    await act(async () => {
      mountedRoot.render(
        <I18nProvider>
          <TooltipProvider>
            <UpdateInstalledSkillsDialog
              open
              onOpenChange={() => {}}
              directory="/project"
              sources={[{ id: 'acme', label: 'Acme skills', source: 'acme/skills' }]}
            />
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

  test('lists the recorded skills and warns about local edits', async () => {
    planItems = [{
      skillName: 'demo',
      skillDir: 'skills/demo',
      scope: 'project',
      source: 'opencode',
      sourceId: 'acme',
      sourceRef: 'acme/skills',
    }];

    await render();

    expect(requests[0]).toMatchObject({ path: '/api/config/skills/catalog/update', body: { dryRun: true } });
    expect(document.body.textContent).toContain('Update installed skills');
    expect(document.body.textContent).toContain('These skills will be replaced');
    expect(document.body.textContent).toContain('demo');
    expect(document.body.textContent).toContain('Installed in project / opencode');
    expect(document.body.textContent).toContain('Acme skills');
    expect(document.body.textContent).toContain('Local edits to these skills are lost');
  });

  test('says so when no installed skill came from a catalog', async () => {
    await render();

    expect(document.body.textContent).toContain('No installed skill came from a catalog source.');
    expect(button('Close')).toBeTruthy();
    expect([...document.querySelectorAll('button')].some((entry) => entry.textContent?.trim() === 'Replace all')).toBe(false);
  });

  test('replaces the skills and reports each outcome', async () => {
    planItems = [{
      skillName: 'demo',
      skillDir: 'skills/demo',
      scope: 'project',
      source: 'opencode',
      sourceId: 'acme',
      sourceRef: 'acme/skills',
    }];
    runPayload = {
      ok: true,
      updated: 1,
      skipped: 0,
      failed: 1,
      results: [
        { skillName: 'demo', scope: 'project', source: 'opencode', status: 'updated' },
        { skillName: 'private', scope: 'user', source: 'opencode', status: 'failed', kind: 'authRequired', reason: 'Authentication required' },
      ],
    };

    await render();
    await act(async () => { button('Replace all').click(); });
    await flush();

    const updateRequests = requests.filter((request) => request.path === '/api/config/skills/catalog/update');
    expect(updateRequests).toHaveLength(2);
    expect(updateRequests[1].body).toEqual({ dryRun: false });
    expect(document.body.textContent).toContain('Updated');
    expect(document.body.textContent).toContain('Failed');
    expect(document.body.textContent).toContain('private');
    expect(document.body.textContent).toContain('This source needs access. Set up its credentials in the catalog source, then try again.');
  });

  test('shows a request failure instead of results', async () => {
    planItems = [{
      skillName: 'demo',
      skillDir: 'skills/demo',
      scope: 'project',
      source: 'opencode',
      sourceId: 'acme',
      sourceRef: 'acme/skills',
    }];
    runPayload = { ok: false, error: { kind: 'busy', message: 'An update is already running' } };

    await render();
    await act(async () => { button('Replace all').click(); });
    await flush();

    expect(document.body.textContent).toContain('An update is already running.');
  });
});
