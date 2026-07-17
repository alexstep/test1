import { Module, Global } from '@nestjs/common';
import { MetricsService } from './metrics.service';
import { MetricsController } from './metrics.controller';
import { MetricsAuthGuard } from './metrics-auth.guard';

@Global()
@Module({
  controllers: [MetricsController],
  providers: [MetricsService, MetricsAuthGuard],
  exports: [MetricsService],
})
export class MetricsModule {}
