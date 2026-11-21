import * as React from 'react';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { TrackerMappingResult } from '@/lib/api/types';
import { useTrackerDescriptor } from '@/lib/trackers/registry';
import { currentTrackerAccountId, useTrackerAuthEntry } from '@/stores/useTrackerAuthStore';

export function useTrackerMapping(provider: string | null, enabled: boolean): TrackerMappingResult | null {
    const { trackers } = useRuntimeAPIs();
    const mapsProjects = useTrackerDescriptor(provider).capabilities.projectMapping;
    const accountId = currentTrackerAccountId(useTrackerAuthEntry(provider));
    const scope = provider ? `${provider}:${accountId}` : '';
    const [loaded, setLoaded] = React.useState<{ scope: string; mapping: TrackerMappingResult } | null>(null);
    React.useEffect(() => {
        if (!enabled || !provider || !mapsProjects || !trackers) return;
        let cancelled = false;
        void trackers.mappingGet(provider)
            .then((mapping) => { if (!cancelled) setLoaded({ scope, mapping }); })
            .catch(() => undefined);
        return () => { cancelled = true; };
    }, [enabled, mapsProjects, provider, scope, trackers]);
    return loaded && loaded.scope === scope ? loaded.mapping : null;
}
