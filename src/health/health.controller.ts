import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { hostname } from 'os';
import { Public } from '@/common/decorators/public.decorator';
import { HealthResponse } from '@/common/openapi/responses.dto';

@ApiTags('health')
@SkipThrottle()
@Controller('health')
export class HealthController {
  @Public()
  @Get()
  @ApiOperation({ summary: 'Health check for reverse proxy and monitoring' })
  @ApiResponse({ status: 200, type: HealthResponse })
  check() {
    return {
      status: 'ok',
      uptime: Math.floor(process.uptime()),
      hostname: hostname(),
    };
  }
}
