import React from 'react';
import type { Session } from '@opencode-ai/sdk/v2';
import { prunePinnedSessionIds } from './pinnedSessionCleanup';

type SafeStorageLike = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem?: (key: string) => void;
};

type Keys = {
  sessionExpanded: string;
  // v1 key, still on disk for users upgrading from pre-per-context expansion.
  // When present, its bare-session-id entries are fanned out to all four
  // (project|recent) × (active|archived) context combinations and rewritten
  // under `sessionExpanded`. After migration the v1 key is removed.
  sessionExpandedLegacy: string;
  projectCollapse: string;
  sessionPinned: string;
  groupOrder: string;
  projectActiveSession: string;
  groupCollapse: string;
};

const LEGACY_EXPANSION_CONTEXT_PREFIXES = [
  'project:active:',
  'project:archived:',
  'recent:active:',
  'recent:archived:',
];

type Args = {
  hasAuthoritativeGlobalSessions: boolean;
  safeStorage: SafeStorageLike;
  keys: Keys;
  sessions: Session[];
  pinnedSessionIds: Set<string>;
  setPinnedSessionIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  groupOrderByProject: Map<string, string[]>;
  activeSessionByProject: Map<string, string>;
  collapsedGroups: Set<string>;
  setExpandedParents: React.Dispatch<React.SetStateAction<Set<string>>>;
  setCollapsedProjects: React.Dispatch<React.SetStateAction<Set<string>>>;
};

export const useSidebarPersistence = (args: Args) => {
  const {
    hasAuthoritativeGlobalSessions,
    safeStorage,
    keys,
    sessions,
    setPinnedSessionIds,
    groupOrderByProject,
    activeSessionByProject,
    collapsedGroups,
    setExpandedParents,
    setCollapsedProjects,
  } = args;

  React.useEffect(() => {
    try {
      const storedParents = safeStorage.getItem(keys.sessionExpanded);
      if (storedParents) {
        const parsed = JSON.parse(storedParents);
        if (Array.isArray(parsed)) {
          setExpandedParents(new Set(parsed.filter((item) => typeof item === 'string')));
        }
      } else {
        // No v2 data — migrate from v1 (bare session ids) if present.
        const legacyRaw = safeStorage.getItem(keys.sessionExpandedLegacy);
        if (legacyRaw) {
          try {
            const parsedLegacy = JSON.parse(legacyRaw);
            if (Array.isArray(parsedLegacy)) {
              const migrated = new Set<string>();
              parsedLegacy.forEach((item) => {
                if (typeof item !== 'string' || item.length === 0) return;
                LEGACY_EXPANSION_CONTEXT_PREFIXES.forEach((prefix) => migrated.add(`${prefix}${item}`));
              });
              if (migrated.size > 0) {
                setExpandedParents(migrated);
                try { safeStorage.setItem(keys.sessionExpanded, JSON.stringify(Array.from(migrated))); } catch { /* ignored */ }
              }
            }
          } catch {
            // legacy data was malformed; ignore and let it expire
          }
          try { safeStorage.removeItem?.(keys.sessionExpandedLegacy); } catch { /* ignored */ }
        }
      }
      const storedProjects = safeStorage.getItem(keys.projectCollapse);
      if (storedProjects) {
        const parsed = JSON.parse(storedProjects);
        if (Array.isArray(parsed)) {
          setCollapsedProjects(new Set(parsed.filter((item) => typeof item === 'string')));
        }
      }
    } catch {
      // ignored
    }
  }, [keys.projectCollapse, keys.sessionExpanded, keys.sessionExpandedLegacy, safeStorage, setCollapsedProjects, setExpandedParents]);

  React.useEffect(() => {
    if (!hasAuthoritativeGlobalSessions) {
      return;
    }

    setPinnedSessionIds((prev) => {
      return prunePinnedSessionIds(sessions, prev);
    });
  }, [hasAuthoritativeGlobalSessions, sessions, setPinnedSessionIds]);

  React.useEffect(() => {
    try {
      const serialized = Object.fromEntries(groupOrderByProject.entries());
      safeStorage.setItem(keys.groupOrder, JSON.stringify(serialized));
    } catch {
      // ignored
    }
  }, [groupOrderByProject, keys.groupOrder, safeStorage]);

  React.useEffect(() => {
    try {
      const serialized = Object.fromEntries(activeSessionByProject.entries());
      safeStorage.setItem(keys.projectActiveSession, JSON.stringify(serialized));
    } catch {
      // ignored
    }
  }, [activeSessionByProject, keys.projectActiveSession, safeStorage]);

  React.useEffect(() => {
    try {
      safeStorage.setItem(keys.groupCollapse, JSON.stringify(Array.from(collapsedGroups)));
    } catch {
      // ignored
    }
  }, [collapsedGroups, keys.groupCollapse, safeStorage]);

};
