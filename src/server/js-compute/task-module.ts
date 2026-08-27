/**
 * The shape every task registry satisfies.
 *
 * Exists so `worker.ts` can look a task up by a runtime string without casting
 * the registries to something they are not. The previous
 * `as unknown as Record<string, (args: Record<string, never>) => string>` erased
 * the argument types of both registries in both directions — the same
 * producer/consumer field-name seam that made six capabilities unusable in
 * cc2ce0b, moved to a place the compiler could no longer see.
 */
export type TaskFn = (args: never) => string;

export type TaskModule = Readonly<Record<string, TaskFn>>;
