import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_AGENT_INSTRUCTION, PROPOSE_REPLY_PROMPT_VERSION } from '@lc/core';
import type { AgentReplyProposer, RunAgentInput, RunAgentResult } from '@lc/core';
import { testTenantBody } from '../tenantFixture.test-helper.js';
import {
  createTestApp,
  operatorSessionHeader,
  testMailboxEmail,
} from '../testAppInstance.test-helper.js';
import type { TestApp } from '../testAppInstance.test-helper.js';
import { RUN_CRASHED_CODE } from './agentRunsRouter.js';

const password = 'a-long-enough-password';
const runsPath = '/v1/mailbox/agent/runs';
const olderInboundEmailId = '00000000-0000-4000-8000-000000000001';
const newestInboundEmailId = '00000000-0000-4000-8000-000000000002';
const ourReplyEmailId = '00000000-0000-4000-8000-000000000003';
const sentOnlyEmailId = '00000000-0000-4000-8000-000000000004';

const proposal = {
  subject: 'Re: RFQ 123: Mumbai to Rotterdam',
  bodyText: 'Dear Ravi,\n\n- USD 1,450 per 40HC\n\nBest regards,',
  citedGmailMessageIds: [`gmail-${newestInboundEmailId}`, 'gm-earlier-quote'],
};
const trace = {
  toolCalls: [
    { name: 'get_thread', arguments: '{"gmailThreadId":"abc123"}', outcome: 'ok', durationMs: 40 },
  ],
  usage: { inputTokens: 2600, outputTokens: 170 },
  model: 'gpt-6.1-sol-2026-01-01',
  promptVersion: PROPOSE_REPLY_PROMPT_VERSION,
};

/** Answers every run with the scripted result (or rejection) and records what it was asked. */
function fakeProposer(answer: RunAgentResult | Error) {
  const runs: { input: RunAgentInput; refreshToken: string; clientId: string }[] = [];
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const proposer: AgentReplyProposer = {
    model: 'gpt-6.1-sol',
    async propose(input, mailbox) {
      runs.push({
        input,
        refreshToken: mailbox.refreshToken,
        clientId: mailbox.credentials.clientId,
      });
      await held;
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  return { proposer, runs, release };
}

async function signedInMailbox({ app }: TestApp) {
  const tenant = await request(app)
    .post('/v1/tenants')
    .set(operatorSessionHeader)
    .send(testTenantBody);
  const mailbox = await request(app)
    .post(`/v1/tenants/${tenant.body.tenantId}/mailboxes`)
    .set(operatorSessionHeader)
    .send({ email: testMailboxEmail, password });
  const login = await request(app)
    .post('/v1/auth/login')
    .send({ email: testMailboxEmail, password });
  const setCookie = login.headers['set-cookie'];
  const cookies = Array.isArray(setCookie) ? setCookie : [String(setCookie)];
  return {
    cookie: cookies.find((cookie) => cookie.startsWith('lc_session='))!,
    mailboxId: mailbox.body.mailboxId as string,
    tenantId: tenant.body.tenantId as string,
  };
}

/** Thread abc123: customer asks, we answer, customer asks again (the anchor). Thread beef: only our mail. */
function seedThreads(testApp: TestApp, scope: { mailboxId: string; tenantId: string }): void {
  const customer = {
    ...scope,
    gmailThreadId: 'abc123',
    senderName: 'Ravi Kumar',
    senderEmail: 'ravi@acme.com',
    toRecipients: [{ name: '', address: testMailboxEmail }],
    snippet: '',
  };
  testApp.repositories.addEmail({
    ...customer,
    id: olderInboundEmailId,
    gmailLabel: 'inbox',
    subject: 'RFQ 123: Mumbai to Rotterdam',
    receivedAt: new Date('2026-11-09T10:00:00Z'),
  });
  testApp.repositories.addEmail({
    ...customer,
    id: ourReplyEmailId,
    gmailLabel: 'sent',
    senderName: '',
    senderEmail: testMailboxEmail,
    subject: 'Re: RFQ 123: Mumbai to Rotterdam',
    receivedAt: new Date('2026-11-10T10:00:00Z'),
  });
  testApp.repositories.addEmail({
    ...customer,
    id: newestInboundEmailId,
    gmailLabel: 'inbox',
    subject: 'Re: RFQ 123: Mumbai to Rotterdam',
    receivedAt: new Date('2026-11-11T10:00:00Z'),
  });
  testApp.repositories.addEmail({
    ...customer,
    id: sentOnlyEmailId,
    gmailThreadId: 'beef',
    gmailLabel: 'sent',
    senderName: '',
    senderEmail: testMailboxEmail,
    subject: 'Something we sent',
    receivedAt: new Date('2026-11-10T12:00:00Z'),
  });
}

async function connectedMailbox(testApp: TestApp) {
  const session = await signedInMailbox(testApp);
  await testApp.repositories.mailboxConnectionRepository.saveGmailConnection(session, {
    encryptedRefreshToken: testApp.encryptionUtil.encryptSecret('refresh-token-1'),
    lastHistoryId: 1n,
    watchExpiresAt: new Date('2026-11-20T00:00:00Z'),
  });
  seedThreads(testApp, session);
  return session;
}

async function runStatus(testApp: TestApp, cookie: string, runId: string) {
  const response = await request(testApp.app).get(`${runsPath}/${runId}`).set('Cookie', cookie);
  expect(response.status).toBe(200);
  return response.body as { status: string };
}

describe('POST /v1/mailbox/agent/runs', () => {
  it('answers 202 running at once, runs the copilot for the newest inbound mail with the mailbox credentials, then shows the proposal', async () => {
    const { proposer, runs, release } = fakeProposer({ outcome: 'proposed', proposal, ...trace });
    const testApp = createTestApp({ agentReplyProposer: proposer });
    const { cookie } = await connectedMailbox(testApp);

    const response = await request(testApp.app)
      .post(runsPath)
      .set('Cookie', cookie)
      .send({ gmailThreadId: 'abc123' });

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({
      emailId: newestInboundEmailId,
      gmailThreadId: 'abc123',
      instruction: DEFAULT_AGENT_INSTRUCTION,
      status: 'running',
      proposal: null,
      toolCalls: [],
      model: 'gpt-6.1-sol',
      promptVersion: PROPOSE_REPLY_PROMPT_VERSION,
      usage: { inputTokens: 0, outputTokens: 0 },
      errorCode: null,
      finishedAt: null,
    });
    const runId = response.body.id as string;
    expect(await runStatus(testApp, cookie, runId)).toMatchObject({ status: 'running' });

    expect(runs).toHaveLength(1);
    expect(runs[0]).toEqual({
      input: {
        gmailThreadId: 'abc123',
        anchor: {
          gmailMessageId: `gmail-${newestInboundEmailId}`,
          subject: 'Re: RFQ 123: Mumbai to Rotterdam',
          senderName: 'Ravi Kumar',
          senderEmail: 'ravi@acme.com',
          receivedAt: new Date('2026-11-11T10:00:00Z'),
        },
        instruction: DEFAULT_AGENT_INSTRUCTION,
      },
      refreshToken: 'refresh-token-1',
      clientId: testTenantBody.googleClientId,
    });

    release();
    await vi.waitFor(async () => {
      expect((await runStatus(testApp, cookie, runId)).status).toBe('proposed');
    });
    const finished = await request(testApp.app).get(`${runsPath}/${runId}`).set('Cookie', cookie);
    expect(finished.body).toMatchObject({
      status: 'proposed',
      proposal: {
        ...proposal,
        // Citations resolved against the mailbox's stored mail, in the proposal's order; the quote
        // the copilot found in Gmail was never ingested here, so it is listed with nothing to open.
        citedMessages: [
          {
            gmailMessageId: `gmail-${newestInboundEmailId}`,
            emailId: newestInboundEmailId,
            gmailThreadId: 'abc123',
            gmailLabel: 'inbox',
            sender: { name: 'Ravi Kumar', email: 'ravi@acme.com' },
            subject: 'Re: RFQ 123: Mumbai to Rotterdam',
            receivedAt: '2026-11-11T10:00:00.000Z',
          },
          {
            gmailMessageId: 'gm-earlier-quote',
            emailId: null,
            gmailThreadId: null,
            gmailLabel: null,
            sender: null,
            subject: null,
            receivedAt: null,
          },
        ],
      },
      toolCalls: trace.toolCalls,
      usage: trace.usage,
      errorCode: null,
    });
    expect(finished.body.finishedAt).toEqual(expect.any(String));
  });

  it('passes the operator instruction through and records a failed loop with its error code', async () => {
    const { proposer, runs, release } = fakeProposer({
      outcome: 'failed',
      errorCode: 'turn_limit',
      detail: 'no proposal after 10 model turns',
      ...trace,
    });
    const testApp = createTestApp({ agentReplyProposer: proposer });
    const { cookie } = await connectedMailbox(testApp);
    release();

    const response = await request(testApp.app)
      .post(runsPath)
      .set('Cookie', cookie)
      .send({ gmailThreadId: 'abc123', instruction: '  confirm the sailing date only  ' });
    expect(response.status).toBe(202);
    expect(runs[0]!.input.instruction).toBe('confirm the sailing date only');

    await vi.waitFor(async () => {
      expect((await runStatus(testApp, cookie, response.body.id)).status).toBe('failed');
    });
    const finished = await request(testApp.app)
      .get(`${runsPath}/${response.body.id}`)
      .set('Cookie', cookie);
    expect(finished.body).toMatchObject({
      status: 'failed',
      proposal: null,
      errorCode: 'turn_limit',
      toolCalls: trace.toolCalls,
    });
  });

  it('marks a run whose loop threw as run_crashed instead of leaving it running', async () => {
    const { proposer, release } = fakeProposer(new Error('socket hang up'));
    const testApp = createTestApp({ agentReplyProposer: proposer });
    const { cookie } = await connectedMailbox(testApp);
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    release();

    const response = await request(testApp.app)
      .post(runsPath)
      .set('Cookie', cookie)
      .send({ gmailThreadId: 'abc123' });
    expect(response.status).toBe(202);
    await vi.waitFor(async () => {
      expect((await runStatus(testApp, cookie, response.body.id)).status).toBe('failed');
    });
    const finished = await request(testApp.app)
      .get(`${runsPath}/${response.body.id}`)
      .set('Cookie', cookie);
    expect(finished.body).toMatchObject({ status: 'failed', errorCode: RUN_CRASHED_CODE });
    expect(errorLog).toHaveBeenCalled();
    errorLog.mockRestore();
  });

  it('is 404 thread_not_found for a thread with only our mail or no mail, without starting a run', async () => {
    const { proposer, runs } = fakeProposer({ outcome: 'proposed', proposal, ...trace });
    const testApp = createTestApp({ agentReplyProposer: proposer });
    const { cookie } = await connectedMailbox(testApp);

    for (const gmailThreadId of ['beef', 'dead']) {
      const response = await request(testApp.app)
        .post(runsPath)
        .set('Cookie', cookie)
        .send({ gmailThreadId });
      expect(response.status).toBe(404);
      expect(response.body.error).toBe('thread_not_found');
    }
    expect(runs).toHaveLength(0);
  });

  it('is 409 mailbox_not_connected before any run when Gmail is not connected', async () => {
    const { proposer, runs } = fakeProposer({ outcome: 'proposed', proposal, ...trace });
    const testApp = createTestApp({ agentReplyProposer: proposer });
    const session = await signedInMailbox(testApp);
    seedThreads(testApp, session);

    const response = await request(testApp.app)
      .post(runsPath)
      .set('Cookie', session.cookie)
      .send({ gmailThreadId: 'abc123' });
    expect(response.status).toBe(409);
    expect(response.body.error).toBe('mailbox_not_connected');
    expect(runs).toHaveLength(0);
  });

  it('is 503 agent_unavailable without a model and 400 for a bad body', async () => {
    const withoutProposer = createTestApp();
    const { cookie } = await connectedMailbox(withoutProposer);
    const unavailable = await request(withoutProposer.app)
      .post(runsPath)
      .set('Cookie', cookie)
      .send({ gmailThreadId: 'abc123' });
    expect(unavailable.status).toBe(503);
    expect(unavailable.body.error).toBe('agent_unavailable');

    const { proposer } = fakeProposer({ outcome: 'proposed', proposal, ...trace });
    const testApp = createTestApp({ agentReplyProposer: proposer });
    const session = await connectedMailbox(testApp);
    for (const body of [
      {},
      { gmailThreadId: 'not hex!' },
      { gmailThreadId: 'abc123', instruction: '   ' },
      { gmailThreadId: 'abc123', instruction: 'x'.repeat(2001) },
    ]) {
      const response = await request(testApp.app)
        .post(runsPath)
        .set('Cookie', session.cookie)
        .send(body);
      expect(response.status).toBe(400);
    }
  });

  it('requires a session', async () => {
    const testApp = createTestApp();
    const response = await request(testApp.app).post(runsPath).send({ gmailThreadId: 'abc123' });
    expect(response.status).toBe(401);
  });
});

describe('GET /v1/mailbox/agent/runs/:agentRunId', () => {
  it('is 404 for an unknown or malformed id and for another mailbox', async () => {
    const { proposer, release } = fakeProposer({ outcome: 'proposed', proposal, ...trace });
    const testApp = createTestApp({ agentReplyProposer: proposer });
    const { cookie } = await connectedMailbox(testApp);
    release();
    const created = await request(testApp.app)
      .post(runsPath)
      .set('Cookie', cookie)
      .send({ gmailThreadId: 'abc123' });
    expect(created.status).toBe(202);

    for (const id of ['00000000-0000-4000-8000-00000000ffff', 'not-a-uuid']) {
      const response = await request(testApp.app).get(`${runsPath}/${id}`).set('Cookie', cookie);
      expect(response.status).toBe(404);
    }

    const otherMailbox = await request(testApp.app)
      .post(
        `/v1/tenants/${(await request(testApp.app).get('/v1/me').set('Cookie', cookie)).body.tenantId}/mailboxes`,
      )
      .set(operatorSessionHeader)
      .send({ email: 'other@bhatia.example', password });
    expect(otherMailbox.status).toBe(201);
    const otherLogin = await request(testApp.app)
      .post('/v1/auth/login')
      .send({ email: 'other@bhatia.example', password });
    const setCookie = otherLogin.headers['set-cookie'];
    const otherCookie = (Array.isArray(setCookie) ? setCookie : [String(setCookie)]).find(
      (cookie) => cookie.startsWith('lc_session='),
    )!;
    const foreign = await request(testApp.app)
      .get(`${runsPath}/${created.body.id}`)
      .set('Cookie', otherCookie);
    expect(foreign.status).toBe(404);
  });
});
