# Onboarding Bhatia Shipping (operator runbook, production)

For our operator: one client from nothing to a connected mailbox, guiding Bhatia through Google Cloud
on a call, then using the operator console. Generic reference: `docs/clientOnboarding.md`.

## Ledger (fill in as you go; never write the client secret or passwords anywhere)

| Value                          | From    | Value                                                                           |
| ------------------------------ | ------- | ------------------------------------------------------------------------------- |
| Operator console               | us      | `https://frontend-production-0fcc0b30.up.railway.app/operator`                  |
| OAuth redirect URI             | us      | `https://frontend-production-0fcc0b30.up.railway.app/v1/mailbox/gmail/callback` |
| Push endpoint URL              | us      | `https://635pchk5vyu7as53wj7vkztdgu0djzlw.lambda-url.ap-south-1.on.aws/`        |
| Google project ID              | Bhatia  | `bhatia-shipping-mail` (suffix if taken)                                        |
| OAuth client ID                | Bhatia  | `….apps.googleusercontent.com`                                                  |
| Pub/Sub topic                  | Bhatia  | `projects/<project id>/topics/gmail-notifications`                              |
| Push service account           | Bhatia  | `logistics-copilot-push@<project id>.iam.gserviceaccount.com`                   |
| Mailboxes; Workspace or Gmail? | Bhatia  |                                                                                 |
| Tenant id                      | console |                                                                                 |

A custom domain later changes the redirect URI; Bhatia would have to add the new one to their client.

## 1. Google Cloud, on a call (Bhatia clicks, you read; ~40 min)

They sign in at <https://console.cloud.google.com/> with the account that owns the mailboxes (Workspace
admin if they have Workspace) and share their screen. One project for everything.

**1.1 Project.** Project picker (top bar) > **New project**. Name `Logistics Copilot mail`; **Edit**
the project ID to `bhatia-shipping-mail`; **Create**. When the bell confirms, select it in the picker.

**1.2 APIs.** Menu > **APIs & Services** > **Library**. Search `Gmail API` > **Enable**. Back, search
`Cloud Pub/Sub API` > **Enable**. Both appear under _Enabled APIs & services_.

**1.3 Consent screen.** Menu > **Google Auth Platform** > **Get started**. App name `Logistics
Copilot`, support email theirs > **Next**. Audience: **Internal** (Workspace). If only plain
`@gmail.com`: **External**; say on the call that the app stays in Testing, mailboxes must be added as
test users, and Google expires the token every 7 days (weekly reconnect). > **Next** > contact email

> **Create**. Then **Data Access** > **Add or remove scopes**: filter `gmail.readonly`, tick
> `…/auth/gmail.readonly`; filter `gmail.send`, tick `…/auth/gmail.send` > **Update** > **Save**.
> External only: **Audience** > **Test users** > **Add users** (every mailbox) > **Save**; do not Publish.

**1.4 OAuth client.** **Clients** > **Create client**. Type **Web application**, name `Logistics
Copilot API`. **Authorised redirect URIs** > **Add URI**: paste the ledger redirect URI exactly >
**Create**. Dialog: read the **Client ID** into the ledger; the **secret shows once**: they copy it to
their password manager and share it with you by password manager or by reading it aloud while you
type it into the console (step 2). Lost it? Clients > the client > **Add secret**.

**1.5 Topic.** Menu > **Pub/Sub** > **Topics** > **Create topic**. ID `gmail-notifications`, **untick
"Add a default subscription"** > **Create**. Full name on the topic page goes in the ledger.

**1.6 Gmail may publish.** Topic page > **Permissions** tab (open **Show info panel** if hidden) >
**Add principal**: `gmail-api-push@system.gserviceaccount.com`, role **Pub/Sub Publisher** > **Save**.
An organisation-policy error here needs their Workspace admin; note it, continue, come back.

**1.7 Service account.** Menu > **IAM & Admin** > **Service accounts** > **Create service account**.
Name `logistics-copilot-push` > **Create and continue** > leave both grant steps empty > **Done**. No
key. Email goes in the ledger.

**1.8 Pub/Sub may sign as it.** Open `logistics-copilot-push@…` > **Permissions** > **Grant access**.
Principal `service-<PROJECT_NUMBER>@gcp-sa-pubsub.iam.gserviceaccount.com` (project number: menu >
**Cloud overview** > **Dashboard**, Project info card). Role **Service Account Token Creator** >
**Save**. If told the service agent does not exist yet, do 1.9 first, then redo this.

**1.9 Push subscription.** **Pub/Sub** > **Subscriptions** > **Create subscription**. ID
`gmail-notifications-push`, topic `gmail-notifications`, delivery **Push**, endpoint = ledger push
URL (with trailing slash). Tick **Enable authentication**, service account `logistics-copilot-push@…`,
**Audience** = the same URL. Expiration **Never expire**, ack deadline `10` > **Create**.

**1.10 Check.** Topic page > **Messages** > **Publish message**, body
`{"emailAddress":"test@example.com","historyId":"1"}` > **Publish**. Subscription > **Metrics** shows
one push with a 2xx within a minute (our receiver answers 204 even for an unknown mailbox); 401/403
means 1.8 or 1.9. Read the ledger back to them before hanging up.

gcloud fallbacks for 1.1 to 1.9 are in `docs/clientOnboarding.md` parts B and C.

## 2. Tenant and mailboxes (operator console, 10 min)

1. Sign in at the operator console. **Create a tenant**: Desk name `Bhatia Shipping`, client id and
   secret, topic and service account from the ledger. "Check these fields" names a bad shape. Copy the
   **tenant id** (pre-filled in the next form) into the ledger.
2. **Create a mailbox** per address: exact Gmail address, a generated initial password (6+ chars).
   Hand each password to that mailbox's owner directly. No self-service reset yet; we reset in the
   database on request. "A mailbox with that email already exists": do not duplicate, check with us.

## 3. Owners connect Gmail (Bhatia, 2 min each)

Sign in at the frontend with address and initial password > **Connect Gmail** > sign in as the owner >
**tick both boxes** (read, send). The frontend shows **connected**.

| Symptom                                                 | Cause                                  | Fix                        |
| ------------------------------------------------------- | -------------------------------------- | -------------------------- |
| Google `redirect_uri_mismatch`                          | redirect URI missing on their client   | 1.4, add it exactly, retry |
| `scope_not_granted`                                     | a consent box unticked                 | reconnect, tick both       |
| our logs: `Invalid topicName does not match projects/…` | topic and client in different projects | they move one; reconnect   |
| our logs: `User not authorized` on watch                | Publisher grant missing                | 1.6, then reconnect        |

## 4. Verify and go live (5 min)

1. Bhatia publishes `{"emailAddress":"<mailbox>","historyId":"1"}` to the topic; our
   `logistics-copilot-gmail-push-receiver-production` logs show 204.
2. Anyone emails the connected mailbox; it appears in the frontend inbox within seconds.
3. The owner sends one reply from the frontend; production sends real mail.
4. Record tenant id, mailboxes and the Workspace/Testing decision (weekly reconnect reminder if
   Testing). Disconnect later: owner clicks **Disconnect**, or Bhatia deletes the push subscription.
