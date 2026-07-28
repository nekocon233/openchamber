import React from 'react';

type SafeStorageLike = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
};

type Keys = {
  sessionExpanded: string;
  projectCollapse: string;
  groupOrder: string;
  groupCollapse: string;
};

type Args = {
  safeStorage: SafeStorageLike;
  keys: Keys;
  groupOrderByProject: Map<string, string[]>;
  collapsedGroups: Set<string>;
  setExpandedParents: React.Dispatch<React.SetStateAction<Set<string>>>;
  setCollapsedProjects: React.Dispatch<React.SetStateAction<Set<string>>>;
};

export const useSidebarPersistence = (args: Args) => {
  const {
    safeStorage,
    keys,
    groupOrderByProject,
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
  }, [keys.projectCollapse, keys.sessionExpanded, safeStorage, setCollapsedProjects, setExpandedParents]);

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
      safeStorage.setItem(keys.groupCollapse, JSON.stringify(Array.from(collapsedGroups)));
    } catch {
      // ignored
    }
  }, [collapsedGroups, keys.groupCollapse, safeStorage]);

};
