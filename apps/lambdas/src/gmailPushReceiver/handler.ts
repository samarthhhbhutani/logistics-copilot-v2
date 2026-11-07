import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';

/**
 * Target of the Gmail Pub/Sub push subscription (Function URL). Shell: acknowledges every push
 * with 204 and logs it. The real handler (roadmap 1.2) verifies the Google OIDC token, walks
 * history.list from the mailbox's cursor and enqueues the new Gmail message ids.
 */
export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  console.info(
    JSON.stringify({
      message: 'gmailPushReceiver shell invoked',
      method: event.requestContext.http.method,
      path: event.rawPath,
      bodyBytes: event.body?.length ?? 0,
    }),
  );
  return { statusCode: 204 };
}
