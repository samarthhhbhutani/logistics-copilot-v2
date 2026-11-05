import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

describe('loadConfig()', () => {
  it('parses a minimal env and applies defaults', () => {
    const config = loadConfig({ DATABASE_URL: 'postgres://u:p@h:5432/db' });
    expect(config).toMatchObject({ STAGE: 'dev', AWS_REGION: 'ap-south-1', PORT: 8080 });
    expect(config.MODEL_CLASSIFY).toBe('gpt-6-luna');
  });

  it('coerces PORT and returns a fresh object per call', () => {
    const env = { DATABASE_URL: 'postgres://u:p@h:5432/db', PORT: '3000' };
    const first = loadConfig(env);
    const second = loadConfig(env);
    expect(first.PORT).toBe(3000);
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
  });

  it('names every invalid key in the error', () => {
    expect(() => loadConfig({ STAGE: 'qa', GOOGLE_REDIRECT_URI: 'nope' })).toThrow(
      /DATABASE_URL.*STAGE.*GOOGLE_REDIRECT_URI|STAGE.*DATABASE_URL/,
    );
  });
});
