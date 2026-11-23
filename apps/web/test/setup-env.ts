import { tmpdir } from 'node:os';
import path from 'node:path';

import { urlForDb, workerDbName } from './db-names';

// Runs in each worker before any test file is loaded, so lib/db/client.ts sees this worker's database.
process.env.DATABASE_URL = urlForDb(workerDbName(process.env.JEST_WORKER_ID ?? '1'));
process.env.PUBLIC_URL ??= 'http://localhost:3000';
process.env.BETTER_AUTH_SECRET ??= 'test-better-auth-secret-0000000000000000';
process.env.SECRETS_KEY ??= Buffer.alloc(32, 7).toString('base64');
process.env.ENGINE_URL ??= 'http://engine.test:8000';
process.env.ENGINE_CALLBACK_SECRET ??= 'test-callback-secret';
// A folder of its own per worker for uploaded audio and the transcript cache.
process.env.DATA_DIR ??= path.join(tmpdir(), `aftertalk-test-data-${process.env.JEST_WORKER_ID ?? '1'}`);
