import React from 'react';
import { DndContext, KeyboardSensor, MouseSensor, TouchSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

type Item = { id: string; label: string; disabled?: boolean };
const SortableRow = ({ item, children }: { item: Item; children: React.ReactNode }) => {
  const { t } = useI18n();
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: item.id, disabled: item.disabled });
  return <div ref={setNodeRef} style={{ transform: CSS.Translate.toString(transform), transition }} className={cn('relative flex min-w-0 items-center', isDragging && 'z-10 opacity-60')}>
    <button type="button" ref={setActivatorNodeRef} {...attributes} {...listeners}
      data-model-picker-sort-handle=""
      disabled={item.disabled} aria-label={t('contextRail.configure.reorder', { label: item.label })}
      onClick={(event) => { event.preventDefault(); event.stopPropagation(); }}
      className="flex h-8 w-6 shrink-0 touch-none select-none items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50">
      <Icon name="draggable" className="size-3.5" />
    </button>
    <div className="min-w-0 flex-1">{children}</div>
  </div>;
};

export function SortablePickerRows<T extends Item>({ items, onReorder, children }: {
  items: T[]; onReorder?: (active: string, over: string) => void; children: (item: T) => React.ReactNode;
}) {
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (over && active.id !== over.id && items.some((item) => item.id === active.id) && items.some((item) => item.id === over.id)) onReorder?.(String(active.id), String(over.id));
  };
  if (!onReorder || items.length < 2) return <>{items.map((item) => <React.Fragment key={item.id}>{children(item)}</React.Fragment>)}</>;
  return <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
    <SortableContext items={items.map((item) => item.id)} strategy={verticalListSortingStrategy}>
      {items.map((item) => <SortableRow key={item.id} item={item}>{children(item)}</SortableRow>)}
    </SortableContext>
  </DndContext>;
}
