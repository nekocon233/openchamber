import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';

// React DOM probes for a DOM when first imported.
const importWindow = new Window();
const importGlobals = ['window', 'document'] as const;
const previousImportGlobals = importGlobals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
Object.defineProperty(globalThis, 'window', { value: importWindow, configurable: true, writable: true });
Object.defineProperty(globalThis, 'document', { value: importWindow.document, configurable: true, writable: true });
const { createRoot } = await import('react-dom/client');
const { useFactsFit } = await import('./useFactsFit');
for (const [name, descriptor] of previousImportGlobals) {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else Reflect.deleteProperty(globalThis, name);
}
void importWindow.happyDOM.close();

class TestResizeObserver implements ResizeObserver {
  static observed: Element[] = [];
  static disconnected = 0;
  observe(target: Element): void {
    TestResizeObserver.observed.push(target);
  }
  unobserve(): void {}
  disconnect(): void { TestResizeObserver.disconnected += 1; }
}

// Every width read on the model forces a layout in a browser; count them.
let widthReads = 0;
let modelClientWidth = 100;
const countWidthReads = (element: HTMLElement | null) => {
  if (!element) return;
  Object.defineProperty(element, 'scrollWidth', { configurable: true, get: () => { widthReads += 1; return 100; } });
  Object.defineProperty(element, 'clientWidth', { configurable: true, get: () => modelClientWidth });
};

const Footer = ({ show, duration, tick, fitEnabled = true }: { show: boolean; duration: string; tick: number; fitEnabled?: boolean }) => {
  const ref = React.useRef<HTMLDivElement | null>(null);
  useFactsFit(ref, fitEnabled);
  return (
    <div data-tick={tick}>
      {show ? (
        <div ref={ref}>
          <span data-fact-model="" ref={countWidthReads}>model</span>
          <span data-fact-priority="1">{duration}</span>
        </div>
      ) : null}
    </div>
  );
};

const DOM_GLOBAL_NAMES = ['window', 'document', 'HTMLElement', 'ResizeObserver', 'IS_REACT_ACT_ENVIRONMENT'] as const;
let fonts: EventTarget;

describe('useFactsFit', () => {
  let root: Root;
  let restore: () => void;

  const render = (props: React.ComponentProps<typeof Footer>) => act(async () => root.render(<Footer {...props} />));

  beforeEach(() => {
    const win = new Window({ url: 'http://localhost' });
    const previous = DOM_GLOBAL_NAMES.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
    const values = { window: win, document: win.document, HTMLElement: win.HTMLElement, ResizeObserver: TestResizeObserver, IS_REACT_ACT_ENVIRONMENT: true };
    for (const name of DOM_GLOBAL_NAMES) Object.defineProperty(globalThis, name, { value: values[name], configurable: true, writable: true });
    fonts = new EventTarget();
    Object.defineProperty(win.document, 'fonts', { configurable: true, value: fonts });
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    widthReads = 0;
    modelClientWidth = 100;
    TestResizeObserver.observed = [];
    TestResizeObserver.disconnected = 0;
    restore = () => {
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
      void win.happyDOM.close();
    };
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    restore();
  });

  test('re-renders that leave the row text alone measure nothing', async () => {
    await render({ show: true, duration: '3s', tick: 0 });
    const afterMount = widthReads;
    expect(afterMount).toBeGreaterThan(0);

    await render({ show: true, duration: '3s', tick: 1 });
    await render({ show: true, duration: '3s', tick: 2 });
    expect(widthReads).toBe(afterMount);

    await render({ show: true, duration: '4s', tick: 3 });
    expect(widthReads).toBeGreaterThan(afterMount);
  });

  test('a row that mounts after the first render is fitted and observed', async () => {
    await render({ show: false, duration: '3s', tick: 0 });
    expect(TestResizeObserver.observed).toHaveLength(0);

    await render({ show: true, duration: '3s', tick: 1 });
    expect(widthReads).toBeGreaterThan(0);
    expect(TestResizeObserver.observed).toHaveLength(1);
  });

  test('a web font that finishes loading refits the row', async () => {
    await render({ show: true, duration: '3s', tick: 0 });
    const afterMount = widthReads;

    await act(async () => { fonts.dispatchEvent(new Event('loadingdone')); });
    expect(widthReads).toBeGreaterThan(afterMount);
  });

  test('wrapping footers never measure or observe their facts', async () => {
    modelClientWidth = 40;
    await render({ show: true, duration: '3s', tick: 0, fitEnabled: false });
    await render({ show: true, duration: '4s', tick: 1, fitEnabled: false });
    await act(async () => {
      fonts.dispatchEvent(new Event('loadingdone'));
      window.dispatchEvent(new window.Event('resize'));
    });

    expect(widthReads).toBe(0);
    expect(TestResizeObserver.observed).toHaveLength(0);
    expect(document.querySelector<HTMLElement>('[data-fact-priority]')?.style.display).toBe('');
  });

  test('switching to wrapping restores hidden facts and releases observers until fitting resumes', async () => {
    modelClientWidth = 40;
    await render({ show: true, duration: '3s', tick: 0 });
    const fact = document.querySelector<HTMLElement>('[data-fact-priority]');
    expect(fact?.style.display).toBe('none');
    const afterFit = widthReads;

    await render({ show: true, duration: '3s', tick: 1, fitEnabled: false });
    expect(fact?.style.display).toBe('');
    expect(TestResizeObserver.disconnected).toBe(1);
    await act(async () => {
      fonts.dispatchEvent(new Event('loadingdone'));
      window.dispatchEvent(new window.Event('resize'));
    });
    expect(widthReads).toBe(afterFit);

    await render({ show: true, duration: '3s', tick: 2, fitEnabled: true });
    expect(widthReads).toBeGreaterThan(afterFit);
    expect(fact?.style.display).toBe('none');
    expect(TestResizeObserver.observed).toHaveLength(2);
  });
});
