import { App } from 'aws-cdk-lib';
import { describe, expect, it } from 'vitest';
import { resolveFrontendOrigins } from './stageConfig.js';

const STAGING_FRONTEND_ORIGIN = 'https://frontend-staging-d909.up.railway.app';

describe('resolveFrontendOrigins', () => {
  it('is undefined when the stage key is absent, so the stack falls back to the stage default', () => {
    expect(resolveFrontendOrigins(new App(), 'staging')).toBeUndefined();
    expect(resolveFrontendOrigins(new App(), 'production')).toBeUndefined();
  });

  it('reads only the key of the stage being synthesized', () => {
    const app = new App({
      context: {
        'frontendOrigins:staging': STAGING_FRONTEND_ORIGIN,
        'frontendOrigins:production': 'https://frontend.example.com',
      },
    });
    expect(resolveFrontendOrigins(app, 'staging')).toEqual([STAGING_FRONTEND_ORIGIN]);
    expect(resolveFrontendOrigins(app, 'production')).toEqual(['https://frontend.example.com']);
    const stagingOnly = new App({
      context: { 'frontendOrigins:staging': STAGING_FRONTEND_ORIGIN },
    });
    expect(resolveFrontendOrigins(stagingOnly, 'production')).toBeUndefined();
  });

  it('splits a CLI comma-separated string and accepts a cdk.json string list', () => {
    const fromCli = new App({
      context: {
        'frontendOrigins:production': 'https://a.example.com, https://b.example.com',
      },
    });
    expect(resolveFrontendOrigins(fromCli, 'production')).toEqual([
      'https://a.example.com',
      'https://b.example.com',
    ]);
    const fromCdkJson = new App({
      context: { 'frontendOrigins:production': ['https://a.example.com'] },
    });
    expect(resolveFrontendOrigins(fromCdkJson, 'production')).toEqual(['https://a.example.com']);
  });

  it('refuses an unkeyed frontendOrigins so no stage inherits another stage list', () => {
    const app = new App({ context: { frontendOrigins: STAGING_FRONTEND_ORIGIN } });
    expect(() => resolveFrontendOrigins(app, 'production')).toThrow(/not stage-specific/);
  });

  it.each([
    ['a number', 42],
    ['an object', { origin: STAGING_FRONTEND_ORIGIN }],
    ['a list with a non-string', [STAGING_FRONTEND_ORIGIN, 1]],
    ['true', true],
  ])('rejects %s', (_label, configured) => {
    const app = new App({ context: { 'frontendOrigins:staging': configured } });
    expect(() => resolveFrontendOrigins(app, 'staging')).toThrow(/comma-separated string/);
  });

  it.each([[''], [','], [`${STAGING_FRONTEND_ORIGIN},`], [[' ']]])(
    'rejects empty entries in %j',
    (configured) => {
      const app = new App({ context: { 'frontendOrigins:staging': configured } });
      expect(() => resolveFrontendOrigins(app, 'staging')).toThrow(/empty origin/);
    },
  );
});
