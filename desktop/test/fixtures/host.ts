// A stand-in for the desktop process: it launches the backend, reports what it started, then waits to be killed.
import { launchOwnedBackend, type BackendSpec } from '../../src/backend.js';

const spec = JSON.parse(process.argv[2] ?? '{}') as BackendSpec;
const backend = launchOwnedBackend({ ...spec, log: 2 });
void backend.started.then(start => process.stdout.write(JSON.stringify(start) + '\n'));
setInterval(() => {}, 1e9);
