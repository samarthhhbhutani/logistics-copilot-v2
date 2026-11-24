import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { SIGNATURE_IMAGE_MAX_BYTES } from '@lc/contract';
import { testTenantBody } from '../tenantFixture.test-helper.js';
import {
  tinyGif,
  tinyJpeg,
  tinyPng,
  uploadSignatureImage,
} from '../signatureImageFixture.test-helper.js';
import {
  createTestApp,
  operatorAuthorizationHeader,
  testMailboxEmail,
} from '../testAppInstance.test-helper.js';
import type { TestApp } from '../testAppInstance.test-helper.js';

const password = 'a-long-enough-password';
const imagesPath = '/v1/mailbox/signature/images';

async function signedInMailbox({ app }: TestApp): Promise<{ cookie: string; mailboxId: string }> {
  const tenant = await request(app)
    .post('/v1/tenants')
    .set(operatorAuthorizationHeader)
    .send(testTenantBody);
  const mailbox = await request(app)
    .post(`/v1/tenants/${tenant.body.tenantId}/mailboxes`)
    .set(operatorAuthorizationHeader)
    .send({ email: testMailboxEmail, password });
  const login = await request(app)
    .post('/v1/auth/login')
    .send({ email: testMailboxEmail, password });
  const setCookie = login.headers['set-cookie'];
  const cookies = Array.isArray(setCookie) ? setCookie : [String(setCookie)];
  return {
    cookie: cookies.find((cookie) => cookie.startsWith('lc_session='))!,
    mailboxId: mailbox.body.mailboxId,
  };
}

describe('/v1/mailbox/signature/images', () => {
  it('uploads, lists with preview links, guards the signature reference, and deletes once unreferenced', async () => {
    const testApp = createTestApp();
    const { cookie, mailboxId } = await signedInMailbox(testApp);
    const agent = request(testApp.app);

    expect((await agent.get(imagesPath).set('Cookie', cookie)).body).toEqual({ images: [] });

    const logo = await uploadSignatureImage(testApp.app, cookie, tinyPng, 'image/png', 'logo.png');
    expect(logo).toMatchObject({
      fileName: 'logo.png',
      contentType: 'image/png',
      sizeBytes: tinyPng.length,
      contentId: logo.id,
      previewUrl: `https://fake-bucket.example/signatures/${mailboxId}/${logo.id}?preview=1`,
      previewUrlExpiresAt: '2026-11-20T01:00:00.000Z',
    });
    expect(testApp.signatureImageStore.objects.get(`signatures/${mailboxId}/${logo.id}`)).toEqual({
      content: tinyPng,
      contentType: 'image/png',
    });
    const badge = await uploadSignatureImage(testApp.app, cookie, tinyGif, 'image/gif');
    expect(badge.fileName).toBe('image.gif');

    const listed = await agent.get(imagesPath).set('Cookie', cookie);
    expect(listed.body.images.map((image: { id: string }) => image.id)).toEqual([
      logo.id,
      badge.id,
    ]);

    // The sanitiser keeps only this mailbox's images: the unknown cid is dropped whole.
    const saved = await agent
      .patch('/v1/mailbox/signature')
      .set('Cookie', cookie)
      .send({
        signatureHtml: `<p>Ops Desk</p><img src="cid:${logo.id}" alt="Bhatia"><img src="cid:not-ours">`,
      });
    expect(saved.body.signatureHtml).toBe(
      `<p>Ops Desk</p><img src="cid:${logo.id}" alt="Bhatia" />`,
    );

    const inUse = await agent.delete(`${imagesPath}/${logo.id}`).set('Cookie', cookie);
    expect(inUse.status).toBe(409);
    expect(inUse.body.error).toBe('signature_image_in_use');
    expect((await agent.delete(`${imagesPath}/${badge.id}`).set('Cookie', cookie)).status).toBe(
      204,
    );

    await agent.patch('/v1/mailbox/signature').set('Cookie', cookie).send({ signatureHtml: null });
    expect((await agent.delete(`${imagesPath}/${logo.id}`).set('Cookie', cookie)).status).toBe(204);
    expect(testApp.signatureImageStore.objects.size).toBe(0);
    expect((await agent.delete(`${imagesPath}/${logo.id}`).set('Cookie', cookie)).status).toBe(404);
    expect((await agent.get(imagesPath).set('Cookie', cookie)).body).toEqual({ images: [] });
  });

  it('keeps the row deletion even when the bucket delete fails', async () => {
    const testApp = createTestApp();
    const { cookie } = await signedInMailbox(testApp);
    const image = await uploadSignatureImage(testApp.app, cookie, tinyJpeg, 'image/jpeg');
    testApp.signatureImageStore.failNextDelete = true;
    const deleted = await request(testApp.app)
      .delete(`${imagesPath}/${image.id}`)
      .set('Cookie', cookie);
    expect(deleted.status).toBe(204);
    expect((await request(testApp.app).get(imagesPath).set('Cookie', cookie)).body).toEqual({
      images: [],
    });
    expect(testApp.signatureImageStore.objects.size).toBe(1);
  });

  it('refuses other content types, bytes that are not the declared type, oversize files, a sixth image, and no session', async () => {
    const testApp = createTestApp();
    const { cookie } = await signedInMailbox(testApp);
    const agent = request(testApp.app);

    const text = await agent
      .post(imagesPath)
      .set('Cookie', cookie)
      .set('Content-Type', 'text/plain')
      .send('not an image');
    expect(text.status).toBe(415);
    expect(text.body.error).toBe('unsupported_image_type');

    const svg = await agent
      .post(imagesPath)
      .set('Cookie', cookie)
      .set('Content-Type', 'image/svg+xml')
      .send('<svg onload="alert(1)"></svg>');
    expect(svg.status).toBe(415);

    const mislabelled = await agent
      .post(imagesPath)
      .set('Cookie', cookie)
      .set('Content-Type', 'image/png')
      .send(tinyGif);
    expect(mislabelled.status).toBe(415);
    expect(mislabelled.body.error).toBe('unsupported_image_type');

    const oversize = await agent
      .post(imagesPath)
      .set('Cookie', cookie)
      .set('Content-Type', 'image/png')
      .send(Buffer.concat([tinyPng, Buffer.alloc(SIGNATURE_IMAGE_MAX_BYTES, 1)]));
    expect(oversize.status).toBe(413);
    expect(oversize.body.error).toBe('image_too_large');

    const empty = await agent
      .post(imagesPath)
      .set('Cookie', cookie)
      .set('Content-Type', 'image/png')
      .send(Buffer.alloc(0));
    expect(empty.status).toBe(415);

    const badName = await agent
      .post(imagesPath)
      .query({ fileName: 'x'.repeat(201) })
      .set('Cookie', cookie)
      .set('Content-Type', 'image/png')
      .send(tinyPng);
    expect(badName.status).toBe(400);

    for (let index = 0; index < 5; index += 1) {
      await uploadSignatureImage(testApp.app, cookie, tinyPng, 'image/png', `logo-${index}.png`);
    }
    const sixth = await agent
      .post(imagesPath)
      .set('Cookie', cookie)
      .set('Content-Type', 'image/png')
      .send(tinyPng);
    expect(sixth.status).toBe(409);
    expect(sixth.body.error).toBe('signature_image_limit_reached');
    expect(testApp.signatureImageStore.objects.size).toBe(5);

    expect((await agent.get(imagesPath)).status).toBe(401);
    expect(
      (await agent.post(imagesPath).set('Content-Type', 'image/png').send(tinyPng)).status,
    ).toBe(401);
  });

  it('answers 503 on every route when no bucket is configured', async () => {
    const testApp = createTestApp({ signatureImagesEnabled: false });
    const { cookie } = await signedInMailbox(testApp);
    const agent = request(testApp.app);
    const listed = await agent.get(imagesPath).set('Cookie', cookie);
    expect(listed.status).toBe(503);
    expect(listed.body.error).toBe('signature_images_unavailable');
    expect(
      (
        await agent
          .post(imagesPath)
          .set('Cookie', cookie)
          .set('Content-Type', 'image/png')
          .send(tinyPng)
      ).status,
    ).toBe(503);
    expect(
      (
        await agent
          .delete(`${imagesPath}/00000000-0000-4000-8000-000000000001`)
          .set('Cookie', cookie)
      ).status,
    ).toBe(503);
  });

  it("does not show or delete another mailbox's images", async () => {
    const testApp = createTestApp();
    const owner = await signedInMailbox(testApp);
    const image = await uploadSignatureImage(testApp.app, owner.cookie, tinyPng, 'image/png');
    const other = await request(testApp.app)
      .post(
        `/v1/tenants/${
          (
            await request(testApp.app)
              .post('/v1/tenants')
              .set(operatorAuthorizationHeader)
              .send({ ...testTenantBody, name: 'Other Forwarders' })
          ).body.tenantId
        }/mailboxes`,
      )
      .set(operatorAuthorizationHeader)
      .send({ email: 'ops@other.example', password });
    expect(other.status).toBe(201);
    const login = await request(testApp.app)
      .post('/v1/auth/login')
      .send({ email: 'ops@other.example', password });
    const setCookie = login.headers['set-cookie'];
    const otherCookie = (Array.isArray(setCookie) ? setCookie : [String(setCookie)]).find(
      (cookie) => cookie.startsWith('lc_session='),
    )!;
    expect((await request(testApp.app).get(imagesPath).set('Cookie', otherCookie)).body).toEqual({
      images: [],
    });
    expect(
      (await request(testApp.app).delete(`${imagesPath}/${image.id}`).set('Cookie', otherCookie))
        .status,
    ).toBe(404);
  });
});
