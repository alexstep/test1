import { IsString, IsNotEmpty, IsOptional } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class RefreshDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @ApiPropertyOptional({
    description:
      'Refresh token. Optional when the browser sends the HttpOnly `refresh_token_<X-Session-Id>` cookie ' +
      'issued by `POST /api/v1/auth/login`. Required for non-browser API clients that cannot use cookies.',
    example: 'a1b2c3...',
  })
  refresh_token?: string;
}
