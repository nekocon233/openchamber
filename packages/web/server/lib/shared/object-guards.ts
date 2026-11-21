export function isPlainObject<Value extends object>(value: Value): boolean;
export function isPlainObject(value: unknown): value is Record<string, unknown>;
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

export const isString = (value: unknown): value is string => typeof value === 'string';
export const isNumber = (value: unknown): value is number => typeof value === 'number';
export const isCallable = (value: unknown): value is CallableFunction => typeof value === 'function';
export const isObject = (value: unknown): value is object => value !== null && typeof value === 'object';

export const errorCodeOf = (cause: unknown): string | undefined =>
  isObject(cause) && 'code' in cause && isString(cause.code) ? cause.code : undefined;

export const asNonEmptyString = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

export const isBoolean = (value: unknown): value is boolean => value === true || value === false;

export function isRecord<Value extends object>(value: Value): boolean;
export function isRecord(value: unknown): value is Record<string, unknown>;
export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export const isPresent = <Value>(value: Value): value is NonNullable<Value> => Boolean(value);

export const hasProperties = <Value>(value: Value): value is Value & Readonly<Record<string, unknown>> => value != null;
