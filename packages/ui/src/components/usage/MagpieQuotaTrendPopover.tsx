import React from 'react';
import { Popover } from '@base-ui/react/popover';
import { Icon } from '@/components/icon/Icon';
import { WorkStatusTouchContext } from '@/components/chat/work-status/touchContext';
import { GlassRedrawGuard } from '@/components/ui/glass-redraw-guard';
import { dropdownMenuPopupClass } from '@/components/ui/dropdown-menu.styles';
import { getCurrentIntlLocale, useI18n } from '@/lib/i18n';
import { magpieDisplayPercent, magpiePaceDifference, magpieReferenceLeft } from '@/lib/quota/magpie';
import { formatDateTimeForPreference } from '@/lib/timeFormat';
import { cn } from '@/lib/utils';
import { useQuotaStore } from '@/stores/useQuotaStore';
import { useUIStore } from '@/stores/useUIStore';
import type { MagpieQuotaTrend } from '@/types/quota';

const CHART_WIDTH = 256;
const CHART_HEIGHT = 78;
const INSET = 4;

function MagpieTrendChart({ trend }: { trend: MagpieQuotaTrend }) {
  const { t } = useI18n();
  const timeFormat = useUIStore(state => state.timeFormatPreference);
  const showRemaining = useQuotaStore(state => state.displayMode === 'remaining');
  const [sampleIndex, setSampleIndex] = React.useState<number | null>(null);
  const { points, cycle } = trend;
  const first = points[0];
  const latest = points.at(-1);
  if (!first || !latest) return null;

  const index = Math.min(sampleIndex ?? points.length - 1, points.length - 1);
  const sample = points[index] ?? latest;
  const start = cycle?.start ?? first.at;
  const end = cycle?.reset ?? latest.at;
  const available = end > start;
  const x = (at: number) => INSET + (CHART_WIDTH - 2 * INSET) * (at - start) / (end - start);
  const y = (value: number) => INSET + (CHART_HEIGHT - 2 * INSET) * (100 - value) / 100;
  const display = (left: number) => magpieDisplayPercent(left, showRemaining);
  const sampleY = (left: number) => y(display(left));

  const pacePercentages = new Intl.NumberFormat(getCurrentIntlLocale(), { style: 'percent', maximumSignificantDigits: 3 });
  const percentages = new Intl.NumberFormat(getCurrentIntlLocale(), { style: 'percent', maximumFractionDigits: 1 });
  const percent = (value: number) => percentages.format(value / 100);
  const stamp = (at: number) => formatDateTimeForPreference(at, timeFormat, {
    month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
  const reference = cycle ? magpieReferenceLeft(cycle, sample.at) : null;
  const readingAt = stamp(sample.at);
  const actual = percent(display(sample.left));
  const reading = reference === null
    ? t(showRemaining ? 'chat.workStatus.magpie.trend.reading' : 'chat.workStatus.magpie.trend.usageReading', { at: readingAt, actual })
    : t(showRemaining ? 'chat.workStatus.magpie.trend.comparison' : 'chat.workStatus.magpie.trend.usageComparison', {
      at: readingAt, actual, reference: percent(display(reference)),
    });
  const actualLabel = t(showRemaining ? 'chat.workStatus.magpie.trend.actual' : 'chat.workStatus.magpie.trend.actualUsage');
  const referenceLabel = t(showRemaining ? 'chat.workStatus.magpie.trend.reference' : 'chat.workStatus.magpie.trend.referenceUsage');
  const difference = reference === null ? null : magpiePaceDifference(reference, sample.left);
  const summary = difference === null
    ? t('chat.workStatus.magpie.trend.unknownCycle')
    : difference === 0 ? t('chat.workStatus.magpie.trend.onPace') : t(
      difference > 0 ? 'chat.workStatus.magpie.trend.ahead' : 'chat.workStatus.magpie.trend.behind',
      { difference: pacePercentages.format(Math.abs(difference) / 100) },
    );

  const inspect = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!available) return;
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width === 0) return;
    const position = (event.clientX - box.left) / box.width * CHART_WIDTH;
    const at = start + (end - start) * (position - INSET) / (CHART_WIDTH - 2 * INSET);
    const nearest = points.reduce((best, point, candidate) =>
      Math.abs(point.at - at) < Math.abs((points[best] ?? first).at - at) ? candidate : best, 0);
    setSampleIndex(nearest);
  };
  const step = (event: React.KeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case 'Home': setSampleIndex(0); break;
      case 'End': setSampleIndex(null); break;
      case 'ArrowLeft':
      case 'ArrowDown': setSampleIndex(Math.max(0, index - 1)); break;
      case 'ArrowRight':
      case 'ArrowUp': setSampleIndex(Math.min(points.length - 1, index + 1)); break;
      default: return;
    }
    event.preventDefault();
  };

  return (
    <div className="typography-micro tabular-nums">
      <p className="text-foreground">{summary}</p>
      <p className="mt-0.5 text-muted-foreground" data-magpie-trend-reading>{reading}</p>
      {available && <>
        <div dir="ltr" className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] items-stretch gap-x-2 gap-y-0.5">
          <div aria-hidden className="flex flex-col justify-between text-end leading-none text-muted-foreground">
            {[100, 50, 0].map(left => <span key={left}>{percent(left)}</span>)}
          </div>
          <div
            role="slider"
            tabIndex={0}
            aria-label={actualLabel}
            aria-valuemin={1}
            aria-valuemax={points.length}
            aria-valuenow={index + 1}
            aria-valuetext={reading}
            className="min-w-0 touch-pan-y rounded-sm focus-visible:bg-interactive-hover"
            onPointerMove={event => { if (event.pointerType === 'mouse') inspect(event); }}
            onPointerDown={inspect}
            onPointerLeave={event => { if (event.pointerType === 'mouse') setSampleIndex(null); }}
            onKeyDown={step}
          >
            <svg aria-hidden viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`} preserveAspectRatio="none" className="block h-[78px] w-full">
              {[100, 50, 0].map(left => (
                <line key={left} x1={x(start)} x2={x(end)} y1={y(left)} y2={y(left)}
                  className="stroke-[var(--interactive-border)]" vectorEffect="non-scaling-stroke" />
              ))}
              {cycle && <line x1={x(start)} x2={x(end)} y1={sampleY(100)} y2={sampleY(0)}
                strokeDasharray="4 3" className="stroke-muted-foreground" vectorEffect="non-scaling-stroke" />}
              <line x1={x(sample.at)} x2={x(sample.at)} y1={y(100)} y2={y(0)}
                className="stroke-muted-foreground opacity-45" vectorEffect="non-scaling-stroke" />
              <polyline points={points.map(point => `${x(point.at)},${sampleY(point.left)}`).join(' ')}
                fill="none" className="stroke-[var(--status-info)]" strokeWidth={1.75} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
              <circle cx={x(sample.at)} cy={sampleY(sample.left)} r={2.75} className="fill-[var(--status-info)]" />
            </svg>
          </div>
          <div className="col-start-2 flex justify-between gap-2 text-muted-foreground">
            <span className="truncate" title={stamp(start)}>{stamp(start)}</span>
            <span className="truncate text-end" title={stamp(end)}>{stamp(end)}</span>
          </div>
        </div>
        <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <i aria-hidden className="w-3 border-t-2 border-[var(--status-info)]" />
            {actualLabel}
          </span>
          {cycle && <span className="inline-flex items-center gap-1">
            <i aria-hidden className="w-3 border-t border-dashed border-current" />
            {referenceLabel}
          </span>}
        </div>
      </>}
    </div>
  );
}

export function MagpieQuotaTrendPopover({ trend, label, rowLabel, mobile, children }: {
  trend: MagpieQuotaTrend | null;
  label: string;
  rowLabel: string;
  mobile: boolean;
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  const touchLayout = React.useContext(WorkStatusTouchContext);
  return (
    <Popover.Root onOpenChange={(_open, details) => {
      if (details.reason === 'escape-key') details.event.preventDefault();
    }}>
      <div className="group relative">
        <Popover.Trigger
          aria-label={t('chat.workStatus.magpie.trend.open', { row: rowLabel })}
          openOnHover
          delay={200}
          closeDelay={120}
          className="absolute inset-0 w-full cursor-pointer rounded-md focus-visible:bg-interactive-hover"
        />
        <div className="pointer-events-none">{children}</div>
      </div>
      <Popover.Portal>
        <Popover.Positioner side={touchLayout || mobile ? 'top' : 'inline-start'} align="start" sideOffset={6} collisionPadding={8} className="z-[75]">
          <Popover.Popup
            data-work-status-popup
            data-magpie-quota-trend
            initialFocus={method => method === 'keyboard'}
            className={cn(dropdownMenuPopupClass, 'w-[19rem] max-w-[calc(100dvw-1rem)] overflow-y-auto p-3 text-start')}
          >
            <GlassRedrawGuard />
            <Popover.Title className="mb-1 flex min-w-0 items-center gap-1.5 typography-ui-label font-medium">
              <Icon name="line-chart" className="size-[13px] shrink-0 text-muted-foreground" />
              <span dir="auto" className="truncate oc-ui-start-align" title={label}>{label}</span>
            </Popover.Title>
            {trend ? <MagpieTrendChart trend={trend} /> : (
              <p className="typography-meta text-muted-foreground">{t('chat.workStatus.magpie.trend.unavailable')}</p>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
