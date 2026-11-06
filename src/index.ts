export interface CommandExecution {
  signal: AbortSignal;
}
export interface Command<Context> {
  id: string;
  label: string;
  enabled?: (context: Context) => boolean;
  execute: (context: Context, execution: CommandExecution) => unknown | PromiseLike<unknown>;
}
export interface CommandOptions {
  maxCommands?: number;
  maxConcurrent?: number;
  concurrency?: 'reject' | 'parallel';
}
export interface CommandInfo {
  id: string;
  label: string;
  enabled: boolean;
  running: number;
}
export interface CommandRuntime<Context> {
  list(context: Context): CommandInfo[];
  run(id: string, context: Context, options?: { signal?: AbortSignal }): Promise<unknown>;
  cancel(id: string, reason?: unknown): number;
  close(reason?: unknown): void;
  readonly closed: boolean;
}
export class CommandUnavailableError extends Error {
  constructor(
    readonly commandId: string,
    readonly reason: 'disabled' | 'running' | 'capacity' | 'closed',
  ) {
    super(`Command ${commandId} is unavailable: ${reason}.`);
    this.name = 'CommandUnavailableError';
  }
}
function label(value: string): void {
  if (typeof value !== 'string' || !value || value.length > 256)
    throw new TypeError('Command IDs/labels must be nonempty strings up to 256 units.');
}
function capacity(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError('Capacities must be non-negative safe integers.');
  return value;
}
export function createCommands<Context>(
  input: Iterable<Command<Context>>,
  options: CommandOptions = {},
): CommandRuntime<Context> {
  const maximum = capacity(options.maxCommands ?? 1000);
  const maxConcurrent = capacity(options.maxConcurrent ?? 100);
  const concurrency = options.concurrency ?? 'reject';
  if (concurrency !== 'reject' && concurrency !== 'parallel')
    throw new TypeError('Unknown concurrency policy.');
  if (input == null || typeof input[Symbol.iterator] !== 'function')
    throw new TypeError('Commands must be iterable.');
  const commands = new Map<string, Command<Context>>();
  const running = new Map<string, Set<AbortController>>();
  let total = 0,
    closed = false,
    checking = false;
  for (const command of input) {
    if (commands.size === maximum) throw new RangeError('Command capacity exceeded.');
    label(command.id);
    label(command.label);
    if (commands.has(command.id)) throw new TypeError('Duplicate command ID.');
    if (
      typeof command.execute !== 'function' ||
      (command.enabled !== undefined && typeof command.enabled !== 'function')
    )
      throw new TypeError('Invalid command callbacks.');
    commands.set(command.id, { ...command });
    running.set(command.id, new Set());
  }
  const get = (id: string) => {
    const command = commands.get(id);
    if (!command) throw new TypeError(`Unknown command: ${id}`);
    return command;
  };
  const guard = () => {
    if (checking)
      throw new TypeError('Command operations cannot be reentrant during availability checks.');
  };
  const enabled = (command: Command<Context>, context: Context) => {
    checking = true;
    try {
      const value = command.enabled ? command.enabled(context) : true;
      if (typeof value !== 'boolean')
        throw new TypeError('Availability predicates must return booleans synchronously.');
      return value;
    } finally {
      checking = false;
    }
  };
  const abort = (controllers: Iterable<AbortController>, reason: unknown) => {
    let count = 0;
    for (const controller of [...controllers]) {
      if (!controller.signal.aborted) {
        controller.abort(reason);
        count++;
      }
    }
    return count;
  };
  return {
    get closed() {
      return closed;
    },
    list(context) {
      guard();
      return [...commands.values()].map((command) => ({
        id: command.id,
        label: command.label,
        enabled:
          !closed &&
          enabled(command, context) &&
          total < maxConcurrent &&
          (concurrency === 'parallel' || running.get(command.id)!.size === 0),
        running: running.get(command.id)!.size,
      }));
    },
    async run(id, context, config = {}) {
      guard();
      const command = get(id);
      const signal = config.signal;
      if (
        signal !== undefined &&
        (signal === null ||
          typeof signal.throwIfAborted !== 'function' ||
          typeof signal.addEventListener !== 'function' ||
          typeof signal.removeEventListener !== 'function')
      )
        throw new TypeError('Expected an AbortSignal.');
      signal?.throwIfAborted();
      if (closed) throw new CommandUnavailableError(id, 'closed');
      if (!enabled(command, context)) throw new CommandUnavailableError(id, 'disabled');
      if (concurrency === 'reject' && running.get(id)!.size)
        throw new CommandUnavailableError(id, 'running');
      if (total === maxConcurrent) throw new CommandUnavailableError(id, 'capacity');
      const controller = new AbortController();
      const forward = () => controller.abort(signal!.reason);
      signal?.addEventListener('abort', forward, { once: true });
      if (signal?.aborted) forward();
      running.get(id)!.add(controller);
      total++;
      try {
        controller.signal.throwIfAborted();
        return await command.execute(context, { signal: controller.signal });
      } finally {
        running.get(id)!.delete(controller);
        total--;
        signal?.removeEventListener('abort', forward);
      }
    },
    cancel(id, reason) {
      guard();
      get(id);
      return abort(running.get(id)!, reason);
    },
    close(reason) {
      guard();
      closed = true;
      abort(
        [...running.values()].flatMap((set) => [...set]),
        reason,
      );
    },
  };
}
