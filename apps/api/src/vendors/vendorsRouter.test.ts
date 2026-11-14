import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { testTenantBody } from '../tenantFixture.test-helper.js';
import { createTestApp, testMailboxEmail } from '../testAppInstance.test-helper.js';
import type { TestApp } from '../testAppInstance.test-helper.js';

const password = 'a-long-enough-password';
const vendorsPath = '/v1/mailbox/vendors';

async function signedInMailbox(
  { app }: TestApp,
  email = testMailboxEmail,
  tenantBody = testTenantBody,
): Promise<{ cookie: string }> {
  const tenant = await request(app).post('/v1/tenants').send(tenantBody);
  await request(app)
    .post(`/v1/tenants/${tenant.body.tenantId}/mailboxes`)
    .send({ email, password });
  const login = await request(app).post('/v1/auth/login').send({ email, password });
  const setCookie = login.headers['set-cookie'];
  const cookies = Array.isArray(setCookie) ? setCookie : [String(setCookie)];
  return { cookie: cookies.find((cookie) => cookie.startsWith('lc_session='))! };
}

const seaLinesBody = {
  vendorName: '  Sea Lines Pvt Ltd ',
  category: 'carrier',
  notes: ' Strong on Nhava Sheva to Rotterdam. ',
  contacts: [
    {
      contactName: 'Priya Nair',
      emailAddress: ' Priya@SeaLines.com ',
      phoneNumber: '+91 98200 00000',
    },
    { contactName: 'Arjun Mehta', emailAddress: 'arjun@sealines.com' },
  ],
};

describe('POST /v1/mailbox/vendors', () => {
  it('creates the vendor with its contacts in one request, normalising names and addresses', async () => {
    const testApp = createTestApp();
    const { cookie } = await signedInMailbox(testApp);

    const created = await request(testApp.app)
      .post(vendorsPath)
      .set('Cookie', cookie)
      .send(seaLinesBody);

    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      vendorName: 'Sea Lines Pvt Ltd',
      category: 'carrier',
      notes: 'Strong on Nhava Sheva to Rotterdam.',
      active: true,
    });
    expect(z.uuid().safeParse(created.body.id).success).toBe(true);
    expect(created.body.contacts).toEqual([
      expect.objectContaining({
        contactName: 'Arjun Mehta',
        emailAddress: 'arjun@sealines.com',
        phoneNumber: null,
        active: true,
      }),
      expect.objectContaining({
        contactName: 'Priya Nair',
        emailAddress: 'priya@sealines.com',
        phoneNumber: '+91 98200 00000',
        active: true,
      }),
    ]);
    expect(new Date(created.body.createdAt).getTime()).not.toBeNaN();
  });

  it('creates a vendor with no contacts yet, with or without the contacts field', async () => {
    const testApp = createTestApp();
    const { cookie } = await signedInMailbox(testApp);

    const withEmpty = await request(testApp.app)
      .post(vendorsPath)
      .set('Cookie', cookie)
      .send({ vendorName: 'Clear Customs', category: 'cha', contacts: [] });
    const withoutField = await request(testApp.app)
      .post(vendorsPath)
      .set('Cookie', cookie)
      .send({ vendorName: 'Fast Freight', category: 'carrier' });

    expect(withEmpty.status).toBe(201);
    expect(withEmpty.body.contacts).toEqual([]);
    expect(withoutField.status).toBe(201);
    expect(withoutField.body.contacts).toEqual([]);
  });

  it('stores blank notes and phone numbers as null', async () => {
    const testApp = createTestApp();
    const { cookie } = await signedInMailbox(testApp);

    const created = await request(testApp.app)
      .post(vendorsPath)
      .set('Cookie', cookie)
      .send({
        vendorName: 'Clear Customs',
        category: 'cha',
        notes: '   ',
        contacts: [{ contactName: 'Dev', emailAddress: 'dev@clear.com', phoneNumber: '' }],
      });

    expect(created.status).toBe(201);
    expect(created.body.notes).toBeNull();
    expect(created.body.contacts[0].phoneNumber).toBeNull();
  });

  it('answers 409 vendor_name_taken for a second vendor of the same name in the tenant, whatever the case', async () => {
    const testApp = createTestApp();
    const { cookie } = await signedInMailbox(testApp);
    await request(testApp.app).post(vendorsPath).set('Cookie', cookie).send(seaLinesBody);

    const duplicate = await request(testApp.app)
      .post(vendorsPath)
      .set('Cookie', cookie)
      .send({
        ...seaLinesBody,
        vendorName: 'SEA LINES pvt ltd',
        contacts: [{ contactName: 'X', emailAddress: 'x@sealines.com' }],
      });

    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error).toBe('vendor_name_taken');
  });

  it('rejects an unknown category, a bad address, two contacts sharing an address, and a blank name', async () => {
    const testApp = createTestApp();
    const { cookie } = await signedInMailbox(testApp);
    const post = (body: unknown) =>
      request(testApp.app).post(vendorsPath).set('Cookie', cookie).send(body);
    const contact = { contactName: 'Priya', emailAddress: 'priya@sealines.com' };

    const cases: [string, unknown, RegExp][] = [
      [
        'category',
        { vendorName: 'A', category: 'forwarder', contacts: [contact] },
        /^invalid_body: category/,
      ],
      [
        'bad address',
        { vendorName: 'A', category: 'cha', contacts: [{ ...contact, emailAddress: 'priya' }] },
        /^invalid_body: contacts/,
      ],
      [
        'shared address',
        {
          vendorName: 'A',
          category: 'cha',
          contacts: [contact, { ...contact, emailAddress: 'PRIYA@sealines.com' }],
        },
        /^invalid_body: contacts/,
      ],
      [
        'blank name',
        { vendorName: '  ', category: 'cha', contacts: [contact] },
        /^invalid_body: vendorName/,
      ],
    ];
    for (const [label, body, errorPattern] of cases) {
      const response = await post(body);
      expect(response.status, label).toBe(400);
      expect(response.body.error, label).toMatch(errorPattern);
    }
  });

  it('requires a session', async () => {
    const testApp = createTestApp();
    expect((await request(testApp.app).post(vendorsPath).send(seaLinesBody)).status).toBe(401);
    expect((await request(testApp.app).get(vendorsPath)).status).toBe(401);
  });
});

describe('GET /v1/mailbox/vendors', () => {
  it('lists the tenant vendors by name with their contacts, and never another tenant vendors', async () => {
    const testApp = createTestApp();
    const { cookie } = await signedInMailbox(testApp);
    const other = await signedInMailbox(testApp, 'other@desk.com', {
      ...testTenantBody,
      name: 'Other Desk',
    });
    await request(testApp.app).post(vendorsPath).set('Cookie', cookie).send(seaLinesBody);
    await request(testApp.app)
      .post(vendorsPath)
      .set('Cookie', cookie)
      .send({
        vendorName: 'Clear Customs',
        category: 'cha',
        contacts: [{ contactName: 'Dev', emailAddress: 'dev@clear.com' }],
      });
    await request(testApp.app)
      .post(vendorsPath)
      .set('Cookie', other.cookie)
      .send({
        vendorName: 'Other Carrier',
        category: 'carrier',
        contacts: [{ contactName: 'O', emailAddress: 'o@other.com' }],
      });

    const listed = await request(testApp.app).get(vendorsPath).set('Cookie', cookie);

    expect(listed.status).toBe(200);
    expect(listed.body.vendors.map((vendor: { vendorName: string }) => vendor.vendorName)).toEqual([
      'Clear Customs',
      'Sea Lines Pvt Ltd',
    ]);
    expect(listed.body.vendors[1].contacts).toHaveLength(2);

    const otherListed = await request(testApp.app).get(vendorsPath).set('Cookie', other.cookie);
    expect(
      otherListed.body.vendors.map((vendor: { vendorName: string }) => vendor.vendorName),
    ).toEqual(['Other Carrier']);
  });
});
