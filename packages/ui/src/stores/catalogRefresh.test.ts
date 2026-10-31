import { beforeEach, describe, expect, spyOn, test } from "bun:test";

import { QUOTA_PROVIDERS } from "@/lib/quota/providers";
import { catalogRefreshTasks } from "./catalogRefresh";
import { useQuotaStore } from "./useQuotaStore";

describe("catalogRefreshTasks", () => {
  test("a config rebuild re-reads every list a config file can carry", () => {
    // Agents, commands, skills, MCP servers, plugins and providers all live
    // in config, and OpenChamber's own plugin injection is one of them. So
    // does the web search choice.
    expect(catalogRefreshTasks("config")).toHaveLength(7);
  });

  test("a single-catalog rebuild re-reads only that list", () => {
    for (const kind of ["agent", "command", "skill", "plugin", "provider", "websearch", "native-model"] as const) {
      expect(catalogRefreshTasks(kind)).toHaveLength(1);
    }
  });

  test("a credential change re-reads providers, web search keys and usage", () => {
    expect(catalogRefreshTasks("credential")).toHaveLength(3);
  });

  test("projects belong to the sync stores, not to the settings lists", () => {
    expect(catalogRefreshTasks("project")).toEqual([]);
  });
});

describe("the usage task on a credential change", () => {
  const usageTask = () => catalogRefreshTasks("credential")[2];
  const shown = (ids: string[]) => {
    useQuotaStore.setState({
      // SAFETY: the fixture carries the fields these tests read; the store
      // holds the wider `ProviderResult` shape and never inspects the rest.
      results: ids.map((providerId) => ({
        providerId, providerName: providerId, ok: true, configured: true, usage: null, fetchedAt: 1,
      })) as ReturnType<typeof useQuotaStore.getState>["results"],
    });
  };

  beforeEach(() => {
    useQuotaStore.setState({
      results: [],
      // The instance-level load flag stays null on runtimes that never call
      // `ensureLoadedForRuntime`, which is exactly how the VS Code layout loads.
      loadedRuntimeKey: null,
      loadCachedClaudeQuota: async () => true,
      dropdownProviderIds: QUOTA_PROVIDERS.map((provider) => provider.id),
    });
  });

  test("refreshes the shown trackers even when the instance load flag is unset", async () => {
    // The reported bug: switching an account in the extension refreshed
    // nothing, because that runtime never sets `loadedRuntimeKey`.
    const asked: string[][] = [];
    useQuotaStore.setState({
      // SAFETY: the mock implements only the action surface the task calls.
      fetchQuotas: (async (ids: string[]) => { asked.push(ids); return true; }) as never,
    });
    shown(["ollama-cloud"]);

    await usageTask()();

    expect(asked).toEqual([["ollama-cloud"]]);
  });

  test("only the trackers already on screen, never the full default list", async () => {
    const asked: string[][] = [];
    useQuotaStore.setState({
      // SAFETY: the mock implements only the action surface the task calls.
      fetchQuotas: (async (ids: string[]) => { asked.push(ids); return true; }) as never,
    });
    shown(["ollama-cloud", "claude"]);
    useQuotaStore.setState({ dropdownProviderIds: ["ollama-cloud"] });

    await usageTask()();

    expect(asked).toEqual([["ollama-cloud"]]);
  });

  test("asks nothing when no tracker has been fetched yet", async () => {
    let called = false;
    useQuotaStore.setState({
      // SAFETY: the mock implements only the action surface the task calls.
      fetchQuotas: (async () => { called = true; return true; }) as never,
    });

    await usageTask()();

    // Nothing is on screen to update, and the provider list is still its
    // default of every tracker rather than the user's selection.
    expect(called).toBe(false);
  });

  test("clears Claude and refreshes other shown providers without querying Claude", async () => {
    const asked: string[][] = [];
    useQuotaStore.setState({ fetchQuotas: async ids => { asked.push(ids); return true; } });
    shown(["claude", "codex"]);
    const codex = useQuotaStore.getState().results[1];
    await usageTask()();
    expect(asked).toEqual([["codex"]]);
    expect(useQuotaStore.getState().results).toEqual([codex]);
  });

  test("aborts a first manual Claude read when the credential changes", async () => {
    let complete: ((response: Response) => void) | undefined;
    const network = spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    try {
      const pending = useQuotaStore.getState().fetchProviderQuota('claude');
      await Promise.resolve();
      await usageTask()();
      expect(await pending).toBe(false);
      expect(network.mock.calls).toHaveLength(1);
      expect(useQuotaStore.getState().results).toEqual([]);
    } finally {
      complete?.(Response.json({}));
      network.mockRestore();
    }
  });

  test("a switch invalidates, so the previous account's sample is not kept", async () => {
    let invalidate: boolean | undefined;
    useQuotaStore.setState({
      // SAFETY: the mock implements only the action surface the task calls.
      fetchQuotas: (async (_ids: string[], options?: { invalidate?: boolean }) => {
        invalidate = options?.invalidate;
        return true;
      }) as never,
    });
    shown(["ollama-cloud"]);

    await usageTask()();

    expect(invalidate).toBe(true);
  });
});
