import { create } from 'zustand';

import { DESKTOP_GUEST_ID } from '@/lib/workspace/editorTabs';
import { isGuestActive } from './capabilities.ts';
import type { GuestUpdate, InstalledGuest, UnreadableGuest } from './types.ts';
import type { GuestRequestFailure } from './request-failure.ts';

type GuestsStatus = 'idle' | 'loading' | 'ready' | 'error' | 'unsupported';

type GuestsState = {
  status: GuestsStatus;
  failure: GuestRequestFailure | null;
  guests: InstalledGuest[];
  /** Installed rows this build could not read; Settings lists them so they can be removed. */
  unreadable: UnreadableGuest[];
  /** Server process.platform reported by GET /api/guests; null until known. */
  hostPlatform: string | null;
  /** Whether the built-in Remote Desktop extension reported Linux desktop+browser readiness. */
  desktopUrlReady: boolean | null;
  runtimeKey: string;
  markLoading: () => void;
  replaceCatalog: (guests: InstalledGuest[], runtimeKey: string, unreadable?: UnreadableGuest[], hostPlatform?: string) => void;
  setDesktopUrlReady: (ready: boolean | null, runtimeKey: string) => void;
  /** Overlay a fresh server update check: listed guests get `update`, every other guest loses it. */
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
  runtimeKey: '',
  markLoading: () => {
    if (get().status === 'ready') return;
    set({ status: 'loading', failure: null });
  },
  replaceCatalog: (guests, runtimeKey, unreadable = [], hostPlatform) => {
    if (get().runtimeKey !== runtimeKey) return;
    const nextPlatform = hostPlatform ?? null;
    const desktop = guests.find((guest) => guest.id === DESKTOP_GUEST_ID);
    const desktopActive = Boolean(desktop && isGuestActive(desktop));
    const desktopUrlReady = nextPlatform && nextPlatform !== 'linux'
      ? false
      : !desktopActive
        ? false
        : nextPlatform === 'linux'
          ? get().desktopUrlReady
          : null;
    set({ status: 'ready', guests, unreadable, hostPlatform: nextPlatform, desktopUrlReady, failure: null });
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
    set({ status: 'error', guests: [], unreadable: [], hostPlatform: null, desktopUrlReady: null, failure: failure ?? null });
  },
  markUnsupported: (runtimeKey) => {
    if (get().runtimeKey !== runtimeKey) return;
    set({ status: 'unsupported', guests: [], unreadable: [], hostPlatform: null, desktopUrlReady: false, failure: null });
  },
  resetForRuntimeSwitch: (runtimeKey) => {
    set({ status: 'idle', guests: [], unreadable: [], hostPlatform: null, desktopUrlReady: null, runtimeKey, failure: null });
  },
}));
