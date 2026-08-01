import { API_ERROR_CODES, apiErrorSchema } from '@foot-repose/contracts';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { HttpError, MAX_JSON_BODY_BYTES, parseJsonBody } from '../src/lib/http';

/**
 * [T3] The byte ceiling on JSON request bodies, at the helper every route
 * shares.
 *
 * Measured on pre-fix main 02494832, through real sockets against the
 * production build: a 2 MiB body reached the login service and answered 401
 * (password verification had run), with a declared Content-Length and with
 * chunked framing alike; and an authenticated transition with a 2 MiB body
 * answered 200 and actually moved the booking from `confirmed` to `checked_in`,
 * writing its audit rows. There was no application-level ceiling at all.
 *
 * Everything below is expressed in BYTES rather than characters, because that
 * is the unit an attacker controls and the unit the runtime has to hold.
 */
const schema = z.object({ email: z.string() });

/** A syntactically valid JSON object of an EXACT encoded byte length. */
function jsonOfBytes(target: number): string {
  const envelope = JSON.stringify({ email: 'a@b.test', filler: '' });
  const filler = 'x'.repeat(target - Buffer.byteLength(envelope, 'utf8'));
  const body = JSON.stringify({ email: 'a@b.test', filler });
  if (Buffer.byteLength(body, 'utf8') !== target) {
    throw new Error(`built ${Buffer.byteLength(body, 'utf8')} bytes, wanted ${target}`);
  }
  return body;
}

const request = (body: string | ReadableStream<Uint8Array>, headers: HeadersInit = {}): Request =>
  new Request('http://api.test/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
    // Required by undici to send a stream body.
    ...(typeof body === 'string' ? {} : { duplex: 'half' }),
  } as RequestInit & { duplex?: 'half' });

const expectTooLarge = async (promise: Promise<unknown>): Promise<HttpError> => {
  const error = await promise.then(
    () => null,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(HttpError);
  const httpError = error as HttpError;
  expect(httpError.status).toBe(413);
  expect(httpError.code).toBe('payload_too_large');
  expect(httpError.message).toBe('Request body too large');
  return httpError;
};

describe('[T3] the ceiling is exactly 16,384 bytes', () => {
  it('is the documented constant', () => {
    expect(MAX_JSON_BODY_BYTES).toBe(16_384);
    expect(MAX_JSON_BODY_BYTES).toBe(16 * 1024);
  });

  it('accepts a body one byte below the limit', async () => {
    const body = jsonOfBytes(MAX_JSON_BODY_BYTES - 1);
    expect(Buffer.byteLength(body, 'utf8')).toBe(16_383);
    await expect(parseJsonBody(request(body), schema)).resolves.toEqual({ email: 'a@b.test' });
  });

  it('accepts a body exactly at the limit', async () => {
    // The boundary is inclusive: 16,384 is permitted, not "the first refusal".
    const body = jsonOfBytes(MAX_JSON_BODY_BYTES);
    expect(Buffer.byteLength(body, 'utf8')).toBe(16_384);
    await expect(parseJsonBody(request(body), schema)).resolves.toEqual({ email: 'a@b.test' });
  });

  it('refuses a body one byte over the limit', async () => {
    const body = jsonOfBytes(MAX_JSON_BODY_BYTES + 1);
    expect(Buffer.byteLength(body, 'utf8')).toBe(16_385);
    await expectTooLarge(parseJsonBody(request(body), schema));
  });
});

describe('[T3] the limit counts encoded bytes, not characters', () => {
  it('refuses a body whose character count looks safe', async () => {
    // Arabic and emoji cost 2–4 bytes each. A body of ~8,000 characters is
    // comfortably "under 16,384" by length and well over it by bytes — which is
    // exactly the arithmetic a character-based limit gets wrong.
    const filler = 'مرحبا🙂'.repeat(1_400);
    const body = JSON.stringify({ email: 'a@b.test', filler });
    expect(body.length).toBeLessThan(MAX_JSON_BODY_BYTES);
    expect(Buffer.byteLength(body, 'utf8')).toBeGreaterThan(MAX_JSON_BODY_BYTES);
    await expectTooLarge(parseJsonBody(request(body), schema));
  });

  it('decodes multibyte content correctly when it fits', async () => {
    const parsed = await parseJsonBody(
      request(JSON.stringify({ email: 'مرحبا@example.test' })),
      schema,
    );
    expect(parsed).toEqual({ email: 'مرحبا@example.test' });
  });
});

describe('[T3] Content-Length is an early refusal, never a guarantee', () => {
  it('refuses a declared length above the limit without draining the source', async () => {
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(1_024));
      },
    });
    const req = request(stream, { 'content-length': String(MAX_JSON_BODY_BYTES + 1) });
    // MEASURED: constructing a Request around a stream body already pulls once
    // in this runtime, before any of our code runs. The claim here is about the
    // helper, so the baseline is taken after construction rather than assumed
    // to be zero.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const beforeParse = pulls;

    await expectTooLarge(parseJsonBody(req, schema));

    // Rejected on the header alone: the helper pulled nothing.
    expect(pulls).toBe(beforeParse);
  });

  it('does not refuse a declared length equal to the limit', async () => {
    const body = jsonOfBytes(MAX_JSON_BODY_BYTES);
    await expect(
      parseJsonBody(request(body, { 'content-length': String(MAX_JSON_BODY_BYTES) }), schema),
    ).resolves.toEqual({ email: 'a@b.test' });
  });

  it('still enforces the limit when a body understates its own length', async () => {
    // A caller's declared length is a claim. The counting is what enforces.
    const oversized = new TextEncoder().encode(jsonOfBytes(MAX_JSON_BODY_BYTES + 5_000));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(oversized);
        controller.close();
      },
    });
    await expectTooLarge(parseJsonBody(request(stream, { 'content-length': '10' }), schema));
  });

  it('enforces the limit with no Content-Length at all', async () => {
    const oversized = new TextEncoder().encode(jsonOfBytes(MAX_JSON_BODY_BYTES + 1));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(oversized);
        controller.close();
      },
    });
    const req = request(stream);
    expect(req.headers.get('content-length')).toBeNull();
    await expectTooLarge(parseJsonBody(req, schema));
  });

  it('ignores a malformed Content-Length and falls back to counting', async () => {
    const body = jsonOfBytes(MAX_JSON_BODY_BYTES);
    await expect(
      parseJsonBody(request(body, { 'content-length': 'not-a-number' }), schema),
    ).resolves.toEqual({ email: 'a@b.test' });
  });
});

describe('[T3] an oversized stream is cancelled, not drained', () => {
  it('counts cumulatively, cancels on overflow and stops pulling', async () => {
    let pulls = 0;
    let cancelled = false;
    let cancelReason: unknown = null;
    const chunk = new Uint8Array(8_192);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(chunk);
      },
      cancel(reason) {
        cancelled = true;
        cancelReason = reason;
      },
    });

    await expectTooLarge(parseJsonBody(request(stream), schema));

    // Two 8 KiB chunks are exactly at the limit; the third crosses it. So the
    // overflow is detected in a LATER chunk, not on the first.
    expect(pulls).toBeGreaterThanOrEqual(3);
    expect(cancelled).toBe(true);
    expect(cancelReason).toBeUndefined();

    const settled = pulls;
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Nothing kept pulling after the route was answered.
    expect(pulls).toBe(settled);
  });

  it('settles rather than hanging when the source never ends on its own', async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(64 * 1024));
      },
    });
    // An unbounded source: only the ceiling can end this.
    await expectTooLarge(parseJsonBody(request(stream), schema));
  });

  it('releases the reader lock on the rejection path', async () => {
    const oversized = new TextEncoder().encode(jsonOfBytes(MAX_JSON_BODY_BYTES + 1));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(oversized);
        controller.close();
      },
    });
    const req = request(stream);
    await expectTooLarge(parseJsonBody(req, schema));
    // A retained lock would make the body permanently unusable and is the kind
    // of leak that only shows up under load.
    expect(req.body?.locked).toBe(false);
  });
});

describe('[T3] behaviour within the limit is unchanged', () => {
  it('parses ordinary JSON', async () => {
    await expect(
      parseJsonBody(request(JSON.stringify({ email: 'user@example.test' })), schema),
    ).resolves.toEqual({ email: 'user@example.test' });
  });

  it.each([
    ['an empty body', ''],
    ['malformed JSON', '{"email":'],
    ['a bare fragment', 'not json at all'],
  ])('answers 400 validation_error for %s', async (_label, body) => {
    const error = await parseJsonBody(request(body), schema).then(
      () => null,
      (thrown: unknown) => thrown as HttpError,
    );
    expect(error).toBeInstanceOf(HttpError);
    expect(error?.status).toBe(400);
    expect(error?.code).toBe('validation_error');
    expect(error?.message).toBe('Body must be valid JSON');
  });

  it('keeps Zod validation and its issue formatting', async () => {
    const error = await parseJsonBody(request(JSON.stringify({ email: 42 })), schema).then(
      () => null,
      (thrown: unknown) => thrown as HttpError,
    );
    expect(error?.status).toBe(400);
    expect(error?.code).toBe('validation_error');
    expect(error?.message).toContain('email');
  });

  it('still strips unknown small fields exactly as before', async () => {
    await expect(
      parseJsonBody(request(JSON.stringify({ email: 'a@b.test', extra: 'ignored' })), schema),
    ).resolves.toEqual({ email: 'a@b.test' });
  });

  it('accepts an explicit larger ceiling only when a caller asks for one', async () => {
    // The escape hatch exists, and no current route uses it.
    const body = jsonOfBytes(MAX_JSON_BODY_BYTES + 1);
    await expectTooLarge(parseJsonBody(request(body), schema));
    await expect(
      parseJsonBody(request(body), schema, MAX_JSON_BODY_BYTES * 2),
    ).resolves.toEqual({ email: 'a@b.test' });
  });
});

describe('[T3] the error contract', () => {
  it('publishes payload_too_large as a first-class code', () => {
    expect(API_ERROR_CODES).toContain('payload_too_large');
    expect(
      apiErrorSchema.safeParse({
        error: { code: 'payload_too_large', message: 'Request body too large' },
      }).success,
    ).toBe(true);
  });

  it('is distinct from validation_error', () => {
    // Size and content are different conditions: one is decided before any
    // field is read, the other after.
    expect(API_ERROR_CODES).toContain('validation_error');
    expect('payload_too_large').not.toBe('validation_error');
  });

  it('never echoes the rejected body', async () => {
    const secret = 'S3CRET-PASSWORD-VALUE';
    const filler = 'x'.repeat(MAX_JSON_BODY_BYTES);
    const error = await expectTooLarge(
      parseJsonBody(request(JSON.stringify({ password: secret, filler })), schema),
    );
    expect(error.message).not.toContain(secret);
    expect(error.message).not.toContain('x'.repeat(32));
    // Not even the observed size, which would be a measurement channel.
    expect(error.message).not.toMatch(/\d/);
  });
});
