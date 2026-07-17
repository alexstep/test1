import {
  createParamDecorator,
  ExecutionContext,
  BadRequestException,
} from '@nestjs/common';

/** UUID (RFC 4122 versions 1–5). Recommended: UUID v4 per IETF Idempotency-Key draft. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Reads optional `Idempotency-Key` request header (Stripe / IETF draft).
 * Returns `null` when the header is absent; throws 400 when present but invalid.
 */
export const IdempotencyKey = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string | null => {
    const request = ctx.switchToHttp().getRequest<{
      headers: Record<string, string | string[] | undefined>;
    }>();
    const raw = request.headers['idempotency-key'];
    if (raw === undefined || raw === null || raw === '') {
      return null;
    }

    const key = Array.isArray(raw) ? raw[0]! : String(raw);
    if (key.length > 255) {
      throw new BadRequestException(
        'Idempotency-Key must be at most 255 characters',
      );
    }
    if (!UUID_RE.test(key)) {
      throw new BadRequestException('Idempotency-Key must be a valid UUID');
    }
    return key;
  },
);
