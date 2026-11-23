import { createHash } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { REPLY_ATTACHMENT_MAX_BYTES } from '@lc/contract';
import { testTenantBody } from '../tenantFixture.test-helper.js';
import { createTestApp, testMailboxEmail } from '../testAppInstance.test-helper.js';
import type { TestApp } from '../testAppInstance.test-helper.js';

const password = 'a-long-enough-password';
const attachmentsPath = '/v1/mailbox/reply-attachments';
/** Enough of a PDF header for file-type to recognise it. */
const tinyPdf = Buffer.concat([Buffer.from('%PDF-1.7\n', 'ascii'), Buffer.alloc(16, 0)]);
/** The DOS header file-type reads as an executable. */
const tinyExe = Buffer.concat([Buffer.from('MZ', 'ascii'), Buffer.alloc(64, 0)]);
const csv = Buffer.from('container,eta\nMSKU1234567,2026-12-01\n', 'utf8');

async function signedInMailbox({
  app,
}: TestApp): Promise<{ cookie: string; mailboxId: string; tenantId: string }> {
  const tenant = await request(app).post('/v1/tenants').send(testTenantBody);
  const mailbox = await request(app)
    .post(`/v1/tenants/${tenant.body.tenantId}/mailboxes`)
    .send({ email: testMailboxEmail, password });
  const login = await request(app)
    .post('/v1/auth/login')
    .send({ email: testMailboxEmail, password });
  const setCookie = login.headers['set-cookie'];
  const cookies = Array.isArray(setCookie) ? setCookie : [String(setCookie)];
  return {
    cookie: cookies.find((cookie) => cookie.startsWith('lc_session='))!,
    mailboxId: mailbox.body.mailboxId,
    tenantId: tenant.body.tenantId,
  };
}

function upload(
  testApp: TestApp,
  cookie: string,
  content: Buffer,
  fileName: string,
  contentType: string | undefined,
) {
  const pending = request(testApp.app)
    .post(attachmentsPath)
    .query({ fileName })
    .set('Cookie', cookie);
  return (contentType ? pending.set('Content-Type', contentType) : pending).send(content);
}

describe('/v1/mailbox/reply-attachments', () => {
  it('stores the bytes under the tenant, records the row unsent, and deletes while no mail carries it', async () => {
    const testApp = createTestApp();
    const { cookie, mailboxId, tenantId } = await signedInMailbox(testApp);

    const uploaded = await upload(testApp, cookie, tinyPdf, 'Rate card.pdf', 'application/pdf');
    expect(uploaded.status).toBe(201);
    expect(uploaded.body).toEqual({
      id: expect.any(String),
      fileName: 'Rate card.pdf',
      contentType: 'application/pdf',
      sizeBytes: tinyPdf.length,
      createdAt: expect.any(String),
    });
    const s3Key = `${tenantId}/outbound/${mailboxId}/${uploaded.body.id}`;
    expect(testApp.replyAttachmentStore.objects.get(s3Key)).toEqual({
      content: tinyPdf,
      contentType: 'application/pdf',
    });
    const [row] = await testApp.repositories.replyAttachmentRepository.findReplyAttachments(
      { tenantId, mailboxId },
      [uploaded.body.id],
    );
    expect(row).toMatchObject({
      s3Key,
      sentMailId: null,
      sha256: createHash('sha256').update(tinyPdf).digest('hex'),
    });

    const deleted = await request(testApp.app)
      .delete(`${attachmentsPath}/${uploaded.body.id}`)
      .set('Cookie', cookie);
    expect(deleted.status).toBe(204);
    expect(testApp.replyAttachmentStore.objects.size).toBe(0);
    expect(
      (
        await request(testApp.app)
          .delete(`${attachmentsPath}/${uploaded.body.id}`)
          .set('Cookie', cookie)
      ).status,
    ).toBe(404);
  });

  it('keeps the declared type when the bytes say nothing, falls back to octet-stream, and prefers what the bytes are', async () => {
    const testApp = createTestApp();
    const { cookie } = await signedInMailbox(testApp);

    const declared = await upload(testApp, cookie, csv, 'eta.csv', 'text/csv; charset=utf-8');
    expect(declared.body.contentType).toBe('text/csv');

    const untyped = await upload(testApp, cookie, csv, 'eta.csv', undefined);
    expect(untyped.status).toBe(201);
    expect(untyped.body.contentType).toBe('application/octet-stream');

    const misdeclared = await upload(testApp, cookie, tinyPdf, 'scan.bin', 'text/plain');
    expect(misdeclared.body.contentType).toBe('application/pdf');
  });

  it('refuses a file once a sent mail carries it', async () => {
    const testApp = createTestApp();
    const { cookie, mailboxId, tenantId } = await signedInMailbox(testApp);
    const uploaded = await upload(testApp, cookie, tinyPdf, 'Rate card.pdf', 'application/pdf');
    const changed = await testApp.repositories.replyAttachmentRepository.attachToSentMail(
      { tenantId, mailboxId },
      [uploaded.body.id],
      '00000000-0000-4000-8000-000000000050',
    );
    expect(changed).toBe(1);
    const deleted = await request(testApp.app)
      .delete(`${attachmentsPath}/${uploaded.body.id}`)
      .set('Cookie', cookie);
    expect(deleted.status).toBe(404);
    expect(testApp.replyAttachmentStore.objects.size).toBe(1);
  });

  it('keeps the row deletion even when the bucket delete fails', async () => {
    const testApp = createTestApp();
    const { cookie } = await signedInMailbox(testApp);
    const uploaded = await upload(testApp, cookie, csv, 'eta.csv', 'text/csv');
    testApp.replyAttachmentStore.failNextDelete = true;
    const deleted = await request(testApp.app)
      .delete(`${attachmentsPath}/${uploaded.body.id}`)
      .set('Cookie', cookie);
    expect(deleted.status).toBe(204);
    expect(testApp.replyAttachmentStore.objects.size).toBe(1);
    expect(
      (
        await request(testApp.app)
          .delete(`${attachmentsPath}/${uploaded.body.id}`)
          .set('Cookie', cookie)
      ).status,
    ).toBe(404);
  });

  it('refuses what Gmail would refuse (by name or by bytes), empty and oversize files, a missing name, and no session', async () => {
    const testApp = createTestApp();
    const { cookie } = await signedInMailbox(testApp);

    const byName = await upload(testApp, cookie, csv, 'macro.js', 'text/javascript');
    expect(byName.status).toBe(415);
    expect(byName.body.error).toBe('blocked_file_type');

    const byBytes = await upload(testApp, cookie, tinyExe, 'notes.txt', 'text/plain');
    expect(byBytes.status).toBe(415);
    expect(byBytes.body.error).toBe('blocked_file_type');

    const empty = await upload(testApp, cookie, Buffer.alloc(0), 'empty.txt', 'text/plain');
    expect(empty.status).toBe(400);
    expect(empty.body.error).toBe('empty_attachment');

    const oversize = await upload(
      testApp,
      cookie,
      Buffer.alloc(REPLY_ATTACHMENT_MAX_BYTES + 1, 1),
      'big.bin',
      'application/octet-stream',
    );
    expect(oversize.status).toBe(413);
    expect(oversize.body.error).toBe('attachment_too_large');

    const unnamed = await request(testApp.app)
      .post(attachmentsPath)
      .set('Cookie', cookie)
      .set('Content-Type', 'text/csv')
      .send(csv);
    expect(unnamed.status).toBe(400);

    expect(testApp.replyAttachmentStore.objects.size).toBe(0);
    expect(
      (await request(testApp.app).post(attachmentsPath).query({ fileName: 'x.csv' })).status,
    ).toBe(401);
  });

  it('answers 503 without a bucket', async () => {
    const testApp = createTestApp({ replyAttachmentsEnabled: false });
    const { cookie } = await signedInMailbox(testApp);
    const uploaded = await upload(testApp, cookie, csv, 'eta.csv', 'text/csv');
    expect(uploaded.status).toBe(503);
    expect(uploaded.body.error).toBe('reply_attachments_unavailable');
    const deleted = await request(testApp.app)
      .delete(`${attachmentsPath}/00000000-0000-4000-8000-00000000000a`)
      .set('Cookie', cookie);
    expect(deleted.status).toBe(503);
  });
});
