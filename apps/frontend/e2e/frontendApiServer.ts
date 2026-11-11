/** Test-only server: real Express routes and cookie auth, in-memory repositories, fake Google. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { hashPassword, parseRawEmail } from '@lc/core';
import { createTestApp } from '../../api/src/testAppInstance.test-helper.js';

const port = Number(process.env.FRONTEND_TEST_PORT ?? 4181);
const testApp = createTestApp({
  frontendUrl: process.env.FRONTEND_TEST_ORIGIN ?? 'http://127.0.0.1:4180',
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
        '<img src="https://tracking.invalid/pixel" onerror="alert(1)"><script>alert(1)</script>',
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
process.on('SIGTERM', () => server.close());
