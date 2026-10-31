import { matchesRankQuery } from '@/lib/search/fuzzySearch';
import React from 'react';
import {
  DndContext,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy, arrayMove } from '@dnd-kit/sortable';
import { CSS as DndCSS } from '@dnd-kit/utilities';

import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { isIMECompositionEvent } from '@/lib/ime';
import { PROJECT_TODO_TEXT_MAX_LENGTH, type ProjectTodoChange, type ProjectTodoItem } from '@/lib/projectContextApi';
import { cn } from '@/lib/utils';
import { KnowledgeComposer } from './KnowledgeComposer';
import { KNOWLEDGE_ICON_BUTTON_CLASS, useKnowledgeRevealClass } from './knowledgeRowStyle';
import { KnowledgeMenu } from './KnowledgeActions';

const createTodoId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `todo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
};

const sortTodosWithCompletedLast = (items: ProjectTodoItem[]): ProjectTodoItem[] => [
  ...items.filter((todo) => !todo.completed),
  ...items.filter((todo) => todo.completed),
];

const insertTodoBeforeCompleted = (items: ProjectTodoItem[], item: ProjectTodoItem): ProjectTodoItem[] => {
  const firstCompletedIndex = items.findIndex((todo) => todo.completed);
  if (firstCompletedIndex === -1) {
    return [...items, item];
  }
  return [...items.slice(0, firstCompletedIndex), item, ...items.slice(firstCompletedIndex)];
};

type SortableTodoHandleProps = {
  attributes: ReturnType<typeof useSortable>['attributes'];
  listeners: ReturnType<typeof useSortable>['listeners'];
  setActivatorNodeRef: ReturnType<typeof useSortable>['setActivatorNodeRef'];
  isDragging: boolean;
};

const SortableTodoItem: React.FC<{
  id: string;
  disabled: boolean;
  children: (dragHandleProps: SortableTodoHandleProps) => React.ReactNode;
}> = ({ id, disabled, children }) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled });

  return (
    <li
      ref={setNodeRef}
      style={{
        transform: DndCSS.Translate.toString(transform),
        transition,
      }}
      className={cn(isDragging && 'opacity-60')}
    >
      {children({ attributes, listeners, setActivatorNodeRef, isDragging })}
    </li>
  );
};

const TodoEditor: React.FC<{
  initialText: string;
  disabled: boolean;
  saving: boolean;
  onSave: (text: string) => void;
  onCancel: () => void;
}> = ({ initialText, disabled, saving, onSave, onCancel }) => {
  const { t } = useI18n();
  const [text, setText] = React.useState(initialText);
  const field = React.useRef<HTMLTextAreaElement>(null);
  React.useEffect(() => {
    field.current?.focus();
    const length = field.current?.value.length ?? 0;
    field.current?.setSelectionRange(length, length);
  }, []);
  const save = () => { if (!disabled && !saving && text.trim()) onSave(text.trim()); };
  return <form className="min-w-0 flex-1 space-y-2 py-1" aria-busy={saving} onSubmit={event => { event.preventDefault(); save(); }}>
    <Textarea
      ref={field}
      value={text}
      onChange={event => setText(event.target.value)}
      aria-label={t('rightSidebar.contextNotesTodo.todo.editorLabel')}
      dir="auto"
      maxLength={PROJECT_TODO_TEXT_MAX_LENGTH}
      rows={3}
      disabled={disabled || saving}
      onKeyDown={event => {
        if (isIMECompositionEvent(event)) return;
        if (event.key === 'Escape' && !saving) {
          event.preventDefault(); event.stopPropagation(); onCancel();
        } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
          event.preventDefault(); save();
        }
      }}
    />
    <div className="flex justify-end gap-2">
      <Button type="button" size="sm" variant="ghost" disabled={saving} onClick={onCancel}>{t('rightSidebar.contextNotesTodo.todo.cancel')}</Button>
      <Button type="submit" size="sm" disabled={disabled || saving || !text.trim()}>
        {saving ? <Icon name="loader-4" className="size-3.5 animate-spin" /> : null}
        {t('rightSidebar.contextNotesTodo.todo.save')}
      </Button>
    </div>
  </form>;
};

export const TodosSection: React.FC<{
  todos: ProjectTodoItem[];
  /** Panel-wide filter. Mutations still act on the full list. */
  query: string;
  disabled: boolean;
  canCreateWorktree: boolean;
  sendingTodoId: string | null;
  /**
   * Shows `next` and persists it through the container's store write: one
   * todo when `change` names it, otherwise the whole list.
   */
  onPersistTodos: (next: ProjectTodoItem[], change?: ProjectTodoChange) => Promise<boolean>;
  onSendToCurrentSession: (todoId: string, todoText: string) => void;
  onSendToNewSession: (todoId: string, todoText: string) => void;
  onSendToNewWorktreeSession: (todoId: string, todoText: string) => void;
}> = ({
  todos,
  query,
  disabled,
  canCreateWorktree,
  sendingTodoId,
  onPersistTodos,
  onSendToCurrentSession,
  onSendToNewSession,
  onSendToNewWorktreeSession,
}) => {
  const { t } = useI18n();
  const [expandedTodoIds, setExpandedTodoIds] = React.useState<Set<string>>(() => new Set());
  const [editingTodoId, setEditingTodoId] = React.useState<string | null>(null);
  const [savingEdit, setSavingEdit] = React.useState(false);
  const reveal = useKnowledgeRevealClass();
  const blocked = disabled || savingEdit;

  const handleEditTodo = async (id: string, text: string) => {
    if (blocked || !text.trim()) return;
    const todo = todos.find(item => item.id === id);
    if (!todo) return;
    if (todo.text === text) { setEditingTodoId(null); return; }
    setSavingEdit(true);
    try {
      const saved = await onPersistTodos(todos.map(item => item.id === id ? { ...item, text } : item), { kind: 'edit', id, text });
      if (saved) setEditingTodoId(current => current === id ? null : current);
    } finally { setSavingEdit(false); }
  };

  // Shown at once and persisted by the container, which reports a failure.
  const handleAddTodo = React.useCallback((trimmed: string) => {
    const id = createTodoId();
    const text = trimmed.slice(0, PROJECT_TODO_TEXT_MAX_LENGTH);
    return onPersistTodos(insertTodoBeforeCompleted(todos, {
      id,
      text,
      completed: false,
      createdAt: Date.now(),
    }), { kind: 'create', id, text });
  }, [onPersistTodos, todos]);

  const handleToggleTodoExpanded = React.useCallback((id: string) => {
    setExpandedTodoIds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const handleToggleTodo = React.useCallback(
    (id: string, completed: boolean) => {
      const todo = todos.find((item) => item.id === id);
      if (!todo || todo.completed === completed) {
        return;
      }
      const remaining = todos.filter((item) => item.id !== id);
      const updated = { ...todo, completed };
      onPersistTodos(
        completed ? [...remaining, updated] : insertTodoBeforeCompleted(remaining, updated),
        { kind: 'complete', id, completed },
      );
    },
    [onPersistTodos, todos]
  );

  const handleDeleteTodo = React.useCallback(
    (id: string) => {
      onPersistTodos(todos.filter((todo) => todo.id !== id), { kind: 'delete', id });
    },
    [onPersistTodos, todos]
  );

  const handleClearCompletedTodos = React.useCallback(() => {
    const next = todos.filter((todo) => !todo.completed);
    if (next.length === todos.length) {
      return;
    }
    onPersistTodos(next);
  }, [onPersistTodos, todos]);

  const handleTodoReorder = React.useCallback(
    (event: DragEndEvent) => {
      if (blocked || editingTodoId !== null) return;
      const { active, over } = event;
      if (!over || active.id === over.id) {
        return;
      }
      const oldIndex = todos.findIndex((todo) => todo.id === active.id);
      const newIndex = todos.findIndex((todo) => todo.id === over.id);
      if (oldIndex === -1 || newIndex === -1) {
        return;
      }
      onPersistTodos(sortTodosWithCompletedLast(arrayMove(todos, oldIndex, newIndex)));
    },
    [blocked, editingTodoId, onPersistTodos, todos]
  );

  const todoSensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
  );

  const completedTodoCount = todos.reduce((count, todo) => count + (todo.completed ? 1 : 0), 0);
  // Filtering is display-only: every handler above still edits the full list,
  // so reordering or clearing while a filter is active cannot drop hidden items.
  const visibleTodos = React.useMemo(
    () => todos.filter((todo) => todo.id === editingTodoId || matchesRankQuery([todo.text], query)),
    [editingTodoId, query, todos],
  );

  return (
    <div className="space-y-2">
      <KnowledgeComposer
        placeholder={t('rightSidebar.contextNotesTodo.todo.inputPlaceholder')}
        addLabel={t('rightSidebar.contextNotesTodo.todo.addAria')}
        maxLength={PROJECT_TODO_TEXT_MAX_LENGTH}
        disabled={blocked}
        onSubmit={handleAddTodo}
      />

      <div className="rounded-lg border border-border/60 bg-background/40">
        {visibleTodos.length === 0 ? (
          <p className="px-3 py-3 typography-meta text-muted-foreground">
            {query.trim()
              ? t('rightSidebar.contextNotesTodo.search.noResults', { query: query.trim() })
              : t('rightSidebar.contextNotesTodo.todo.empty')}
          </p>
        ) : (
          <DndContext
            sensors={todoSensors}
            collisionDetection={closestCenter}
            onDragEnd={handleTodoReorder}
          >
            <SortableContext
              items={visibleTodos.map((todo) => todo.id)}
              strategy={verticalListSortingStrategy}
            >
              <ul className="divide-y divide-border/50">
                {visibleTodos.map((todo) => {
                  const isExpandedTodo = expandedTodoIds.has(todo.id);
                  const isEditingTodo = editingTodoId === todo.id;
                  return (
                    <SortableTodoItem key={todo.id} id={todo.id} disabled={blocked || editingTodoId !== null}>
                      {(dragHandleProps) => (
                        <div className={cn('group/knowledge flex gap-1.5 px-2.5 py-1.5', isExpandedTodo || isEditingTodo ? 'items-start' : 'items-center')}>
                          <button
                            type="button"
                            disabled={blocked || editingTodoId !== null}
                            ref={dragHandleProps.setActivatorNodeRef}
                            {...dragHandleProps.attributes}
                            {...dragHandleProps.listeners}
                            onClick={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                            }}
                            className={cn('flex h-6 w-4 flex-shrink-0 touch-none items-center justify-center text-muted-foreground hover:text-foreground', reveal)}
                            aria-label={t('rightSidebar.contextNotesTodo.todo.actions.reorder', { text: todo.text })}
                            title={t('rightSidebar.contextNotesTodo.todo.actions.reorder', { text: todo.text })}
                          >
                            <Icon name="draggable" className="h-3.5 w-3.5" />
                          </button>
                          <div className="flex h-6 items-center">
                            <Checkbox
                              disabled={blocked || isEditingTodo}
                              checked={todo.completed}
                              onChange={(checked) => handleToggleTodo(todo.id, checked)}
                              ariaLabel={t('rightSidebar.contextNotesTodo.todo.actions.markComplete', { text: todo.text })}
                            />
                          </div>
                          {isEditingTodo ? <TodoEditor
                            initialText={todo.text}
                            disabled={disabled}
                            saving={savingEdit}
                            onSave={text => { void handleEditTodo(todo.id, text); }}
                            onCancel={() => setEditingTodoId(null)}
                          /> : <>
                          <button
                            type="button"
                            onClick={() => handleToggleTodoExpanded(todo.id)}
                            className={cn(
                              'block min-h-6 min-w-0 flex-1 bg-transparent p-0 text-start typography-ui-label leading-normal text-foreground',
                              isExpandedTodo ? 'whitespace-pre-wrap break-words' : 'overflow-hidden text-ellipsis whitespace-nowrap',
                              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                              todo.completed && 'text-muted-foreground line-through'
                            )}
                            title={isExpandedTodo ? undefined : todo.text}
                            aria-label={
                              isExpandedTodo
                                ? t('rightSidebar.contextNotesTodo.todo.actions.collapse', { text: todo.text })
                                : t('rightSidebar.contextNotesTodo.todo.actions.expand', { text: todo.text })
                            }
                          >
                            {todo.text}
                          </button>
                          <div className="-me-1 flex h-6 items-center gap-0.5">
                            <button
                              type="button"
                              onClick={() => onSendToCurrentSession(todo.id, todo.text)}
                              disabled={blocked || sendingTodoId !== null}
                              className={cn(KNOWLEDGE_ICON_BUTTON_CLASS, reveal)}
                              aria-label={t('rightSidebar.contextNotesTodo.todo.actions.send', { text: todo.text })}
                              title={t('rightSidebar.contextNotesTodo.todo.actions.send', { text: todo.text })}
                            >
                              <Icon name="send-plane" className="h-3.5 w-3.5" />
                            </button>
                            <KnowledgeMenu
                              disabled={blocked}
                              items={[{
                                id: 'edit',
                                label: t('rightSidebar.contextNotesTodo.todo.menu.edit'),
                                disabled: editingTodoId !== null || sendingTodoId === todo.id,
                                onSelect: () => setEditingTodoId(todo.id),
                              }, {
                                id: 'send-new-session',
                                label: t('rightSidebar.contextNotesTodo.todo.sendMenu.newSession'),
                                disabled: sendingTodoId !== null,
                                onSelect: () => onSendToNewSession(todo.id, todo.text),
                              }, {
                                id: 'send-new-worktree',
                                label: t('rightSidebar.contextNotesTodo.todo.sendMenu.newWorktreeSession'),
                                disabled: !canCreateWorktree || sendingTodoId !== null,
                                onSelect: () => onSendToNewWorktreeSession(todo.id, todo.text),
                              }, {
                                id: 'delete',
                                label: t('rightSidebar.contextNotesTodo.todo.menu.delete'),
                                destructive: true,
                                onSelect: () => handleDeleteTodo(todo.id),
                              }]}
                            />
                          </div>
                          </>}
                        </div>
                      )}
                    </SortableTodoItem>
                  );
                })}
              </ul>
            </SortableContext>
          </DndContext>
        )}
      </div>

      {completedTodoCount > 0 ? (
        <button
          type="button"
          onClick={handleClearCompletedTodos}
          disabled={blocked || editingTodoId !== null}
          className="px-1 typography-meta text-muted-foreground/80 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t('rightSidebar.contextNotesTodo.todo.clearCompleted')}
        </button>
      ) : null}
    </div>
  );
};
