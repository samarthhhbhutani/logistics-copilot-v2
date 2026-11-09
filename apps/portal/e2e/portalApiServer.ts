/** Test-only server: real Express routes and cookie auth, in-memory repositories, fake Google. */
import { hashPassword } from '@lc/core';
import { createTestApp } from '../../api/src/testAppInstance.test-helper.js';

const port = Number(process.env.PORTAL_TEST_PORT ?? 4181);
const testApp = createTestApp({
  portalUrl: process.env.PORTAL_TEST_ORIGIN ?? 'http://127.0.0.1:4180',
});
const { repositories, encryptionUtil, gmailOAuth } = testApp;
const { tenantId } = await repositories.tenantRepository.createTenant({
  name: 'Test logistics desk',
  googleClientId: 'synthetic-client',
  encryptedGoogleClientSecret: encryptionUtil.encryptSecret('synthetic-secret'),
  pubsubTopicName: 'projects/synthetic/topics/mail',
  pushServiceAccountEmail: 'push@synthetic.iam.gserviceaccount.com',
});
const passwordHash = await hashPassword('portal-test-password');
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
    repositories.addEmail({
      tenantId,
      mailboxId,
      id: `00000000-0000-4000-8000-${String(accountIndex * 100 + index).padStart(12, '0')}`,
      gmailThreadId: `thread-${accountIndex}-${index}`,
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
    });
  }
}
gmailOAuth.buildConsentUrl = ({ state, loginHint }) => {
  gmailOAuth.consentingAccountEmail = loginHint ?? 'new@example.com';
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('state', state);
  return url.toString();
};
const server = testApp.app.listen(port, '127.0.0.1', () =>
  console.log(`Synthetic portal API on ${port}`),
);
process.on('SIGTERM', () => server.close());
