import { afterAll, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

const dom = new Window({ url: 'http://localhost' });
const durableStorage = dom.localStorage;
let writesBlocked = false;
Object.defineProperty(dom, 'localStorage', { value: {
  getItem: (name: string) => durableStorage.getItem(name),
  setItem: (name: string, value: string) => {
    if (writesBlocked) throw new Error('Storage quota exceeded');
    durableStorage.setItem(name, value);
  },
  removeItem: (name: string) => durableStorage.removeItem(name),
  clear: () => durableStorage.clear(), key: (index: number) => durableStorage.key(index),
  get length() { return durableStorage.length; },
} });
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
Object.defineProperty(globalThis, 'window', { configurable: true, value: dom });
const { diffFileFilterKey, selectExcludedFileTypes, useDiffFileFilterStore } = await import('./useDiffFileFilterStore');
const key = 'openchamber.diff-file-types.v1';
const flush = () => dom.dispatchEvent(new dom.Event('pagehide'));

afterAll(() => {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
  dom.happyDOM.cancelAsync();
});

describe('project file type preferences', () => {
  test('isolates projects and runtimes, and preserves unrelated references', () => {
    const a = diffFileFilterKey('runtime-a', '/project-a');
    const b = diffFileFilterKey('runtime-a', '/project-b');
    const remoteA = diffFileFilterKey('runtime-b', '/project-a');
    const set = useDiffFileFilterStore.getState().setExcludedTypes;
    set(a, ['json']);
    const aTypes = selectExcludedFileTypes(useDiffFileFilterStore.getState(), a);
    set(b, ['ts']);
    expect(selectExcludedFileTypes(useDiffFileFilterStore.getState(), a)).toBe(aTypes);
    expect(selectExcludedFileTypes(useDiffFileFilterStore.getState(), b)).toEqual(['ts']);
    expect(selectExcludedFileTypes(useDiffFileFilterStore.getState(), remoteA)).toEqual([]);
    set(a, ['JSON']);
    expect(selectExcludedFileTypes(useDiffFileFilterStore.getState(), a)).toBe(aTypes);
    expect(diffFileFilterKey('runtime-a', '/project-a/')).toBe(a);
  });

  test('round trips on immediate page hide, including restoring all', async () => {
    flush();
    const a = diffFileFilterKey('runtime-a', '/project-a');
    const snapshot = dom.localStorage.getItem(key);
    expect(snapshot).not.toBeNull();
    if (snapshot === null) throw new Error('The snapshot was not persisted');
    useDiffFileFilterStore.setState({ excludedByProject: {} });
    flush();
    dom.localStorage.setItem(key, snapshot);
    await useDiffFileFilterStore.persist.rehydrate();
    expect(selectExcludedFileTypes(useDiffFileFilterStore.getState(), a)).toEqual(['json']);
    useDiffFileFilterStore.getState().setExcludedTypes(a, []);
    flush();
    await useDiffFileFilterStore.persist.rehydrate();
    expect(selectExcludedFileTypes(useDiffFileFilterStore.getState(), a)).toEqual([]);
    expect(selectExcludedFileTypes(useDiffFileFilterStore.getState(), diffFileFilterKey('runtime-a', '/project-b'))).toEqual(['ts']);
  });

  test('ignores a corrupt project while retaining valid entries', async () => {
    flush();
    const valid = diffFileFilterKey('runtime-c', '/valid');
    dom.localStorage.setItem(key, JSON.stringify({ state: { excludedByProject: {
      [valid]: ['TS', 'ts', '', null], invalid: ['json'], '["a",null]': ['css'],
    } }, version: 0 }));
    await useDiffFileFilterStore.persist.rehydrate();
    expect(useDiffFileFilterStore.getState().excludedByProject).toEqual({ [valid]: ['', 'ts'] });
  });

  test('a failed durable write keeps the complete current choices available for this session', async () => {
    const owner = diffFileFilterKey('runtime-c', '/restricted');
    flush();
    writesBlocked = true;
    try {
      useDiffFileFilterStore.getState().setExcludedTypes(owner, ['lock']);
      flush();
      expect(dom.localStorage.getItem(key)).toBeNull();
      await useDiffFileFilterStore.persist.rehydrate();
      expect(selectExcludedFileTypes(useDiffFileFilterStore.getState(), owner)).toEqual(['lock']);
      expect(selectExcludedFileTypes(useDiffFileFilterStore.getState(), diffFileFilterKey('runtime-c', '/valid'))).toEqual(['', 'ts']);
    } finally {
      writesBlocked = false;
    }
  });
});
