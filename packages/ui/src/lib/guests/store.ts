import { create } from 'zustand';

import { DESKTOP_GUEST_ID } from '@/lib/workspace/editorTabs';
import { isGuestActive } from './capabilities.ts';
import type { GuestUpdate, InstalledGuest, OpenCodePlugins, UnreadableGuest } from './types.ts';
import type { GuestRequestFailure } from './request-failure.ts';

type GuestsStatus = 'idle' | 'loading' | 'ready' | 'error' | 'unsupported';

type GuestsState = {
  status: GuestsStatus;
  failure: GuestRequestFailure | null;
  guests: InstalledGuest[];
  unreadable: UnreadableGuest[];
  /** Server process.platform reported by GET /api/guests; null until known. */
  hostPlatform: string | null;
  /** Whether the built-in Remote Desktop extension reported Linux desktop+browser readiness. */
  desktopUrlReady: boolean | null;
  opencodePlugins: OpenCodePlugins | null;
  runtimeKey: string;
  markLoading: () => void;
  replaceCatalog: (
    guests: InstalledGuest[],
    runtimeKey: string,
    unreadable?: UnreadableGuest[],
    opencodePlugins?: OpenCodePlugins | string | null,
    hostPlatform?: string,
  ) => void;
  setDesktopUrlReady: (ready: boolean | null, runtimeKey: string) => void;
  applyUpdates: (updates: Record<string, GuestUpdate>, runtimeKey: string) => void;
  markFailed: (runtimeKey: string, failure?: GuestRequestFailure) => void;
  markUnsupported: (runtimeKey: string) => void;
  resetForRuntimeSwitch: (runtimeKey: string) => void;
};

export const useGuestsStore = create<GuestsState>((set, get) => ({
  status: 'idle',
  failure: null,
  guests: [],
  unreadable: [],
  hostPlatform: null,
  desktopUrlReady: null,
  opencodePlugins: null,
  runtimeKey: '',
  markLoading: () => {
    if (get().status === 'ready') return;
    set({ status: 'loading', failure: null });
  },
  replaceCatalog: (guests, runtimeKey, unreadable = [], opencodePluginsOrPlatform = null, hostPlatform) => {
    if (get().runtimeKey !== runtimeKey) return;
    const current = get();
    const opencodePlugins = typeof opencodePluginsOrPlatform === 'string' ? null : opencodePluginsOrPlatform;
    const nextPlatform = typeof opencodePluginsOrPlatform === 'string'
      ? opencodePluginsOrPlatform
      : (hostPlatform ?? null);
    const offered = new Map(current.guests.flatMap((guest) => (guest.update ? [[guest.id, guest] as const] : [])));
    const next = guests.map((guest) => {
      const known = offered.get(guest.id);
      const sameCopy = known?.version === guest.version && known?.source === guest.source
        && JSON.stringify(known?.origin) === JSON.stringify(guest.origin);
      return known?.update && !guest.update && sameCopy ? { ...guest, update: known.update } : guest;
    });
    const desktop = next.find((guest) => guest.id === DESKTOP_GUEST_ID);
    const desktopActive = Boolean(desktop && isGuestActive(desktop));
    const desktopUrlReady = nextPlatform && nextPlatform !== 'linux'
      ? false
      : !desktopActive
        ? false
        : nextPlatform === 'linux'
          ? current.desktopUrlReady
          : null;
    const same = current.status === 'ready' && current.failure === null
      && JSON.stringify(next) === JSON.stringify(current.guests)
      && JSON.stringify(unreadable) === JSON.stringify(current.unreadable)
      && JSON.stringify(opencodePlugins) === JSON.stringify(current.opencodePlugins)
      && current.hostPlatform === nextPlatform
      && current.desktopUrlReady === desktopUrlReady;
    if (!same) {
      set({
        status: 'ready',
        guests: next,
        unreadable,
        opencodePlugins,
        hostPlatform: nextPlatform,
        desktopUrlReady,
        failure: null,
      });
    }
  },
  setDesktopUrlReady: (ready, runtimeKey) => {
    if (get().runtimeKey !== runtimeKey) return;
    set({ desktopUrlReady: ready });
  },
  applyUpdates: (updates, runtimeKey) => {
    if (get().runtimeKey !== runtimeKey) return;
    let changed = false;
    const guests = get().guests.map((guest) => {
      const next = updates[guest.id];
      if (next && guest.update?.version === next.version) return guest;
      if (!next && !guest.update) return guest;
      changed = true;
      if (!next) {
        const rest = { ...guest };
        delete rest.update;
        return rest;
      }
      return { ...guest, update: next };
    });
    if (changed) set({ guests });
  },
  markFailed: (runtimeKey, failure) => {
    if (get().runtimeKey !== runtimeKey) return;
    if (get().status === 'ready') {
      set({ failure: failure ?? null });
      return;
    }
    set({ status: 'error', guests: [], unreadable: [], opencodePlugins: null, hostPlatform: null, desktopUrlReady: null, failure: failure ?? null });
  },
  markUnsupported: (runtimeKey) => {
    if (get().runtimeKey !== runtimeKey) return;
    set({ status: 'unsupported', guests: [], unreadable: [], opencodePlugins: null, hostPlatform: null, desktopUrlReady: false, failure: null });
  },
  resetForRuntimeSwitch: (runtimeKey) => {
    set({ status: 'idle', guests: [], unreadable: [], opencodePlugins: null, hostPlatform: null, desktopUrlReady: null, runtimeKey, failure: null });
  },
}));
