import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { testTenantBody } from '../tenantFixture.test-helper.js';
import {
  createTestApp,
  operatorSessionHeader,
  testMailboxEmail,
} from '../testAppInstance.test-helper.js';
import type { TestApp } from '../testAppInstance.test-helper.js';

const password = 'a-long-enough-password';
const vendorsPath = '/v1/mailbox/vendors';

async function signedInMailbox(
  { app }: TestApp,
  email = testMailboxEmail,
  tenantBody = testTenantBody,
): Promise<{ cookie: string }> {
  const tenant = await request(app).post('/v1/tenants').set(operatorSessionHeader).send(tenantBody);
  await request(app)
    .post(`/v1/tenants/${tenant.body.tenantId}/mailboxes`)
    .set(operatorSessionHeader)
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

describe('PATCH /v1/mailbox/vendors/:vendorId', () => {
  async function createdVendor(testApp: TestApp, cookie: string, body: unknown = seaLinesBody) {
    const created = await request(testApp.app).post(vendorsPath).set('Cookie', cookie).send(body);
    expect(created.status).toBe(201);
    return created.body as { id: string; contacts: { id: string; emailAddress: string }[] };
  }

  it('renames, recategorises, edits notes and archives, answering the whole vendor each time', async () => {
    const testApp = createTestApp();
    const { cookie } = await signedInMailbox(testApp);
    const vendor = await createdVendor(testApp, cookie);

    const renamed = await request(testApp.app)
      .patch(`${vendorsPath}/${vendor.id}`)
      .set('Cookie', cookie)
      .send({ vendorName: ' Sea Lines Ltd ', category: 'cha', notes: '' });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({
      id: vendor.id,
      vendorName: 'Sea Lines Ltd',
      category: 'cha',
      notes: null,
      active: true,
    });
    expect(renamed.body.contacts).toHaveLength(2);

    const archived = await request(testApp.app)
      .patch(`${vendorsPath}/${vendor.id}`)
      .set('Cookie', cookie)
      .send({ active: false });
    expect(archived.status).toBe(200);
    expect(archived.body.active).toBe(false);

    const listed = await request(testApp.app).get(vendorsPath).set('Cookie', cookie);
    expect(listed.body.vendors).toHaveLength(1);
    expect(listed.body.vendors[0].active).toBe(false);
  });

  it('refuses a rename onto another vendor of the tenant (any case) but allows re-spelling itself', async () => {
    const testApp = createTestApp();
    const { cookie } = await signedInMailbox(testApp);
    const seaLines = await createdVendor(testApp, cookie);
    await createdVendor(testApp, cookie, { vendorName: 'Clear Customs', category: 'cha' });

    const clash = await request(testApp.app)
      .patch(`${vendorsPath}/${seaLines.id}`)
      .set('Cookie', cookie)
      .send({ vendorName: 'clear customs' });
    expect(clash.status).toBe(409);
    expect(clash.body.error).toBe('vendor_name_taken');

    const respelled = await request(testApp.app)
      .patch(`${vendorsPath}/${seaLines.id}`)
      .set('Cookie', cookie)
      .send({ vendorName: 'SEA LINES PVT LTD' });
    expect(respelled.status).toBe(200);
    expect(respelled.body.vendorName).toBe('SEA LINES PVT LTD');
  });

  it('answers 400 for an empty body and 404 for an unknown, malformed or other-tenant vendor', async () => {
    const testApp = createTestApp();
    const { cookie } = await signedInMailbox(testApp);
    const other = await signedInMailbox(testApp, 'other@desk.com', {
      ...testTenantBody,
      name: 'Other Desk',
    });
    const vendor = await createdVendor(testApp, cookie);

    const empty = await request(testApp.app)
      .patch(`${vendorsPath}/${vendor.id}`)
      .set('Cookie', cookie)
      .send({});
    expect(empty.status).toBe(400);

    for (const [label, id, who] of [
      ['unknown', '00000000-0000-4000-8000-000000000009', cookie],
      ['malformed', 'not-a-uuid', cookie],
      ['other tenant', vendor.id, other.cookie],
    ] as const) {
      const response = await request(testApp.app)
        .patch(`${vendorsPath}/${id}`)
        .set('Cookie', who)
        .send({ notes: 'x' });
      expect(response.status, label).toBe(404);
    }

    const unknownWithClashingName = await request(testApp.app)
      .patch(`${vendorsPath}/00000000-0000-4000-8000-000000000009`)
      .set('Cookie', cookie)
      .send({ vendorName: 'Sea Lines Pvt Ltd' });
    expect(unknownWithClashingName.status, 'not found beats name taken').toBe(404);
  });

  it('adds a contact, refuses a duplicate address, and edits or archives a contact', async () => {
    const testApp = createTestApp();
    const { cookie } = await signedInMailbox(testApp);
    const vendor = await createdVendor(testApp, cookie, {
      vendorName: 'Clear Customs',
      category: 'cha',
    });

    const added = await request(testApp.app)
      .post(`${vendorsPath}/${vendor.id}/contacts`)
      .set('Cookie', cookie)
      .send({ contactName: 'Dev Patel', emailAddress: ' Dev@Clear.com ', phoneNumber: '' });
    expect(added.status).toBe(200);
    expect(added.body.contacts).toEqual([
      expect.objectContaining({
        contactName: 'Dev Patel',
        emailAddress: 'dev@clear.com',
        phoneNumber: null,
        active: true,
      }),
    ]);
    const contactId = added.body.contacts[0].id as string;

    const duplicate = await request(testApp.app)
      .post(`${vendorsPath}/${vendor.id}/contacts`)
      .set('Cookie', cookie)
      .send({ contactName: 'Dev again', emailAddress: 'DEV@clear.com' });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error).toBe('contact_email_taken');

    const edited = await request(testApp.app)
      .patch(`${vendorsPath}/${vendor.id}/contacts/${contactId}`)
      .set('Cookie', cookie)
      .send({ phoneNumber: '+91 98200 11111', active: false });
    expect(edited.status).toBe(200);
    expect(edited.body.contacts[0]).toMatchObject({
      id: contactId,
      phoneNumber: '+91 98200 11111',
      active: false,
    });

    const unknownVendor = await request(testApp.app)
      .post(`${vendorsPath}/00000000-0000-4000-8000-000000000009/contacts`)
      .set('Cookie', cookie)
      .send({ contactName: 'X', emailAddress: 'x@clear.com' });
    expect(unknownVendor.status).toBe(404);
    expect(unknownVendor.body.error).toBe('vendor_not_found');

    const unknownContact = await request(testApp.app)
      .patch(`${vendorsPath}/${vendor.id}/contacts/00000000-0000-4000-8000-000000000009`)
      .set('Cookie', cookie)
      .send({ contactName: 'Y' });
    expect(unknownContact.status).toBe(404);
    expect(unknownContact.body.error).toBe('contact_not_found');
  });

  it('refuses to move a contact onto an address another contact of the vendor already has', async () => {
    const testApp = createTestApp();
    const { cookie } = await signedInMailbox(testApp);
    const vendor = await createdVendor(testApp, cookie);
    const arjun = vendor.contacts.find((contact) => contact.emailAddress === 'arjun@sealines.com')!;

    const clash = await request(testApp.app)
      .patch(`${vendorsPath}/${vendor.id}/contacts/${arjun.id}`)
      .set('Cookie', cookie)
      .send({ emailAddress: 'priya@sealines.com' });
    expect(clash.status).toBe(409);
    expect(clash.body.error).toBe('contact_email_taken');
  });
});
