import { cn } from '@/lib/utils';
import { Text } from '@/components/ui/text';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { TOOL_ROW_DESCRIPTION_CLASS } from './toolRowStyles';

export const renderPathLikeGitChanges = (path: string, grow = true) => {
    const lastSlash = path.lastIndexOf('/');
    if (lastSlash === -1) {
        return (
            <span
                className={cn('oc-ui-start-align min-w-0 truncate typography-ui-label text-foreground', grow && 'flex-1')}
                style={{ direction: 'rtl', unicodeBidi: 'isolate' }}
                title={path}
            >
                <bdi dir="ltr">{path}</bdi>
            </span>
        );
    }

    const dir = path.slice(0, lastSlash + 1);
    const name = path.slice(lastSlash + 1);

    return (
        <span dir="ltr" className={cn('min-w-0 flex items-baseline overflow-hidden typography-ui-label', grow && 'flex-1')} title={path}>
            <span className="min-w-0 truncate text-muted-foreground" style={{ direction: 'rtl', unicodeBidi: 'isolate' }}>
                <bdi dir="ltr">{dir}</bdi>
            </span>
            <span className="min-w-0 max-w-full shrink-0 truncate text-foreground" style={{ direction: 'rtl', unicodeBidi: 'isolate' }}>
                <bdi dir="ltr">{name}</bdi>
            </span>
        </span>
    );
};

export const renderAnimatedPathWithIcon = (path: string, animate = true, grow = true, showFileIcons = true, textClassName = TOOL_ROW_DESCRIPTION_CLASS) => {
    const lastSlash = path.lastIndexOf('/');

    if (lastSlash === -1) {
        return (
            <span className={cn('min-w-0 inline-flex items-center gap-1 overflow-hidden', grow && 'flex-1')} title={path}>
                {showFileIcons ? <FileTypeIcon filePath={path} className="h-3.5 w-3.5 flex-shrink-0" /> : null}
                <Text
                    variant={animate ? 'generate-effect' : 'static'}
                    className={cn('min-w-0 truncate whitespace-nowrap', textClassName, grow && 'flex-1')}
                    style={{ color: 'var(--tools-title)', direction: 'rtl', unicodeBidi: 'isolate' }}
                >
                    <bdi dir="ltr">{path}</bdi>
                </Text>
            </span>
        );
    }

    const dir = path.slice(0, lastSlash + 1);
    const name = path.slice(lastSlash + 1);

    return (
        <span className={cn('min-w-0 inline-flex items-center gap-1 overflow-hidden', grow && 'flex-1')} title={path}>
            {showFileIcons ? <FileTypeIcon filePath={path} className="h-3.5 w-3.5 flex-shrink-0" /> : null}
            <span dir="ltr" className={cn('min-w-0 inline-flex max-w-full items-baseline overflow-hidden', textClassName, grow && 'flex-1')}>
                <span
                    className="min-w-0 shrink truncate whitespace-nowrap"
                    style={{
                        color: 'var(--tools-description)',
                        direction: 'rtl',
                        unicodeBidi: 'isolate',
                    }}
                >
                    <bdi dir="ltr">{dir}</bdi>
                </span>
                <Text
                    variant={animate ? 'generate-effect' : 'static'}
                    className="min-w-0 max-w-full shrink-0 truncate"
                    style={{ color: 'var(--tools-title)', direction: 'rtl', unicodeBidi: 'isolate' }}
                >
                    <bdi dir="ltr">{name}</bdi>
                </Text>
            </span>
        </span>
    );
};
