import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { SecretsService } from '@/secrets/secrets.service';

@Injectable()
export class MetricsAuthGuard implements CanActivate {
  constructor(private readonly secretsService: SecretsService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const authHeader = request.headers.authorization;

    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Metrics token required');
    }

    const token = authHeader.slice(7);
    const metricsToken = this.secretsService.getRequired('METRICS_TOKEN');

    if (token !== metricsToken) {
      throw new UnauthorizedException('Invalid metrics token');
    }

    return true;
  }
}
