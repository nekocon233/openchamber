import { expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installHookTestDom } from '@/components/session/sidebar/test-utils/testDom';
import { useQuotaAutoRefresh, useQuotaStore } from './useQuotaStore';
import { z } from 'zod';

test('visible quota readouts share one interval, Settings reads all, and hidden readouts do no polling', async () => {
  const dom = installHookTestDom();
  const root = createRoot(dom.container);
  const interval = spyOn(window, 'setInterval');
  const tick = async () => {
    const callback = interval.mock.calls[0][0];
    await z.function().parse(callback)();
  };
  const clear = spyOn(window, 'clearInterval');
  const selected = spyOn(useQuotaStore.getState(), 'refreshSelectedQuotas').mockResolvedValue(true);
  const all = spyOn(useQuotaStore.getState(), 'fetchAllQuotas').mockResolvedValue();
  const Readouts = ({ settings }: { settings: boolean }) => {
    useQuotaAutoRefresh(true);
    useQuotaAutoRefresh(settings, true);
    return null;
  };
  try {
    await act(async () => root.render(<Readouts settings />));
    expect(interval).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    await tick();
    expect(all).not.toHaveBeenCalled();
    expect(selected).not.toHaveBeenCalled();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    await tick();
    expect(all).toHaveBeenCalledTimes(1);
    await act(async () => root.render(<Readouts settings={false} />));
    await tick();
    expect(selected).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
    await tick();
    expect(selected).toHaveBeenCalledTimes(1);
    expect(clear).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
    for (const spy of [interval, clear, selected, all]) spy.mockRestore();
    dom.restore();
  }
});
