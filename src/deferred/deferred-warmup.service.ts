import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class DeferredWarmupService {
  private readonly logger = new Logger(DeferredWarmupService.name);

  /** Lifecycle hooks are not run for lazy-loaded modules - call explicitly after load. */
  warm() {
    this.logger.log('Deferred module loaded (lazy warm)');
  }
}
