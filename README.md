# @lp-labs/command-runtime

One framework-independent command registry for menus, toolbars and shortcuts: explicit context,
availability, concurrent admission and cooperative cancellation.
Independently authored; zero runtime or peer dependencies.

## Install

```bash
npm install @lp-labs/command-runtime
```

ES2022 ESM/CommonJS and TypeScript declarations.
CommonJS: `const { createCommands } = require('@lp-labs/command-runtime')`.
Requires the standard `AbortController`/`AbortSignal` APIs.

## Quickstart

```js
import { createCommands } from '@lp-labs/command-runtime';

const runtime = createCommands([
  {
    id: 'save',
    label: 'Save document',
    enabled: (context) => context.dirty,
    execute: async (context, { signal }) => {
      signal.throwIfAborted();
      return { savedId: context.id };
    },
  },
]);
const context = { id: 'document-1', dirty: true };
if (!runtime.list(context)[0].enabled) throw new Error('Save should be available');
const result = await runtime.run('save', context);
if (result.savedId !== 'document-1') throw new Error('Command returned wrong result');
runtime.close();
```

## Registration and types

`createCommands<Context>(commands: Iterable<Command<Context>>, options?: CommandOptions): CommandRuntime<Context>`

Each command has:

- `id`: unique nonempty string, maximum 256 UTF-16 units.
- `label`: nonempty string up to 256 units.
- `enabled?(context): boolean`: trusted synchronous predicate, default true.
- `execute(context, { signal }): unknown | PromiseLike<unknown>`: trusted callback.

Definitions and metadata are copied at construction. The registry is fixed; create a new runtime
for a different set of commands. Context is passed **by reference**, not cloned or persisted.
Treat availability predicates as pure synchronous functions. Their exceptions propagate, and
nonboolean results throw instead of quietly disabling a command.

The context type is enforced by TypeScript. Because registry entries can return different types,
`run()` returns `Promise<unknown>`; narrow results in your application or create typed wrappers.

```ts
import { createCommands } from '@lp-labs/command-runtime';

interface Context {
  readonly selectedIds: readonly string[];
}
const runtime = createCommands<Context>([
  {
    id: 'count',
    label: 'Count selection',
    enabled: (context) => context.selectedIds.length > 0,
    execute: (context) => context.selectedIds.length,
  },
]);
const result = await runtime.run('count', { selectedIds: ['a'] });
if (typeof result !== 'number') throw new TypeError('Expected count');
```

## Discovery and admission

Options are:

| Option          | Default    | Contract                                                   |
| --------------- | ---------- | ---------------------------------------------------------- |
| `maxCommands`   | `1000`     | Non-negative safe integer registration cap.                |
| `maxConcurrent` | `100`      | Non-negative safe integer global in-flight cap.            |
| `concurrency`   | `'reject'` | Reject same-command overlap, or `'parallel'` to permit it. |

`list(context): CommandInfo[]` returns independent registration-ordered
`{ id, label, enabled, running }` records. Effective enabled state includes the predicate,
runtime open state, global capacity and same-command concurrency policy.
`running` counts unsettled invocations, including ones whose cancellation has been requested.
Discovery invokes predicates while open; never use discovery to perform side effects.

`run(id, context, { signal? }?): Promise<unknown>` reevaluates availability and reserves a slot
before invoking the callback. Calls are not queued. The callback receives a new internal signal
linked to the optional external native `AbortSignal`. External listeners are removed on settlement.

`CommandUnavailableError` exposes `commandId` and
`reason: 'disabled' | 'running' | 'capacity' | 'closed'`.
Closed state is checked first, then the predicate, same-command overlap and global capacity.
An already-aborted external signal rejects with its original reason before predicates execute.

## Cancellation and shutdown

```js
import { createCommands, CommandUnavailableError } from '@lp-labs/command-runtime';

const runtime = createCommands([
  {
    id: 'wait',
    label: 'Wait until cancelled',
    execute: (_context, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
  },
]);
const pending = runtime.run('wait', {});
const reason = new Error('User cancelled');
if (runtime.cancel('wait', reason) !== 1) throw new Error('Missing active command');
try {
  await pending;
  throw new Error('Expected cooperative cancellation');
} catch (error) {
  if (error !== reason) throw error;
}
runtime.close();
try {
  await runtime.run('wait', {});
  throw new Error('Closed runtime accepted work');
} catch (error) {
  if (!(error instanceof CommandUnavailableError) || error.reason !== 'closed') throw error;
}
```

- `cancel(id, reason?)` aborts not-yet-aborted invocations of a known command; returns newly
  aborted count. No active invocations means 0.
- `close(reason?)` permanently blocks new work and aborts active invocations. It is idempotent.
- `closed` reports shutdown state.
- Cancellation is cooperative. Slots remain reserved until callbacks actually settle.
  A callback ignoring its signal may return successfully after cancellation or close.
- Neither cancel nor close awaits completion. Retain invocation promises and await them yourself.
- Callback errors propagate unchanged and always release admission/listeners.
- Synchronous runtime operations during availability predicates throw for reentrancy; nested
  `run()` returns a rejected promise. Callbacks themselves may invoke other commands within caps.

## Integration, performance and scope

Route menu, shortcut and toolbar actions through the same command IDs; render discovery results
using your own state system. There are no implicit subscriptions, DOM handlers, key matching or UI.
Availability is **not authorization**: enforce permissions again in trusted server/storage logic.
No rollback, undo history, automatic retries, queued execution or durable work storage is included.

Average command lookup/admission is O(1); discovery O(C) plus predicate work; cancellation O(A)
for active invocations of that command. Close costs O(all active). Memory is O(C + A).
Unknown IDs and malformed definitions/signals throw `TypeError`; invalid capacities throw
`RangeError`. Predicates/executors are trusted application code, not sandboxed plugins.

Exported types: `CommandExecution`, `Command`, `CommandOptions`, `CommandInfo`, `CommandRuntime`.

## Support

If this library is useful to you, consider supporting its maintenance with a [donation via PayPal](https://www.paypal.me/LibinPrasanth).

## Author

Created by [Libin Prasanth](https://www.linkedin.com/in/libinprasanth/). Connect on LinkedIn for updates and discussion.
