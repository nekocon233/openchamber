import React from 'react';
import { OpenChamberVisualSettings } from './OpenChamberVisualSettings';
import { SessionRetentionSettings } from './SessionRetentionSettings';
import { FinishedWorktreesSettings } from './FinishedWorktreesSettings';
import { SessionWorkSettings } from './SessionWorkSettings';
import { PasskeySettings } from './PasskeySettings';
import { AppLinkSecuritySettings } from './AppLinkSecuritySettings';
import { DefaultsSettings, SessionContextSettings } from './DefaultsSettings';
import { AgentCombinationsSettings } from './AgentCombinationsSettings';
import { OpenCodeCliSettings } from './OpenCodeCliSettings';
import { EnvironmentVariablesSettings } from './EnvironmentVariablesSettings';
import { IsolatedSpacesSettings } from './IsolatedSpacesSettings';
import { OpenChamberToolsSettings } from './OpenChamberToolsSettings';
import { DesktopNetworkSettings } from './DesktopNetworkSettings';
import { DesktopAppSettings, DesktopQuickAccessSettings } from './DesktopAppSettings';
import { ChatSettings } from './ChatSettings';
import { GeneralConnectionAndPrivacySettings, GeneralFilesAndTerminalSettings, GeneralInterfaceSettings } from './GeneralWorkspaceSettings';
import { MobileAppSettings } from './MobileAppSettings';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { isDesktopLocalOriginActive, isDesktopShell, isVSCodeRuntime, isWebRuntime } from '@/lib/desktop';
import { isCapacitorApp } from '@/lib/platform';
import { useI18n } from '@/lib/i18n';
import { subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { lazyWithChunkRecovery } from '@/lib/chunkLoadRecovery';
import type { OpenChamberSection } from './types';

const GitSettings = lazyWithChunkRecovery(() => import('./GitSettings').then((m) => ({ default: m.GitSettings })));
const NotificationSettings = lazyWithChunkRecovery(() => import('./NotificationSettings').then((m) => ({ default: m.NotificationSettings })));
const VoiceSettings = lazyWithChunkRecovery(() => import('./VoiceSettings').then((m) => ({ default: m.VoiceSettings })));
const TunnelSettings = lazyWithChunkRecovery(() => import('./TunnelSettings').then((m) => ({ default: m.TunnelSettings })));
const KeyboardShortcutsSettings = lazyWithChunkRecovery(() => import('./KeyboardShortcutsSettings').then((m) => ({ default: m.KeyboardShortcutsSettings })));

const useRuntimeEndpointEpoch = (): number => {
    const [epoch, setEpoch] = React.useState(0);

    React.useEffect(() => {
        return subscribeRuntimeEndpointChanged(() => setEpoch((current) => current + 1));
    }, []);

    return epoch;
};

interface OpenChamberPageProps {
    section: OpenChamberSection;
}

export const OpenChamberPage: React.FC<OpenChamberPageProps> = ({ section }) => {
    const { t } = useI18n();
    const runtimeEndpointEpoch = useRuntimeEndpointEpoch();

    const renderSectionContent = () => {
        switch (section) {
            case 'general':
                return <GeneralSectionContent />;
            case 'visual':
                return <VisualSectionContent />;
            case 'chat':
                return <ChatSectionContent />;
            case 'sessions':
                return <SessionsSectionContent runtimeEndpointEpoch={runtimeEndpointEpoch} />;
            case 'shortcuts':
                return <ShortcutsSectionContent />;
            case 'git':
                return <GitSectionContent />;
            case 'notifications':
                return <NotificationSectionContent />;
            case 'voice':
                return <VoiceSectionContent />;
            case 'tunnel':
                return <TunnelSectionContent />;
            case 'spaces':
                return <SpacesSectionContent />;
            default:
                return null;
        }
    };

    const pageTitle = {
        general: t('settings.page.general.title'),
        visual: t('settings.page.appearance.title'),
        chat: t('settings.page.chat.title'),
        sessions: t('settings.page.sessions.title'),
        shortcuts: t('settings.page.shortcuts.title'),
        git: t('settings.page.git.title'),
        github: t('settings.page.git.title'),
        notifications: t('settings.page.notifications.title'),
        voice: t('settings.page.voice.title'),
        tunnel: t('settings.page.tunnel.title'),
        spaces: t('settings.openchamber.spaces.title'),
    }[section];

    return (
        <SettingsPageLayout
            title={pageTitle}
            namedBySidebar
            showSaveStatus
            className="openchamber-page-body"
        >
            {renderSectionContent()}
        </SettingsPageLayout>
    );
};

const wrapLazySection = (node: React.ReactNode) => (
    <ErrorBoundary>
        <React.Suspense fallback={null}>{node}</React.Suspense>
    </ErrorBoundary>
);

const ShortcutsSectionContent: React.FC = () => {
    return wrapLazySection(<KeyboardShortcutsSettings />);
};

const GeneralSectionContent: React.FC = () => {
    const isVSCode = isVSCodeRuntime();
    const runtimeEndpointEpoch = useRuntimeEndpointEpoch();
    const isLocalDesktop = isDesktopShell() && isDesktopLocalOriginActive();
    const showPasskeySettings = isWebRuntime() && !isDesktopShell() && !isVSCode && !isCapacitorApp();
    return (
        <>
            {isDesktopShell() && <DesktopAppSettings />}
            <MobileAppSettings />
            {!isVSCode && <OpenChamberToolsSettings />}
            {isLocalDesktop && <DesktopNetworkSettings />}
            {showPasskeySettings && <PasskeySettings />}
            <GeneralInterfaceSettings />
            {!isVSCode && <OpenChamberVisualSettings visibleSettings={['workspaceLayout']} />}
            {isLocalDesktop && <DesktopQuickAccessSettings />}
            {!isVSCode && <OpenCodeCliSettings />}
            {!isVSCode && <EnvironmentVariablesSettings key={runtimeEndpointEpoch} />}
            <GeneralFilesAndTerminalSettings />
            <AppLinkSecuritySettings />
            <GeneralConnectionAndPrivacySettings />
        </>
    );
};

const VisualSectionContent: React.FC = () => {
    const isVSCode = isVSCodeRuntime();
    return <OpenChamberVisualSettings visibleSettings={[
        'theme',
        'windowControlsPosition',
        'pwaInstallName',
        'pwaOrientation',
        'mobileKeyboardMode',
        'timeFormat',
        ...(!isVSCode ? ['weekStart' as const] : []),
        'fontSize',
        'terminalFontSize',
        'editorFontSize',
        'spacing',
        'scrollbars',
        'inputBarOffset',
        'animatedActivityIndicators',
    ]} />;
};

const ChatSectionContent: React.FC = () => (
    <>
        <ChatSettings />
        <OpenChamberVisualSettings visibleSettings={['conciseTranscript', 'transcriptFileChangesOnly']} />
    </>
);

const SessionsSectionContent: React.FC<{ runtimeEndpointEpoch: number }> = ({ runtimeEndpointEpoch }) => {
    return (
        <>
            <DefaultsSettings key={`defaults-${runtimeEndpointEpoch}`} />
            {!isVSCodeRuntime() && <AgentCombinationsSettings />}
            <SessionWorkSettings />
            <SessionRetentionSettings />
            {!isVSCodeRuntime() && <FinishedWorktreesSettings />}
            <SessionContextSettings key={`context-${runtimeEndpointEpoch}`} />
        </>
    );
};

const GitSectionContent: React.FC = () => {
    return wrapLazySection(<GitSettings />);
};

const NotificationSectionContent: React.FC = () => {
    return wrapLazySection(<NotificationSettings />);
};

const VoiceSectionContent: React.FC = () => {
    if (isVSCodeRuntime()) {
        return null;
    }
    return wrapLazySection(<VoiceSettings />);
};

const SpacesSectionContent: React.FC = () => {
    if (isVSCodeRuntime()) {
        return null;
    }
    return <IsolatedSpacesSettings />;
};

const TunnelSectionContent: React.FC = () => wrapLazySection(<TunnelSettings />);
