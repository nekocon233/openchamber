import React from 'react';
import { z } from 'zod';
import { toggleExpandedParentKey } from '../utils';
import type { SessionNode } from '../types';

export const SESSION_EXPANDED_STORAGE_KEY = 'oc.sessions.expandedParents.v3';

const expandedParentsSchema = z.array(z.string());

const readExpandedParents = (): Set<string> => {
  try {
    const raw = globalThis.localStorage.getItem(SESSION_EXPANDED_STORAGE_KEY);
    if (raw === null) return new Set();
    const parsed = expandedParentsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? new Set(parsed.data) : new Set();
  } catch {
    return new Set();
  }
};

export const useExpandedParents = () => {
  const [expandedParents, setExpandedParents] = React.useState(readExpandedParents);
  const expandedParentsRef = React.useRef(expandedParents);
  expandedParentsRef.current = expandedParents;

  const toggleParent = React.useCallback((key: string, node: SessionNode) => {
    const current = expandedParentsRef.current;
    const descendantKeys: string[] = [];
    if (current.has(key)) {
      const contextPrefix = key.slice(0, key.length - node.session.id.length);
      const collectExpandedDescendants = (children: SessionNode[]): void => {
        for (const child of children) {
          const childKey = `${contextPrefix}${child.session.id}`;
          if (current.has(childKey)) descendantKeys.push(childKey);
          collectExpandedDescendants(child.children);
        }
      };
      collectExpandedDescendants(node.children);
    }
    const next = toggleExpandedParentKey(current, key, descendantKeys);
    expandedParentsRef.current = next;
    setExpandedParents(next);
    try {
      globalThis.localStorage.setItem(SESSION_EXPANDED_STORAGE_KEY, JSON.stringify([...next]));
    } catch {
      // The mounted list keeps the user's change; a remount rereads durable storage.
    }
  }, []);

  return { expandedParents, toggleParent };
};
