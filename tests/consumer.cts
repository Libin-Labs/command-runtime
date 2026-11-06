import { createCommands } from '@lp-labs/command-runtime';
const runtime = createCommands<undefined>([]);
const closed: boolean = runtime.closed;
runtime.list(undefined);
void closed;
