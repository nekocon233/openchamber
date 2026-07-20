import { afterEach, describe, expect, it, vi } from 'vitest';

import { createNotificationTriggerRuntime } from './runtime.js';

const createRuntime = ({ sendPushToAllUiSessions, sendApnsToAllUiSessions }) => createNotificationTriggerRuntime({
  readSettingsFromDisk: async () => ({
    nativeNotificationsEnabled: false,
    notificationMode: 'always',
    notifyOnCompletion: true,
    notifyOnSubtasks: true,
    notificationTemplates: {},
  }),
  prepareNotificationLastMessage: async () => '',
  buildTemplateVariables: async () => ({ session_name: 'Test session' }),
  extractLastMessageText: () => '',
  fetchLastAssistantMessageText: async () => '',
  resolveNotificationTemplate: (template) => template,
  shouldApplyResolvedTemplateMessage: () => true,
  emitDesktopNotification: () => false,
  broadcastUiNotification: () => {},
  sendPushToAllUiSessions,
  sendApnsToAllUiSessions,
  isAnyInteractiveClientVisible: () => false,
  buildOpenCodeUrl: (path) => `https://opencode.example${path}`,
  getOpenCodeAuthHeaders: () => ({}),
});

describe('notification trigger directory context', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('prefers the global event directory for web targets while keeping native payloads opaque', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
    const sendPushToAllUiSessions = vi.fn(async () => undefined);
    const sendApnsToAllUiSessions = vi.fn(async () => undefined);
    const runtime = createRuntime({ sendPushToAllUiSessions, sendApnsToAllUiSessions });

    await runtime.maybeSendPushForTrigger({
      type: 'message.updated',
      properties: {
        directory: '/stale-directory',
        info: {
          sessionID: 'ses_outer_directory',
          role: 'assistant',
          finish: 'stop',
          mode: 'build',
          modelID: 'test-model',
        },
      },
    }, 'C:\\work\\project');

    expect(sendPushToAllUiSessions).toHaveBeenCalledTimes(1);
    const webPayload = sendPushToAllUiSessions.mock.calls[0][0];
    expect(webPayload.data.directory).toBe('C:\\work\\project');
    const target = new URL(webPayload.data.url, 'https://openchamber.example');
    expect(target.searchParams.get('session')).toBe('ses_outer_directory');
    expect(target.searchParams.get('directory')).toBe('C:\\work\\project');

    expect(sendApnsToAllUiSessions).toHaveBeenCalledTimes(1);
    expect(sendApnsToAllUiSessions.mock.calls[0][0].data).toEqual({
      sessionId: 'ses_outer_directory',
    });
  });

  it('preserves the directory while converting idle events into completion notifications', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
    const sendPushToAllUiSessions = vi.fn(async () => undefined);
    const runtime = createRuntime({
      sendPushToAllUiSessions,
      sendApnsToAllUiSessions: vi.fn(async () => undefined),
    });

    await runtime.maybeSendPushForTrigger({
      type: 'session.idle',
      properties: { sessionID: 'ses_idle' },
    }, '/workspace/idle');

    expect(sendPushToAllUiSessions.mock.calls[0][0].data).toMatchObject({
      sessionId: 'ses_idle',
      directory: '/workspace/idle',
    });
  });
});
