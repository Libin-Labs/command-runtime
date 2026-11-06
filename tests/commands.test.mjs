import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createCommands, CommandUnavailableError } from '../dist/esm/index.js';
const deferred = () => {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};
const command = (id, execute = () => id) => ({ id, label: id.toUpperCase(), execute });
test('commands use explicit context, discovery metadata and sync/async results', async () => {
  const runtime = createCommands([
    command('save', (context) => context.value * 2),
    command('load', async () => 'loaded'),
  ]);
  assert.deepEqual(runtime.list({ value: 3 }), [
    { id: 'save', label: 'SAVE', enabled: true, running: 0 },
    { id: 'load', label: 'LOAD', enabled: true, running: 0 },
  ]);
  assert.equal(await runtime.run('save', { value: 3 }), 6);
  assert.equal(await runtime.run('load', {}), 'loaded');
});
test('availability is reevaluated for each discovery and execution', async () => {
  let checks = 0,
    executions = 0;
  const runtime = createCommands([
    {
      ...command('save', () => executions++),
      enabled(context) {
        checks++;
        return context.allowed;
      },
    },
  ]);
  assert.equal(runtime.list({ allowed: false })[0].enabled, false);
  await assert.rejects(
    runtime.run('save', { allowed: false }),
    (error) => error instanceof CommandUnavailableError && error.reason === 'disabled',
  );
  await runtime.run('save', { allowed: true });
  assert.equal(checks, 3);
  assert.equal(executions, 1);
});
test('same-command overlap is rejected by default until the original settles', async () => {
  const wait = deferred(),
    runtime = createCommands([command('save', () => wait.promise)]);
  const first = runtime.run('save', {});
  assert.equal(runtime.list({})[0].running, 1);
  assert.equal(runtime.list({})[0].enabled, false);
  await assert.rejects(runtime.run('save', {}), (error) => error.reason === 'running');
  wait.resolve(1);
  assert.equal(await first, 1);
  assert.equal(runtime.list({})[0].enabled, true);
});
test('parallel policy permits overlap but enforces a global concurrent cap', async () => {
  const wait = deferred(),
    runtime = createCommands([command('x', () => wait.promise), command('y')], {
      concurrency: 'parallel',
      maxConcurrent: 2,
    });
  const first = runtime.run('x', {}),
    second = runtime.run('x', {});
  await assert.rejects(runtime.run('y', {}), (error) => error.reason === 'capacity');
  assert.equal(runtime.list({})[0].running, 2);
  wait.resolve('ok');
  assert.deepEqual(await Promise.all([first, second]), ['ok', 'ok']);
  assert.equal(await runtime.run('y', {}), 'y');
});
test('cancel aborts running command signals and retains slots until actual settlement', async () => {
  const wait = deferred();
  let received;
  const runtime = createCommands([
    command('x', (_context, { signal }) => {
      received = signal;
      return wait.promise;
    }),
  ]);
  const result = runtime.run('x', {}),
    reason = new Error('cancel request');
  assert.equal(runtime.cancel('x', reason), 1);
  assert.equal(received.reason, reason);
  assert.equal(runtime.cancel('x'), 0);
  assert.equal(runtime.list({})[0].running, 1);
  await assert.rejects(runtime.run('x', {}), (error) => error.reason === 'running');
  wait.resolve(42);
  assert.equal(await result, 42);
});
test('cooperative cancellation errors propagate unchanged and release admission', async () => {
  const reason = new Error('stopped');
  const runtime = createCommands([
    command(
      'x',
      (_context, { signal }) =>
        new Promise((_yes, no) =>
          signal.addEventListener('abort', () => no(signal.reason), { once: true }),
        ),
    ),
  ]);
  const result = runtime.run('x', {});
  runtime.cancel('x', reason);
  await assert.rejects(result, (error) => error === reason);
  assert.equal(runtime.list({})[0].running, 0);
});
test('external abort is forwarded and the listener is detached after completion', async () => {
  const controller = new AbortController(),
    wait = deferred();
  let added = 0,
    removed = 0,
    received;
  const add = controller.signal.addEventListener.bind(controller.signal);
  const remove = controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.addEventListener = (...args) => {
    added++;
    add(...args);
  };
  controller.signal.removeEventListener = (...args) => {
    removed++;
    remove(...args);
  };
  const runtime = createCommands([
    command('x', (_context, { signal }) => {
      received = signal;
      return wait.promise;
    }),
  ]);
  const result = runtime.run('x', {}, { signal: controller.signal });
  controller.abort('external');
  assert.equal(received.aborted, true);
  assert.equal(received.reason, 'external');
  wait.resolve();
  await result;
  assert.equal(added, 1);
  assert.equal(removed, 1);
});
test('pre-aborted runs and malformed signals never invoke predicates or commands', async () => {
  let checks = 0;
  const runtime = createCommands([
    {
      ...command('x'),
      enabled() {
        checks++;
        return true;
      },
    },
  ]);
  const controller = new AbortController(),
    reason = new Error('early');
  controller.abort(reason);
  await assert.rejects(
    runtime.run('x', {}, { signal: controller.signal }),
    (error) => error === reason,
  );
  await assert.rejects(runtime.run('x', {}, { signal: {} }), TypeError);
  assert.equal(checks, 0);
});
test('close is idempotent, aborts every active signal and permanently rejects new work', async () => {
  const wait = deferred(),
    signals = [];
  const runtime = createCommands(
    [
      command('x', (_context, { signal }) => {
        signals.push(signal);
        return wait.promise;
      }),
    ],
    { concurrency: 'parallel' },
  );
  const first = runtime.run('x', {}),
    second = runtime.run('x', {});
  runtime.close('shutdown');
  runtime.close('ignored');
  assert.equal(runtime.closed, true);
  assert.ok(signals.every((signal) => signal.reason === 'shutdown'));
  assert.equal(runtime.list({})[0].enabled, false);
  await assert.rejects(runtime.run('x', {}), (error) => error.reason === 'closed');
  wait.resolve();
  await Promise.all([first, second]);
});
test('callback failures propagate and release slots without disabling future runs', async () => {
  const error = new Error('adapter failed');
  let fail = true;
  const runtime = createCommands([
    command('x', () => {
      if (fail) throw error;
      return 2;
    }),
  ]);
  await assert.rejects(runtime.run('x', {}), (caught) => caught === error);
  assert.equal(runtime.list({})[0].running, 0);
  fail = false;
  assert.equal(await runtime.run('x', {}), 2);
});
test('invalid availability results and predicate errors are not disabled fallbacks', async () => {
  const error = new Error('predicate');
  const bad = createCommands([{ ...command('x'), enabled: () => 1 }]);
  assert.throws(() => bad.list({}), TypeError);
  await assert.rejects(bad.run('x', {}), TypeError);
  const throws = createCommands([
    {
      ...command('x'),
      enabled() {
        throw error;
      },
    },
  ]);
  assert.throws(
    () => throws.list({}),
    (caught) => caught === error,
  );
  await assert.rejects(throws.run('x', {}), (caught) => caught === error);
});
test('availability predicates cannot mutate runtime admission through synchronous reentrancy', async () => {
  let runtime;
  runtime = createCommands([
    {
      ...command('x'),
      enabled() {
        assert.throws(() => runtime.close(), /reentrant/);
        assert.throws(() => runtime.cancel('x'), /reentrant/);
        assert.throws(() => runtime.list({}), /reentrant/);
        return true;
      },
    },
  ]);
  assert.equal(await runtime.run('x', {}), 'x');
  assert.equal(runtime.closed, false);
});
test('definitions and discovery records are copied; unknown IDs and invalid capacities throw', async () => {
  const definition = command('x'),
    runtime = createCommands([definition]);
  definition.label = 'changed';
  definition.execute = () => 'changed';
  runtime.list({})[0].label = 'mutated';
  assert.equal(runtime.list({})[0].label, 'X');
  assert.equal(await runtime.run('x', {}), 'x');
  await assert.rejects(runtime.run('unknown', {}), TypeError);
  assert.throws(() => runtime.cancel('unknown'), TypeError);
  assert.throws(() => createCommands([command('x'), command('x')]), TypeError);
  assert.throws(() => createCommands([], { maxConcurrent: -1 }), RangeError);
  assert.throws(() => createCommands([], { concurrency: 'queue' }), TypeError);
  assert.throws(() => createCommands([command('x')], { maxCommands: 0 }), RangeError);
});
test('hundreds of concurrent operations never exceed configured admission', async () => {
  let active = 0,
    peak = 0;
  const runtime = createCommands(
    [
      command('x', async () => {
        active++;
        peak = Math.max(peak, active);
        await Promise.resolve();
        active--;
        return 'ok';
      }),
    ],
    { concurrency: 'parallel', maxConcurrent: 7 },
  );
  const results = await Promise.allSettled(Array.from({ length: 200 }, () => runtime.run('x', {})));
  assert.equal(peak, 7);
  assert.equal(results.filter((row) => row.status === 'fulfilled').length, 7);
  assert.ok(
    results
      .filter((row) => row.status === 'rejected')
      .every((row) => row.reason.reason === 'capacity'),
  );
  assert.equal(runtime.list({})[0].running, 0);
});
test('CommonJS supports typed-context-independent execution', async () => {
  const api = createRequire(import.meta.url)('../dist/cjs/index.js');
  assert.equal(await api.createCommands([command('x')]).run('x', {}), 'x');
});
