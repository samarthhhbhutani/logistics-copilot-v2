/** Test-only server: real Express routes and cookie auth, in-memory repositories, fake Google. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashPassword, parseRawEmail } from '@lc/core';
import { createTestApp } from '../../api/src/testAppInstance.test-helper.js';
import {
  createFakeAttachmentDownloadUrlSigner,
  fakeDownloadUrlExpiresAt,
} from '../../api/src/fakeAttachmentDownloadUrlSigner.test-helper.js';

const port = Number(process.env.FRONTEND_TEST_PORT ?? 4181);
const imagePort = Number(process.env.FRONTEND_TEST_IMAGE_PORT ?? 4184);
const imagePath = '/synthetic/inlineImage/logo.png';
const fallbackSigner = createFakeAttachmentDownloadUrlSigner();
const testApp = createTestApp({
  frontendUrl: process.env.FRONTEND_TEST_ORIGIN ?? 'http://127.0.0.1:4180',
  attachmentDownloadUrlSigner: {
    createDownloadUrl: (attachment) =>
      attachment.s3Key === 'synthetic/inlineImage/logo.png'
        ? Promise.resolve({
            url: `https://127.0.0.1:${imagePort}${imagePath}?fileName=logo.png`,
            expiresAt: fakeDownloadUrlExpiresAt,
          })
        : fallbackSigner.createDownloadUrl(attachment),
  },
});
const { repositories, encryptionUtil, gmailOAuth } = testApp;
const { tenantId } = await repositories.tenantRepository.createTenant({
  name: 'Test logistics desk',
  googleClientId: 'synthetic-client',
  encryptedGoogleClientSecret: encryptionUtil.encryptSecret('synthetic-secret'),
  pubsubTopicName: 'projects/synthetic/topics/mail',
  pushServiceAccountEmail: 'push@synthetic.iam.gserviceaccount.com',
});
const passwordHash = await hashPassword('frontend-test-password');
const inlineImageEmail = await parseRawEmail(
  await readFile(
    new URL(
      '../../../packages/core/src/utils/mime/fixtures/inlineLogoSignature.eml',
      import.meta.url,
    ),
  ),
);
// Synthetic HTML only: a readable HTML-only booking with one tracker, and a message built from hostile markup.
const remoteImageUrl = `https://127.0.0.1:${imagePort}${imagePath}`;
const htmlOnlyBody = [
  '<style>.bookingHeader { color: #176087; background-color: #eaf4fa; padding: 18px; } @media (max-width: 600px) { .bookingHeader { padding: 10px; } }</style>',
  '<h2 class="bookingHeader">Booking confirmed</h2>',
  '<p>Vessel <strong>MSC Aurora</strong> departs Nhava Sheva on 18 November.</p>',
  '<table><tr><th>Container</th><th>Rate</th></tr><tr><td>40ft HC</td><td>USD 1,850</td></tr></table>',
  '<p><a href="https://carrier.example/track?booking=BK-1001">Track booking BK-1001</a></p>',
  '<p><a href="javascript:alert(1)">Unsafe link</a></p>',
  `<img src="${remoteImageUrl}?kind=logo" width="160" alt="Remote booking logo">`,
  `<img src="${remoteImageUrl}?kind=tracker" width="1" height="1" alt="">`,
].join('');
const hostileHtmlBody = [
  '<p>Updated shipping details are ready.</p>',
  `<img src="${remoteImageUrl}?kind=hostileTracker" onerror="alert(1)"><script>alert(1)</script>`,
  `<style>@import url("https://tracking.invalid/import.css"); .banner { background: url("${remoteImageUrl}?kind=cssBackground"); }</style>`,
  '<link rel="stylesheet" href="https://tracking.invalid/link.css">',
  `<div class="banner" style="background-image: url(${remoteImageUrl}?kind=inlineBackground)">Styled block</div>`,
  `<picture><source media="(max-width: 600px)" srcset="${remoteImageUrl}?kind=responsiveMobile 1x, ${remoteImageUrl}?kind=responsiveMobileRetina 2x"><img srcset="${remoteImageUrl}?kind=responsivePromo 1x, ${remoteImageUrl}?kind=responsivePromoRetina 2x" width="160" alt="Promo"></picture>`,
  '<svg><image href="https://tracking.invalid/svg.png"></image></svg>',
  '<iframe src="https://tracking.invalid/frame"></iframe><object data="https://tracking.invalid/object"></object>',
  '<form action="https://tracking.invalid/form"><input name="q"><button>Send</button></form>',
  '<a href="https://tracking.invalid/click" ping="https://tracking.invalid/ping">Open portal</a>',
  '<base href="https://tracking.invalid/"><meta http-equiv="refresh" content="0;url=https://tracking.invalid/refresh">',
].join('');
for (const [accountIndex, emailAddress] of [
  'ops@example.com',
  'sales@example.com',
  'new@example.com',
].entries()) {
  const { mailboxId } = await repositories.mailboxCredentialsRepository.createMailboxCredentials({
    tenantId,
    emailAddress,
    passwordHash,
  });
  if (accountIndex !== 2) {
    await repositories.mailboxConnectionRepository.saveGmailConnection(
      { tenantId, mailboxId },
      {
        encryptedRefreshToken: encryptionUtil.encryptSecret('synthetic-refresh'),
        lastHistoryId: 1000n,
        watchExpiresAt: new Date('2026-11-16T12:00:00Z'),
      },
    );
  }
  if (accountIndex === 2) continue;
  for (let index = 0; index < (accountIndex === 0 ? 35 : 1); index += 1) {
    // Keep pagination stable while replacing one generic row with a real MIME inline-image sample.
    if (accountIndex === 0 && index === 3) {
      const emailId = '00000000-0000-4000-8000-000000000003';
      repositories.addEmail({
        tenantId,
        mailboxId,
        id: emailId,
        gmailThreadId: '1003',
        gmailLabel: 'inbox',
        senderName: inlineImageEmail.from?.name ?? '',
        senderEmail: inlineImageEmail.from?.address ?? null,
        toRecipients: inlineImageEmail.to,
        ccRecipients: inlineImageEmail.cc,
        subject: `${inlineImageEmail.subject} (inline image sample)`,
        snippet: 'Clearance charges with an embedded company logo in the signature.',
        receivedAt: new Date('2026-11-09T12:56:00Z'),
        rfcMessageId: inlineImageEmail.messageId ?? null,
        bodyText: inlineImageEmail.text,
        bodyHtml: inlineImageEmail.html ?? null,
        classification: {
          label: 'general',
          source: 'user',
          confidence: null,
          classifiedAt: new Date('2026-11-09T13:00:00Z'),
        },
      });
      inlineImageEmail.attachments.forEach((attachment, attachmentIndex) => {
        repositories.addAttachment({
          tenantId,
          emailId,
          id: `00000000-0000-4000-8000-${String(300 + attachmentIndex).padStart(12, '0')}`,
          fileName: attachment.fileName,
          contentType: attachment.contentType,
          sizeBytes: attachment.sizeBytes,
          sha256: createHash('sha256').update(attachment.content).digest('hex'),
          s3Key: `synthetic/inlineImage/${attachment.fileName}`,
          isInline: attachment.isInline,
          contentId: attachment.contentId,
        });
      });
      continue;
    }
    repositories.addEmail({
      tenantId,
      mailboxId,
      id: `00000000-0000-4000-8000-${String(accountIndex * 100 + index).padStart(12, '0')}`,
      gmailThreadId: [0, 4, 5].includes(index) ? 'abc123' : (0x1000 + index).toString(16),
      gmailLabel: index % 5 === 4 ? 'sent' : 'inbox',
      senderName: index === 0 ? 'Ravi Kumar' : index === 1 ? '' : 'Coastal Shipping',
      senderEmail: index === 1 ? null : 'ravi@example.com',
      toRecipients: [{ name: 'Ocean Freight Desk', address: 'quotes@example.com' }],
      subject:
        accountIndex === 1
          ? 'Sales mailbox private conversation'
          : index === 0
            ? 'RFQ: Mumbai to Rotterdam · 2 × 40ft'
            : index === 1
              ? ''
              : `Shipment update ${index}`,
      snippet:
        index === 0
          ? 'Please share your best rate and the next available sailing for two containers.'
          : index === 2
            ? '<img src=x onerror=alert(1)> Hello'
            : 'The updated shipping details are ready for your review.',
      receivedAt: new Date(Date.UTC(2026, 10, 9, 12, 59 - index)),
      ccRecipients: index === 0 ? [{ name: 'Operations', address: 'operations@example.com' }] : [],
      bodyText:
        accountIndex === 1
          ? 'Sales-only private message body'
          : index === 0
            ? 'Thanks for the quote. Please hold two slots on the next sailing.\n\nRavi'
            : index === 4
              ? 'Our offer is attached. The next sailing is on Thursday.'
              : index === 5
                ? 'Please quote two 40ft containers from Mumbai to Rotterdam.\nCargo ready: 18 November.'
                : index === 1
                  ? ''
                  : index === 2
                    ? '<img src="https://tracking.invalid/pixel" onerror="alert(1)">\n<script>alert(1)</script>'
                    : 'The updated shipping details are ready for your review.',
      bodyHtml:
        accountIndex === 0 && index === 1
          ? htmlOnlyBody
          : accountIndex === 0 && index === 2
            ? hostileHtmlBody
            : null,
      classification:
        index % 5 === 4 || index === 1
          ? null
          : {
              label:
                index === 0
                  ? 'customer_reply'
                  : index === 5
                    ? 'customer_request'
                    : index === 2
                      ? 'rate_card'
                      : 'general',
              source: index === 0 ? 'thread' : index === 5 ? 'llm' : index === 2 ? 'rule' : 'user',
              confidence: index === 5 ? 0.94 : null,
              classifiedAt: new Date('2026-11-09T13:00:00Z'),
            },
    });
  }
  if (accountIndex === 0) {
    for (const [index, fileName] of ['sailing-offer.pdf', 'signature.png'].entries()) {
      repositories.addAttachment({
        tenantId,
        emailId: '00000000-0000-4000-8000-000000000000',
        id: `00000000-0000-4000-8000-00000000020${index}`,
        fileName,
        contentType: index === 0 ? 'application/pdf' : 'image/png',
        sizeBytes: 2048,
        sha256: 'ab'.repeat(32),
        s3Key: `synthetic/${fileName}`,
        isInline: index === 1,
        contentId: index === 1 ? 'signature' : undefined,
      });
    }
  }
}
gmailOAuth.buildConsentUrl = ({ state, loginHint }) => {
  gmailOAuth.consentingAccountEmail = loginHint ?? 'new@example.com';
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('state', state);
  return url.toString();
};
const server = testApp.app.listen(port, '127.0.0.1', () =>
  console.log(`Synthetic frontend API on ${port}`),
);
// The frame has an opaque origin. Chrome may bypass Playwright's route for its second
// image fetch, so serve the fixture over real HTTPS instead of intercepting a fake host.
// The certificate is generated only for this local test process and never committed.
const certificateDirectory = mkdtempSync(join(tmpdir(), 'logistics-copilot-e2e-image-'));
const keyFile = join(certificateDirectory, 'key.pem');
const certificateFile = join(certificateDirectory, 'certificate.pem');
execFileSync(
  'openssl',
  [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '1',
    '-subj',
    '/CN=127.0.0.1',
    '-addext',
    'subjectAltName=IP:127.0.0.1',
    '-keyout',
    keyFile,
    '-out',
    certificateFile,
  ],
  { stdio: 'ignore' },
);
const imageBytes = inlineImageEmail.attachments.find(
  (attachment) => attachment.fileName === 'logo.png',
)?.content;
if (!imageBytes) throw new Error('synthetic inline logo is missing');
const responsiveImageBytes = await readFile(
  new URL('./fixtures/responsiveLogo.png', import.meta.url),
);
const imageServer = createServer(
  { key: readFileSync(keyFile), cert: readFileSync(certificateFile) },
  (request, response) => {
    if (
      request.method !== 'GET' ||
      new URL(request.url ?? '/', 'https://127.0.0.1').pathname !== imagePath ||
      request.headers.referer
    ) {
      response.writeHead(403).end();
      return;
    }
    response.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
    const requestUrl = new URL(request.url ?? '/', 'https://127.0.0.1');
    response.end(
      requestUrl.searchParams.get('kind')?.startsWith('responsive')
        ? responsiveImageBytes
        : imageBytes,
    );
  },
);
imageServer.listen(imagePort, '127.0.0.1');
process.on('SIGTERM', () => {
  imageServer.close();
  server.close();
});
process.on('exit', () => rmSync(certificateDirectory, { recursive: true, force: true }));
