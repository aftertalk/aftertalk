// Small pure rules of phase 2: the status model, key encryption, upload checks, range headers and
// provider base URLs.
import { shownStatus } from '@/lib/calls/queries';
import { parseRange } from '@/lib/http-range';
import { cleanBaseUrl } from '@/lib/providers';
import { decryptSecret, encryptSecret } from '@/lib/secrets';
import { cleanChannelRoles, cleanFilename, extensionOf, matchesFormat, UploadError } from '@/lib/upload';

describe('status model', () => {
  const job = (status: string, errorCode: string | null = null) => ({ status, errorCode });

  test('no stored result: the latest job decides', () => {
    expect(shownStatus('pending', job('queued')).status).toBe('queued');
    expect(shownStatus('pending', job('sent')).status).toBe('processing');
    expect(shownStatus('pending', job('failed', 'provider_auth'))).toEqual({
      status: 'failed',
      failedReason: 'provider_auth',
      laterRun: null,
    });
    // A stalled job with no newer one.
    expect(shownStatus('pending', job('superseded'))).toMatchObject({ status: 'failed', failedReason: 'stalled' });
  });

  test('a stored result keeps its status; a later run is a note', () => {
    expect(shownStatus('completed', job('completed'))).toEqual({
      status: 'completed',
      failedReason: null,
      laterRun: null,
    });
    expect(shownStatus('completed', job('queued')).laterRun).toEqual({ status: 'queued', errorCode: null });
    expect(shownStatus('completed_with_errors', job('sent'))).toMatchObject({
      status: 'completed_with_errors',
      laterRun: { status: 'processing' },
    });
    expect(shownStatus('completed', job('failed', 'internal')).laterRun).toEqual({
      status: 'failed',
      errorCode: 'internal',
    });
  });
});

describe('secrets', () => {
  test('round trip, with a fresh nonce each time', () => {
    const a = encryptSecret('sk-test-123');
    const b = encryptSecret('sk-test-123');
    expect(a.equals(b)).toBe(false);
    expect(a.toString('utf8')).not.toContain('sk-test-123');
    expect(decryptSecret(a)).toBe('sk-test-123');
  });

  test('a changed value does not decrypt', () => {
    const stored = encryptSecret('sk-test-123');
    stored[stored.length - 1] ^= 1;
    expect(() => decryptSecret(stored)).toThrow();
    expect(() => decryptSecret(Buffer.alloc(5))).toThrow();
  });
});

describe('upload checks', () => {
  test('file names lose folders and control characters', () => {
    expect(cleanFilename('C:\\calls\\a.wav')).toBe('a.wav');
    expect(cleanFilename('../../etc/passwd')).toBe('passwd');
    expect(cleanFilename('a\u0000b\n.mp3')).toBe('ab.mp3');
    expect(cleanFilename('   ')).toBeNull();
    expect(cleanFilename('..')).toBeNull();
    expect(cleanFilename('x'.repeat(256))).toBeNull();
    expect(extensionOf('Call.MP3')).toBe('.mp3');
    expect(extensionOf('noext')).toBe('');
  });

  test('channel labels: both or neither, 1 to 40 characters, different', () => {
    expect(cleanChannelRoles(null, null)).toBeNull();
    expect(cleanChannelRoles(' Agent ', 'Customer')).toEqual({ channel_0: 'Agent', channel_1: 'Customer' });
    for (const [a, b] of [
      ['Agent', ''],
      ['', 'Customer'],
      ['Agent', 'agent'],
      ['x'.repeat(41), 'Customer'],
    ]) {
      expect(() => cleanChannelRoles(a, b)).toThrow(UploadError);
    }
  });

  test('first bytes must match the extension', () => {
    const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt ')]);
    expect(matchesFormat('.wav', wav)).toBe(true);
    expect(matchesFormat('.mp3', wav)).toBe(false);
    expect(matchesFormat('.mp3', Buffer.from('ID3\u0003rest'))).toBe(true);
    expect(matchesFormat('.mp3', Buffer.from([0xff, 0xfb, 0x90, 0x00]))).toBe(true);
    expect(matchesFormat('.m4a', Buffer.concat([Buffer.alloc(4), Buffer.from('ftypM4A ')]))).toBe(true);
    expect(matchesFormat('.ogg', Buffer.from('OggS....'))).toBe(true);
    expect(matchesFormat('.flac', Buffer.from('fLaC....'))).toBe(true);
    expect(matchesFormat('.webm', Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))).toBe(true);
    expect(matchesFormat('.wav', Buffer.from('<html>'))).toBe(false);
    expect(matchesFormat('.exe', wav)).toBe(false);
  });
});

describe('range header', () => {
  test('the three forms', () => {
    expect(parseRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 });
    expect(parseRange('bytes=900-', 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange('bytes=0-5000', 1000)).toEqual({ start: 0, end: 999 });
  });

  test('absent or unknown forms are ignored; impossible ones are invalid', () => {
    expect(parseRange(null, 1000)).toBeNull();
    expect(parseRange('bytes=0-1,5-6', 1000)).toBeNull();
    expect(parseRange('items=0-1', 1000)).toBeNull();
    expect(parseRange('bytes=1000-', 1000)).toBe('invalid');
    expect(parseRange('bytes=5-2', 1000)).toBe('invalid');
    expect(parseRange('bytes=-0', 1000)).toBe('invalid');
  });
});

describe('provider base URL', () => {
  test('accepted and normalised', () => {
    expect(cleanBaseUrl('https://api.openai.com/v1/')).toEqual({ url: 'https://api.openai.com/v1' });
    expect(cleanBaseUrl(' http://whisper:8000/v1 ')).toEqual({ url: 'http://whisper:8000/v1' });
  });

  test('refused', () => {
    for (const bad of [
      'ftp://example.com/v1',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'https://user:pass@example.com/v1',
      'https://example.com/v1?key=1',
      'https://example.com/v1#x',
      'not a url',
      '',
      42,
    ]) {
      expect(cleanBaseUrl(bad)).toEqual({ problem: 'invalid' });
    }
    expect(cleanBaseUrl('https://api.openai.com/v1/chat/completions')).toEqual({ problem: 'resource_path' });
    expect(cleanBaseUrl('https://api.openai.com/v1/audio/transcriptions/')).toEqual({ problem: 'resource_path' });
  });
});
