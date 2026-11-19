import { log } from './log';

test('writes one JSON line with the allowed fields', () => {
  const write = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  log('info', 'dispatched', { job_id: 'j1', attempt: 2 });
  const line = JSON.parse(String(write.mock.calls[0][0]));
  expect(line).toMatchObject({ level: 'info', msg: 'dispatched', job_id: 'j1', attempt: 2, logger: 'web' });
  write.mockRestore();
});

test('refuses fields outside the fixed set', () => {
  expect(() => log('info', 'oops', { transcript: 'Dzień dobry' } as never)).toThrow('transcript');
});
