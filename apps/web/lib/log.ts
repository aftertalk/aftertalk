// JSON logs on stdout with a fixed set of fields (spec: Logging section), the same format as the engine.
// Provider response bodies, transcript text and keys are never logged: the type admits only these fields.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogFields = Partial<{
  job_id: string;
  call_id: string;
  project_id: string;
  user_id: string;
  attempt: number;
  step: string;
  error_code: string;
  duration_ms: number;
}>;

const ALLOWED = new Set<keyof LogFields>([
  'job_id',
  'call_id',
  'project_id',
  'user_id',
  'attempt',
  'step',
  'error_code',
  'duration_ms',
]);

export function log(level: LogLevel, msg: string, fields: LogFields = {}): void {
  // The type stops unknown fields at compile time; this stops them from untyped callers.
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!ALLOWED.has(key as keyof LogFields)) throw new Error(`log field not allowed: ${key}`);
    safe[key] = value;
  }
  const line = JSON.stringify({ ts: new Date().toISOString(), level, logger: 'web', msg, ...safe });
  (level === 'error' ? process.stderr : process.stdout).write(line + '\n');
}
