// @vitest-environment jsdom
import { createElement } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FrontendApiError, frontendApi } from './frontendApi.js';
import { OperatorPage } from './operatorPage.js';

const operator = {
  operatorId: '00000000-0000-4000-8000-0000000000aa',
  email: 'operator@example.com',
};
const tenantId = '00000000-0000-4000-8000-000000000002';
const tenantForm = {
  name: 'Bhatia Desk',
  googleClientId: 'bhatia-client-id.apps.googleusercontent.com',
  googleClientSecret: 'GOCSPX-bhatia-client-secret',
  pubsubTopicName: 'projects/bhatia-shipping-mail/topics/gmail-notifications',
  pushServiceAccountEmail: 'logistics-copilot-push@bhatia-shipping-mail.iam.gserviceaccount.com',
};

let container: HTMLDivElement;
let root: Root | undefined;
let queryClient: QueryClient;

async function render() {
  root ??= createRoot(container);
  await act(async () => {
    root!.render(
      createElement(QueryClientProvider, { client: queryClient }, createElement(OperatorPage)),
    );
  });
  await settle();
}
/** React Query notifies through a setTimeout(0): wait one macrotask for a query or mutation to settle. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
function field(id: string) {
  const input = container.querySelector<HTMLInputElement>(`#${id}`);
  if (!input) throw new Error(`no field #${id}`);
  return input;
}
async function type(id: string, value: string) {
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setValue.call(field(id), value);
    field(id).dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function submit(formTitleId: string) {
  const form = container.querySelector<HTMLFormElement>(`[aria-labelledby="${formTitleId}"] form`);
  if (!form) throw new Error(`no form under ${formTitleId}`);
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await settle();
}
function text() {
  return container.textContent ?? '';
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container.remove();
  queryClient.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('OperatorPage', () => {
  it('shows the operator sign-in when there is no operator session, and the console after login', async () => {
    vi.spyOn(frontendApi, 'operatorSession').mockResolvedValue(null);
    const login = vi.spyOn(frontendApi, 'operatorLogin').mockResolvedValue(operator);
    await render();
    expect(text()).toContain('Sign in as an operator.');
    expect(container.querySelector('#create-tenant-title')).toBeNull();

    await type('operator-email', ' Operator@Example.com ');
    await type('operator-password', 'a-long-operator-password');
    await submit('operator-login-title');
    expect(login).toHaveBeenCalledWith('Operator@Example.com', 'a-long-operator-password');
    expect(text()).toContain('Signed in as operator@example.com');
    expect(container.querySelector('#create-tenant-title')).not.toBeNull();
  });

  it('a wrong password shows the credentials message and clears the password field', async () => {
    vi.spyOn(frontendApi, 'operatorSession').mockResolvedValue(null);
    vi.spyOn(frontendApi, 'operatorLogin').mockRejectedValue(
      new FrontendApiError(401, 'invalid_credentials'),
    );
    await render();
    await type('operator-email', 'operator@example.com');
    await type('operator-password', 'wrong');
    await submit('operator-login-title');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'That email and password do not match',
    );
    expect(field('operator-password').value).toBe('');
  });

  it('creating a tenant sends the form as typed, shows the id and pre-fills it for the mailbox form', async () => {
    vi.spyOn(frontendApi, 'operatorSession').mockResolvedValue(operator);
    const createTenant = vi.spyOn(frontendApi, 'createTenant').mockResolvedValue({ tenantId });
    const createMailbox = vi
      .spyOn(frontendApi, 'createMailbox')
      .mockResolvedValue({ mailboxId: '00000000-0000-4000-8000-000000000001', tenantId });
    await render();
    for (const [key, value] of Object.entries(tenantForm)) {
      const id = {
        name: 'tenant-name',
        googleClientId: 'tenant-google-client-id',
        googleClientSecret: 'tenant-google-client-secret',
        pubsubTopicName: 'tenant-pubsub-topic',
        pushServiceAccountEmail: 'tenant-push-service-account',
      }[key]!;
      await type(id, value);
    }
    await submit('create-tenant-title');
    expect(createTenant).toHaveBeenCalledWith(tenantForm);
    expect(text()).toContain(`Tenant created: ${tenantId}`);
    expect(field('tenant-name').value).toBe('');
    expect(field('mailbox-tenant-id').value).toBe(tenantId);

    await type('mailbox-email', 'ops@bhatia.example');
    await type('mailbox-password', 'initial-password');
    await submit('create-mailbox-title');
    expect(createMailbox).toHaveBeenCalledWith(tenantId, {
      email: 'ops@bhatia.example',
      password: 'initial-password',
    });
    expect(text()).toContain('Mailbox created: 00000000-0000-4000-8000-000000000001');
    expect(field('mailbox-password').value).toBe('');
  });

  it('an expired operator session on create says so, and a validation 400 names the fields', async () => {
    vi.spyOn(frontendApi, 'operatorSession').mockResolvedValue(operator);
    vi.spyOn(frontendApi, 'createMailbox')
      .mockRejectedValueOnce(new FrontendApiError(401, 'not_operator'))
      .mockRejectedValueOnce(
        new FrontendApiError(
          400,
          'invalid_body: email: Invalid email address; password: Too small',
        ),
      );
    await render();
    await type('mailbox-tenant-id', tenantId);
    await type('mailbox-email', 'ops@bhatia.example');
    await type('mailbox-password', 'initial-password');
    await submit('create-mailbox-title');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Your operator session has expired',
    );
    await type('mailbox-password', 'initial-password');
    await submit('create-mailbox-title');
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'Check these fields: email: Invalid email address; password: Too small',
    );
  });
});
