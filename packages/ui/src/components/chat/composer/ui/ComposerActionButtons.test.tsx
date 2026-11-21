import React, { act } from 'react';
import { Window } from 'happy-dom';
import { describe, expect, test } from 'bun:test';
import { createRoot } from 'react-dom/client';

import { ThemeSystemProvider } from '@/contexts/ThemeSystemContext';
import { I18nProvider } from '@/lib/i18n';
import type { FollowUpBehavior } from '@/stores/messageQueueStore';

import { abortShortcutReachesComposer, type ComposerAbortSurface } from '../state/abortShortcutReach';
import { ComposerActionButtons } from './ComposerActionButtons';

type RenderOptions = {
    canSend?: boolean;
    canAbort?: boolean;
    hasContent?: boolean;
    followUpBehavior?: FollowUpBehavior;
    footerIconButtonClass?: string;
    isMobile?: boolean;
    /** Whether double Escape reaches this composer (abortShortcutReach); on by default. */
    escapeStops?: boolean;
    /** Clicks the only button and counts what it did. */
    click?: boolean;
};

// Renders the control in a desktop footer and reports its buttons.
const renderActions = async (options: RenderOptions) => {
    const win = new Window({ url: 'http://localhost' });
    const values = { window: win, document: win.document, navigator: win.navigator, Element: win.Element, HTMLElement: win.HTMLElement, Node: win.Node, localStorage: win.localStorage, IS_REACT_ACT_ENVIRONMENT: true };
    const previous = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
    const container = document.createElement('div');
    const root = createRoot(container);
    let primaryActions = 0;
    let aborts = 0;
    try {
        await act(async () => root.render(
            <ThemeSystemProvider>
            <I18nProvider>
                <ComposerActionButtons
                    isMobile={options.isMobile ?? false}
                    footerIconButtonClass={options.footerIconButtonClass ?? 'h-6 w-6'}
                    sendIconSizeClass="send-icon-size"
                    stopIconSizeClass="stop-icon-size"
                    canSend={options.canSend ?? true}
                    canAbort={options.canAbort ?? false}
                    followUpDelivery={options.followUpBehavior ?? 'queue'}
                    hasContent={options.hasContent ?? true}
                    currentSessionId="session-1"
                    newSessionDraftOpen={false}
                    onPrimaryAction={() => { primaryActions += 1; }}
                    onAbort={() => { aborts += 1; }}
                    escapeStops={options.escapeStops ?? true}
                />
            </I18nProvider>
            </ThemeSystemProvider>));
        const buttons = [...container.querySelectorAll('button')];
        const result = buttons.map((button) => ({
            label: button.getAttribute('aria-label'),
            type: button.getAttribute('type'),
            disabled: button.disabled,
            classes: button.className.split(/\s+/),
            disc: button.querySelector('.oc-action-disc'),
            discIdle: button.querySelector('.oc-action-disc')?.hasAttribute('data-idle') ?? null,
            markup: button.outerHTML,
        }));
        if (options.click) await act(async () => { buttons[0]?.click(); });
        return { buttons: result, primaryActions, aborts };
    } finally {
        await act(async () => root.unmount());
        for (const [key, descriptor] of previous) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else Reflect.deleteProperty(globalThis, key);
        }
        await win.happyDOM.close();
    }
};

const sizes = (classes: string[]) => classes.filter((name) => /^[hw]-/.test(name)).sort();

describe('ComposerActionButtons', () => {
    test('a draft typed during a run turns the one disc into Send, which queues when follow-ups queue', async () => {
        const { buttons, primaryActions, aborts } = await renderActions({ canAbort: true, followUpBehavior: 'queue', click: true });

        expect(buttons).toHaveLength(1);
        expect(buttons[0]?.label).toBe('Stage message');
        expect(buttons[0]?.type).toBe('button');
        expect(buttons[0]?.markup).toContain('#oc-arrow-up');
        expect(primaryActions).toBe(1);
        expect(aborts).toBe(0);
    });

    test('the same disc steers when follow-ups steer', async () => {
        const { buttons, primaryActions } = await renderActions({ canAbort: true, followUpBehavior: 'steer', click: true });

        expect(buttons).toHaveLength(1);
        expect(buttons[0]?.label).toBe('Send message');
        expect(primaryActions).toBe(1);
    });

    test('a run with an empty input shows Stop in the disc', async () => {
        const { buttons, aborts, primaryActions } = await renderActions({ canAbort: true, hasContent: false, click: true });

        expect(buttons).toHaveLength(1);
        expect(buttons[0]?.label).toBe('Stop generating');
        expect(buttons[0]?.discIdle).toBe(true);
        expect(aborts).toBe(1);
        expect(primaryActions).toBe(0);
    });

    test('with something to send the disc is the full one; with nothing it is the quiet one', async () => {
        const enabled = (await renderActions({ canSend: true })).buttons[0];
        expect(enabled?.disabled).toBe(false);
        expect(enabled?.disc).not.toBeNull();
        expect(enabled?.discIdle).toBe(false);
        expect(enabled?.markup).toContain('#oc-arrow-up');
        expect(enabled?.markup).not.toContain('text-primary');

        const disabled = (await renderActions({ canSend: false, hasContent: false })).buttons[0];
        expect(disabled?.disabled).toBe(true);
        expect(disabled?.discIdle).toBe(true);
        expect(disabled?.markup).not.toContain('opacity-');
    });

    test('Send, its follow-up and Stop share one 28px slot on desktop, whatever size the footer\'s other buttons have', async () => {
        for (const footerIconButtonClass of ['h-6 w-6', 'h-5 w-5']) {
            const states: RenderOptions[] = [
                { canAbort: false },
                { canAbort: true, hasContent: true },
                { canAbort: true, hasContent: false },
            ];
            for (const state of states) {
                const { buttons } = await renderActions({ ...state, footerIconButtonClass });
                expect(buttons).toHaveLength(1);
                expect(sizes(buttons[0]?.classes ?? [])).toEqual(['h-7', 'w-7']);
            }
        }
    });

    // Every surface kind, running with a draft typed: the run stays stoppable
    // with the draft intact, through a wired double Escape (named in the Send
    // tooltip) or a visible Stop beside Send, and Send's disc keeps its slot.
    const surfaces: { name: string; surface: ComposerAbortSurface; touch: boolean; isMobile: boolean }[] = [
        { name: 'main desktop', surface: 'main', touch: false, isMobile: false },
        { name: 'Mini Chat', surface: 'mini-chat', touch: false, isMobile: false },
        { name: 'BTW', surface: 'btw', touch: false, isMobile: false },
        { name: 'touch-only desktop', surface: 'main', touch: true, isMobile: false },
        { name: 'phone', surface: 'main', touch: true, isMobile: true },
        { name: 'a surface not wired yet', surface: 'unknown', touch: false, isMobile: false },
    ];
    for (const kind of surfaces) {
        test(`running with a draft on ${kind.name}: stoppable with the draft kept`, async () => {
            const escapeStops = abortShortcutReachesComposer({ surface: kind.surface, touch: kind.touch });
            const { buttons } = await renderActions({ canAbort: true, hasContent: true, escapeStops, isMobile: kind.isMobile });
            const labels = buttons.map((button) => button.label);
            const send = buttons.find((button) => button.disc);
            expect(send?.label).toBe('Stage message');
            if (escapeStops) {
                expect(['main', 'mini-chat']).toContain(kind.surface);
                expect(labels).toEqual(['Stage message']);
            } else {
                // A bare Stop just before the disc, at the footer's icon size.
                expect(labels).toEqual(['Stop generating', 'Stage message']);
                expect(buttons[0]?.disc).toBeNull();
            }
        });
    }
});

describe('native follow-up action buttons', () => {
    for (const isMobile of [false, true]) {
        test(`updates the actual click target when steering availability changes (${isMobile ? 'mobile' : 'desktop'})`, async () => {
            const browser = new Window({ url: 'http://fixture.test' });
            const globals = {
                window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
                HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node,
                IS_REACT_ACT_ENVIRONMENT: true,
            };
            const previous = new Map(Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
            for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { configurable: true, value });
            const container = document.createElement('div');
            const root = createRoot(container);
            const calls: string[] = [];
            const props = {
                isMobile, footerIconButtonClass: 'button', sendIconSizeClass: 'icon', stopIconSizeClass: 'icon',
                canSend: true, canAbort: true, hasContent: true, currentSessionId: 'ncx_fixture', newSessionDraftOpen: false,
                onAbort: () => { calls.push('stop'); },
            };
            const render = async (followUpDelivery: 'steer' | 'queue', hasContent = true) => {
                await act(async () => root.render(<ThemeSystemProvider><I18nProvider><ComposerActionButtons
                    {...props}
                    followUpDelivery={followUpDelivery}
                    hasContent={hasContent}
                    onPrimaryAction={() => calls.push(followUpDelivery === 'steer' ? 'send' : 'queue')}
                /></I18nProvider></ThemeSystemProvider>));
            };
            const button = (label: string) => container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
            try {
                await render('queue');
                expect(button('Stage message')).not.toBeNull();
                await act(async () => { button('Stage message')?.click(); });
                expect(calls).toEqual(['queue']);

                await render('steer');
                expect(button('Stage message')).toBeNull();
                expect(button('Send message')).not.toBeNull();
                await act(async () => { button('Send message')?.click(); });
                await act(async () => { button('Stop generating')?.click(); });
                expect(calls).toEqual(['queue', 'send', 'stop']);

                await render('queue');
                expect(button('Send message')).toBeNull();
                await act(async () => { button('Stage message')?.click(); });
                expect(calls).toEqual(['queue', 'send', 'stop', 'queue']);

                await render('steer', false);
                expect(button('Send message')).toBeNull();
                expect(button('Stage message')).toBeNull();
                expect(button('Stop generating')).not.toBeNull();
            } finally {
                await act(async () => root.unmount());
                for (const [name, descriptor] of previous) {
                    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
                    else Reflect.deleteProperty(globalThis, name);
                }
                await browser.happyDOM.close();
            }
        });
    }
});
