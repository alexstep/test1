import { Module } from '@nestjs/common';
import { DeferredWarmupService } from './deferred-warmup.service';

/**
 * Provider-only module loaded via LazyModuleLoader after listen.
 * Controllers/gateways cannot be lazy-loaded with Fastify (routes register before listen).
 */
@Module({
  providers: [DeferredWarmupService],
})
export class DeferredModule {}
