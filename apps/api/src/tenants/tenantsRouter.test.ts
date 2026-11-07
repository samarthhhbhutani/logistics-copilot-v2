import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { testTenantBody } from '../tenantFixture.test-helper.js';
import { createTestApp, createTestAppInstance } from '../testAppInstance.test-helper.js';

const mailboxBody = { email: 'Ops@Bhatia.example', password: 'a-long-enough-password' };

describe('tenants', () => {
  it('creates a tenant, then a mailbox with credentials under it, without signing anyone in', async () => {
    const app = createTestAppInstance();
    const tenant = await request(app).post('/v1/tenants').send(testTenantBody);
    expect(tenant.status).toBe(201);
    expect(tenant.body).toEqual({ tenantId: expect.any(String) });

    const mailbox = await request(app)
      .post(`/v1/tenants/${tenant.body.tenantId}/mailboxes`)
      .send(mailboxBody);
    expect(mailbox.status).toBe(201);
    expect(mailbox.body).toEqual({ mailboxId: expect.any(String), tenantId: tenant.body.tenantId });
    expect(mailbox.headers['set-cookie']).toBeUndefined();
  });

  it('stores the Google client secret encrypted, never as typed', async () => {
    const { app, repositories, encryptionUtil } = createTestApp();
    const tenant = await request(app).post('/v1/tenants').send(testTenantBody);
    const stored = await repositories.tenantRepository.findTenantGoogleClient(tenant.body.tenantId);
    expect(stored?.clientId).toBe(testTenantBody.googleClientId);
    expect(stored?.encryptedClientSecret).not.toBe(testTenantBody.googleClientSecret);
    expect(stored?.encryptedClientSecret).toMatch(/^v1\./);
    expect(encryptionUtil.decryptSecret(stored!.encryptedClientSecret)).toBe(
      testTenantBody.googleClientSecret,
    );
  });

  it('rejects a tenant without its Google client or Pub/Sub push setup, naming every field', async () => {
    const app = createTestAppInstance();
    const response = await request(app).post('/v1/tenants').send({ name: 'Bhatia Desk' });
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/googleClientId/);
    expect(response.body.error).toMatch(/googleClientSecret/);
    expect(response.body.error).toMatch(/pubsubTopicName/);
    expect(response.body.error).toMatch(/pushServiceAccountEmail/);
  });

  it('stores the Pub/Sub topic and push service account, readable for watch and push verification', async () => {
    const { app, repositories } = createTestApp();
    const tenant = await request(app).post('/v1/tenants').send(testTenantBody);
    expect(tenant.status).toBe(201);
    expect(await repositories.tenantRepository.findTenantPubsubPush(tenant.body.tenantId)).toEqual({
      topicName: testTenantBody.pubsubTopicName,
      pushServiceAccountEmail: testTenantBody.pushServiceAccountEmail,
    });
  });

  it('rejects a bare topic id, a topic in another resource type, and a non-service-account email', async () => {
    const app = createTestAppInstance();
    for (const pubsubTopicName of [
      'gmail-notifications',
      'projects/bhatia-shipping-mail/subscriptions/gmail-notifications',
      'projects/Bhatia/topics/gmail-notifications',
    ]) {
      const response = await request(app)
        .post('/v1/tenants')
        .send({ ...testTenantBody, pubsubTopicName });
      expect(response.status, pubsubTopicName).toBe(400);
      expect(response.body.error).toMatch(/pubsubTopicName/);
    }
    const response = await request(app)
      .post('/v1/tenants')
      .send({ ...testTenantBody, pushServiceAccountEmail: 'ops@bhatia.example' });
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/pushServiceAccountEmail/);
  });

  it('unknown tenant is 404, duplicate email is 409, invalid body is 400 naming the fields', async () => {
    const app = createTestAppInstance();
    const unknown = await request(app)
      .post('/v1/tenants/00000000-0000-4000-8000-000000000000/mailboxes')
      .send(mailboxBody);
    expect(unknown.status).toBe(404);

    const tenant = await request(app).post('/v1/tenants').send(testTenantBody);
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
