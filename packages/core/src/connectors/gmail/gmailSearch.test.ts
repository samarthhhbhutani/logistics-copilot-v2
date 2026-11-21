import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GmailApiError } from './gmailApiError.js';
import { createGoogleGmailSearch, GMAIL_SEARCH_MAX_RESULTS } from './gmailSearch.js';

interface RecordedRequest {
  url: string;
  params: Record<string, string>;
}

const recordedRequests: RecordedRequest[] = [];
let respond: (request: RecordedRequest) => unknown = () => ({});

vi.mock('google-auth-library', () => ({
  OAuth2Client: class {
    setCredentials() {}
    async request(options: { url: string; params: Record<string, string> }) {
      const request = { url: options.url, params: options.params };
      recordedRequests.push(request);
      return { data: respond(request) };
    }
  },
}));

const access = {
  credentials: { clientId: 'client', clientSecret: 'secret' },
  refreshToken: 'refresh',
};
const rawBase64Url = (text: string) => Buffer.from(text).toString('base64url');

beforeEach(() => {
  recordedRequests.length = 0;
});

describe('listMessages', () => {
  it('calls messages.list with the query and a clamped maxResults', async () => {
    respond = () => ({
      messages: [
        { id: 'm-2', threadId: 't-1' },
        { id: 'm-1', threadId: 't-1' },
      ],
    });
    const refs = await createGoogleGmailSearch().listMessages({
      ...access,
      query: 'from:vendor newer_than:7d',
      maxResults: 500,
    });
    expect(recordedRequests).toEqual([
      {
        url: 'https://gmail.googleapis.com/gmail/v1/users/me/messages',
        params: { q: 'from:vendor newer_than:7d', maxResults: GMAIL_SEARCH_MAX_RESULTS },
      },
    ]);
    expect(refs).toEqual([
      { gmailMessageId: 'm-2', gmailThreadId: 't-1' },
      { gmailMessageId: 'm-1', gmailThreadId: 't-1' },
    ]);
  });

  it('returns no refs when Gmail omits the messages field', async () => {
    respond = () => ({ resultSizeEstimate: 0 });
    await expect(
      createGoogleGmailSearch().listMessages({ ...access, query: 'nothing', maxResults: 5 }),
    ).resolves.toEqual([]);
  });
});

describe('getThreadRawMessages', () => {
  it('asks threads.get for ids only (raw is not a thread format) and fetches each message raw, in thread order', async () => {
    respond = ({ url }) => {
      if (url.endsWith('/threads/t-1'))
        return { id: 't-1', messages: [{ id: 'm-1' }, { id: 'm-2' }, { id: 'm-3' }] };
      const id = url.slice(url.lastIndexOf('/') + 1);
      return {
        id,
        threadId: 't-1',
        labelIds: ['INBOX'],
        snippet: `snippet ${id}`,
        internalDate: '1762171200000',
        raw: rawBase64Url(`Subject: ${id}\r\n\r\nbody`),
      };
    };
    const messages = await createGoogleGmailSearch().getThreadRawMessages({
      ...access,
      gmailThreadId: 't-1',
    });
    expect(recordedRequests[0]).toEqual({
      url: 'https://gmail.googleapis.com/gmail/v1/users/me/threads/t-1',
      params: { format: 'minimal' },
    });
    expect(recordedRequests.slice(1).map((request) => request.url.split('/').at(-1))).toEqual([
      'm-1',
      'm-2',
      'm-3',
    ]);
    expect(recordedRequests.slice(1).every((request) => request.params.format === 'raw')).toBe(
      true,
    );
    expect(messages.map((message) => message.gmailMessageId)).toEqual(['m-1', 'm-2', 'm-3']);
    expect(Buffer.from(messages[2]!.raw).toString()).toBe('Subject: m-3\r\n\r\nbody');
    expect(messages[0]).toMatchObject({
      threadId: 't-1',
      labelIds: ['INBOX'],
      snippet: 'snippet m-1',
      internalDate: new Date('2025-11-03T12:00:00Z'),
    });
  });

  it('maps a 404 on the thread to GmailApiError not_found', async () => {
    respond = () => {
      throw Object.assign(new Error('Requested entity was not found.'), {
        response: {
          status: 404,
          data: { error: { code: 404, message: 'Requested entity was not found.', errors: [] } },
        },
      });
    };
    const failure = createGoogleGmailSearch().getThreadRawMessages({
      ...access,
      gmailThreadId: 't-gone',
    });
    await expect(failure).rejects.toBeInstanceOf(GmailApiError);
    await expect(failure).rejects.toMatchObject({ code: 'not_found', httpStatus: 404 });
  });
});
