import {
  createCommands,
  CommandUnavailableError,
  type CommandRuntime,
  type CommandInfo,
} from '@lp-labs/command-runtime';
interface Context {
  readonly selected: number;
}
const runtime: CommandRuntime<Context> = createCommands<Context>([
  {
    id: 'save',
    label: 'Save',
    enabled: (context) => context.selected > 0,
    execute: (context, { signal }) => {
      signal.throwIfAborted();
      return context.selected;
    },
  },
]);
const info: CommandInfo[] = runtime.list({ selected: 1 });
const result: unknown = await runtime.run('save', { selected: 1 });
// @ts-expect-error runtime operations require the declared context shape.
runtime.run('save', { wrong: 1 });
void [info, result, CommandUnavailableError];
