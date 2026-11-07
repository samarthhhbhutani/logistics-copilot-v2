import { readFileSync } from 'node:fs';

/** Raw bytes of a fixture under ./fixtures, exactly as Gmail would hand them over after base64url decoding. */
export function readEmailFixture(fileName: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(`./fixtures/${fileName}`, import.meta.url)));
}
