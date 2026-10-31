import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { describe, expect, test } from 'bun:test';
import { I18nProvider } from '@/lib/i18n';
import { ComposerActionButtons } from './ComposerActionButtons';

describe('native follow-up action buttons', () => {
    for (const isMobile of [false, true]) {
        test(`updates the actual click target when steering availability changes (${isMobile ? 'mobile' : 'desktop'})`, async () => {
            const browser = new Window({ url: 'http://fixture.test' });
            const globals = {
                window: browser, document: browser.document, navigator: browser.navigator,
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
                onPrimaryAction: () => { calls.push('send'); },
                onQueueMessage: () => { calls.push('queue'); },
                onAbort: () => { calls.push('stop'); },
            };
            const render = async (followUpDelivery: 'steer' | 'queue', hasContent = true) => {
                await act(async () => root.render(<I18nProvider><ComposerActionButtons {...props} followUpDelivery={followUpDelivery} hasContent={hasContent} /></I18nProvider>));
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
