import { Injectable } from '@nestjs/common';
import { secretsStore } from './secrets.store';

/**
 * Nest DI facade over the module-level secrets store. Inject this in services
 * instead of importing secretsStore directly so tests can substitute secrets
 * without touching process-wide singleton state.
 */
@Injectable()
export class SecretsService {
  get(name: string): string | undefined {
    return secretsStore.get(name);
  }

  getRequired(name: string): string {
    return secretsStore.getRequired(name);
  }

  has(name: string): boolean {
    return secretsStore.has(name);
  }
}
