import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createTestAppInstance } from '../testAppInstance.test-helper.js';

const mailboxBody = { email: 'Ops@Bhatia.example', password: 'a-long-enough-password' };

describe('tenants', () => {
  it('creates a tenant, then a mailbox with credentials under it, without signing anyone in', async () => {
    const app = createTestAppInstance();
    const tenant = await request(app).post('/v1/tenants').send({ name: 'Bhatia Desk' });
    expect(tenant.status).toBe(201);
    expect(tenant.body).toEqual({ tenantId: expect.any(String) });

    const mailbox = await request(app)
      .post(`/v1/tenants/${tenant.body.tenantId}/mailboxes`)
      .send(mailboxBody);
    expect(mailbox.status).toBe(201);
    expect(mailbox.body).toEqual({ mailboxId: expect.any(String), tenantId: tenant.body.tenantId });
    expect(mailbox.headers['set-cookie']).toBeUndefined();
  });

  it('unknown tenant is 404, duplicate email is 409, invalid body is 400 naming the fields', async () => {
    const app = createTestAppInstance();
    const unknown = await request(app)
      .post('/v1/tenants/00000000-0000-4000-8000-000000000000/mailboxes')
      .send(mailboxBody);
    expect(unknown.status).toBe(404);

    const tenant = await request(app).post('/v1/tenants').send({ name: 'Bhatia Desk' });
    const path = `/v1/tenants/${tenant.body.tenantId}/mailboxes`;
    await request(app).post(path).send(mailboxBody);
    expect((await request(app).post(path).send(mailboxBody)).status).toBe(409);

    const invalid = await request(app)
      .post(path)
      .send({ email: 'not-an-email', password: 'short' });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toMatch(/email/);
    expect(invalid.body.error).toMatch(/password/);
    expect(
      (await request(app).post('/v1/tenants/not-a-uuid/mailboxes').send(mailboxBody)).status,
    ).toBe(400);
  });
});
