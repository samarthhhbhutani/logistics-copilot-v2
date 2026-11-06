import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '@lc/core';
import { createAppInstance } from './createAppInstance.js';

const config = loadConfig({
  STAGE: 'staging',
  DATABASE_URL: 'postgresql://user:pw@localhost:6543/db',
});

describe('createAppInstance', () => {
  it('GET /health is open and reports the stage', async () => {
    const response = await request(createAppInstance({ config })).get('/health');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, stage: 'staging' });
  });

  it('unknown routes return a JSON 404 with the path', async () => {
    const response = await request(createAppInstance({ config })).get('/v1/nope');
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'not_found', path: '/v1/nope' });
  });

  it('malformed JSON bodies are a client error, not a crash', async () => {
    const response = await request(createAppInstance({ config }))
      .post('/v1/anything')
      .set('Content-Type', 'application/json')
      .send('{not json');
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/JSON/);
  });
});
