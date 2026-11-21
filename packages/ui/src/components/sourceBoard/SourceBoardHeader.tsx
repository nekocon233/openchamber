import * as React from 'react';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { MOBILE_HEADER_BUTTON_CLASS, MOBILE_HEADER_CLASS } from '@/components/ui/mobileHeader';

export const MobileBoardHeader: React.FC<{ onClose?: () => void; onBack?: () => void; children?: React.ReactNode }> = ({ onClose, onBack, children }) => {
    const { t } = useI18n();
    const action = onBack ?? onClose;
    return (
        <header className={cn(MOBILE_HEADER_CLASS, 'border-b border-edge')}>
            {action ? (
                <button
                    type="button"
                    className={MOBILE_HEADER_BUTTON_CLASS}
                    aria-label={onBack ? t('references.picker.actions.back') : t('mobile.surface.closeAria')}
                    onClick={action}
                    style={{ touchAction: 'manipulation' }}
                >
                    <Icon name={onBack ? 'arrow-left' : 'close'} className="size-5" />
                </button>
            ) : null}
            <div className="flex min-w-0 flex-1 items-center">{children}</div>
        </header>
    );
};
