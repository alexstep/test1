import { Controller, Get, UseGuards, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { FastifyReply } from 'fastify';
import { Public } from '@/common/decorators/public.decorator';
import { MetricsService } from './metrics.service';
import { MetricsAuthGuard } from './metrics-auth.guard';

@ApiExcludeController()
@SkipThrottle()
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metricsService: MetricsService) {}

  @Public()
  @UseGuards(MetricsAuthGuard)
  @Get()
  async getMetrics(@Res() res: FastifyReply) {
    const metrics = await this.metricsService.getMetrics();
    res.header('Content-Type', this.metricsService.getContentType());
    res.send(metrics);
  }
}
