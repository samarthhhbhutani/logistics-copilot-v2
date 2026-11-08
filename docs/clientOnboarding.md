# Client onboarding

What a client (one logistics desk, called a **tenant** in the code) and we do to connect their Gmail
mailboxes to Logistics Copilot. One pass per client; adding a second mailbox later only repeats part E.

Everything on the client's side happens in **one Google Cloud project of theirs**. Google requires the
Pub/Sub topic that carries Gmail notifications to sit in the same project as the OAuth client used to
read the mailbox, so the OAuth client and the Pub/Sub setup cannot be split across projects.

## Who does what

| Part | Owner  | Takes          |
| ---- | ------ | -------------- |
| A    | Client | 5 min          |
| B    | Client | 15 min         |
| C    | Client | 10 min         |
| D    | Us     | 5 min          |
| E    | Client | 2 min per user |
| F    | Both   | 5 min          |

Values the client hands us at the end of part C:

| Value                        | Looks like                                                           |
| ---------------------------- | -------------------------------------------------------------------- |
| Google project ID            | `acme-logistics-mail`                                                |
| OAuth client ID              | `1234567890-abc.apps.googleusercontent.com`                          |
| OAuth client secret          | `GOCSPX-...`                                                         |
| Pub/Sub topic name           | `projects/acme-logistics-mail/topics/gmail-notifications`            |
| Push service account email   | `logistics-copilot-push@acme-logistics-mail.iam.gserviceaccount.com` |
| Mailbox addresses to connect | `ops@acme-logistics.com`, `rates@acme-logistics.com`                 |

Our values the client needs, per stage:

| Value              | Staging                                                                  | Production |
| ------------------ | ------------------------------------------------------------------------ | ---------- |
| API base URL       | `<API_BASE_URL>` (set when the Railway service exists)                   | TBD        |
| OAuth redirect URI | `<API_BASE_URL>/v1/mailbox/gmail/callback`                               | TBD        |
| Push endpoint URL  | `https://t3x6leuzhskn32hfhaw3f7u5wm0azded.lambda-url.ap-south-1.on.aws/` | TBD        |

## Part A: prerequisites (client)

1. A Google account that owns the mailboxes: Google Workspace (recommended) or a plain Gmail account.
2. Access to the [Google Cloud console](https://console.cloud.google.com/) with permission to create a
   project, or an existing project they are Owner of. Billing does not need to be enabled; Gmail API
   and Pub/Sub at our volume stay inside the free tier.
3. Optional but faster: the `gcloud` CLI installed and logged in (`gcloud auth login`). Every step
   below shows both the console path and the `gcloud` command.

## Part B: Google Cloud project and OAuth client (client)

Set these once in a shell if using `gcloud`:

```sh
PROJECT_ID=acme-logistics-mail          # lowercase, 6-30 chars, globally unique
API_BASE_URL=<API_BASE_URL>             # from the table above
```

1. **Create or pick a project.** Console: project picker, "New project". CLI:

   ```sh
   gcloud projects create "$PROJECT_ID" --name="Logistics Copilot mail"
   gcloud config set project "$PROJECT_ID"
   ```

2. **Enable the Gmail API and the Pub/Sub API.** Console: APIs & Services, Library, search each,
   Enable. CLI:

   ```sh
   gcloud services enable gmail.googleapis.com pubsub.googleapis.com
   ```

3. **Configure the OAuth consent screen** (console only: Google Auth Platform, Branding / Audience /
   Data Access).
   - App name: `Logistics Copilot`; support email: the client's.
   - **Audience: Internal** if the account is Google Workspace. Only users of that Workspace can
     connect, and Google asks for no app verification.
   - If the mailbox is a plain `@gmail.com` account, Internal is not offered: choose **External**,
     leave the app in **Testing**, and add every mailbox address under "Test users". Known limit:
     Google expires refresh tokens of Testing apps after 7 days, so the operator will have to
     reconnect weekly. Workspace with Internal has no such limit and is the supported path.
   - **Data Access, Add or remove scopes:** add exactly these two and save.
     - `https://www.googleapis.com/auth/gmail.readonly` (read mail)
     - `https://www.googleapis.com/auth/gmail.send` (send replies and RFQs)

4. **Create the OAuth client.** Console: Google Auth Platform, Clients, Create client.
   - Application type: **Web application**. Name: `Logistics Copilot API`.
   - Authorised redirect URI: `<API_BASE_URL>/v1/mailbox/gmail/callback` (exactly, including the path).
   - Create, then copy the **Client ID** and **Client secret**. The secret is shown once.

## Part C: Pub/Sub for Gmail push notifications (client)

Gmail will publish a tiny "mailbox changed" note to a topic in the client's project; a push
subscription forwards each note to our receiver, signed with a service account so we can verify it
came from Google and from this client.

```sh
TOPIC=gmail-notifications
PUSH_SA=logistics-copilot-push
PUSH_ENDPOINT=https://t3x6leuzhskn32hfhaw3f7u5wm0azded.lambda-url.ap-south-1.on.aws/   # staging
```

1. **Create the topic.** Console: Pub/Sub, Topics, Create topic, ID `gmail-notifications`, untick
   "Add a default subscription". CLI:

   ```sh
   gcloud pubsub topics create "$TOPIC"
   ```

2. **Let Gmail publish to it.** Gmail publishes as Google's own service account
   `gmail-api-push@system.gserviceaccount.com`. Console: the topic, Permissions, Add principal, that
   address, role **Pub/Sub Publisher**. CLI:

   ```sh
   gcloud pubsub topics add-iam-policy-binding "$TOPIC" \
     --member=serviceAccount:gmail-api-push@system.gserviceaccount.com \
     --role=roles/pubsub.publisher
   ```

   If the organisation has domain-restricted sharing enabled, this grant is blocked until an admin
   allows the Google-owned domain; see Google's push notification guide.

3. **Create the service account the push will be signed with.** It needs no roles and no key file;
   Google signs the delivery token internally. Console: IAM & Admin, Service accounts, Create. CLI:

   ```sh
   gcloud iam service-accounts create "$PUSH_SA" --display-name="Logistics Copilot push"
   ```

4. **Allow Pub/Sub to mint tokens for that service account.** Pub/Sub acts as the project's Pub/Sub
   service agent and needs the Token Creator role on the service account. CLI (the console needs the
   same binding under the service account's Permissions tab):

   ```sh
   PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
   gcloud iam service-accounts add-iam-policy-binding \
     "$PUSH_SA@$PROJECT_ID.iam.gserviceaccount.com" \
     --member="serviceAccount:service-$PROJECT_NUMBER@gcp-sa-pubsub.iam.gserviceaccount.com" \
     --role=roles/iam.serviceAccountTokenCreator
   ```

5. **Create the push subscription.** Console: the topic, Create subscription, Delivery type Push,
   endpoint URL as below, tick "Enable authentication", pick the service account, audience = the
   endpoint URL, expiry Never. CLI:

   ```sh
   gcloud pubsub subscriptions create "$TOPIC-push" \
     --topic="$TOPIC" \
     --push-endpoint="$PUSH_ENDPOINT" \
     --push-auth-service-account="$PUSH_SA@$PROJECT_ID.iam.gserviceaccount.com" \
     --push-auth-token-audience="$PUSH_ENDPOINT" \
     --ack-deadline=10 \
     --expiration-period=never
   ```

6. **Send us the handover values** from the table at the top (project ID, client ID, client secret,
   topic name `projects/$PROJECT_ID/topics/$TOPIC`, service account email, mailbox addresses). Send
   the client secret through a channel that is not email.

## Part D: tenant and logins (us)

1. Create the tenant with the client's OAuth credentials; the secret is encrypted at rest with
   `TOKEN_ENCRYPTION_KEY`:

   ```sh
   curl -X POST "$API_BASE_URL/v1/tenants" -H 'content-type: application/json' -d '{
     "name": "Acme Logistics",
     "googleClientId": "<client id>",
     "googleClientSecret": "<client secret>",
     "pubsubTopicName": "projects/acme-logistics-mail/topics/gmail-notifications",
     "pushServiceAccountEmail": "logistics-copilot-push@acme-logistics-mail.iam.gserviceaccount.com"
   }'
   ```

   The topic name and service account are what `users.watch` and the push receiver check against.

2. For each mailbox, create its operator login:

   ```sh
   curl -X POST "$API_BASE_URL/v1/tenants/<tenantId>/mailboxes" -H 'content-type: application/json' \
     -d '{"email":"ops@acme-logistics.com","password":"<initial password>"}'
   ```

## Part E: connect each mailbox (client operator)

1. Log in to the portal with the mailbox address and the initial password.
2. Click **Connect Gmail**. Google shows the consent screen for that project.
3. Sign in as the mailbox owner and **tick both boxes**: read mail and send mail. Leaving one unticked
   returns `scope_not_granted` and the connection is refused; redo the step.
4. The portal shows `connected`. Behind the scenes we stored an encrypted refresh token and registered
   a Gmail watch on the client's topic; the watch is renewed automatically every 12 hours.

## Part F: verification (both)

1. Client publishes a test note to the topic. It must reach our receiver and return 204:

   ```sh
   gcloud pubsub topics publish "$TOPIC" --message='{"emailAddress":"ops@acme-logistics.com","historyId":"1"}'
   ```

   We confirm from the `logistics-copilot-gmail-push-receiver-<stage>` logs.

2. Client sends any email to the connected mailbox. Within a few seconds it appears in the portal's
   inbox; that is the whole pipeline (push, fetch, store, classify) working.

3. If step 1 works and step 2 does not, the usual cause is the watch: `users.watch` fails with
   `Invalid topicName does not match projects/<project>/topics/*` when the topic is in a different
   project from the OAuth client, or `User not authorized` when the Publisher grant in C.2 is missing.

## Disconnecting

The operator clicks **Disconnect** in the portal (revokes the token at Google and stops the watch), or
removes the app under <https://myaccount.google.com/permissions>. Deleting the push subscription in
the client's project stops notifications without touching stored mail.
