import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * Track authenticated callers by JWT user id; fall back to client IP for
 * public routes (signup/login/refresh). Relies on JwtAuthGuard running first.
 */
@Injectable()
export class UserOrIpThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, unknown>): Promise<string> {
    const user = req['user'] as { id?: string } | undefined;
    if (typeof user?.id === 'string' && user.id.length > 0) {
      return user.id;
    }
    const ip = req['ip'];
    if (typeof ip === 'string' && ip.length > 0) {
      return ip;
    }
    return 'unknown';
  }
}
