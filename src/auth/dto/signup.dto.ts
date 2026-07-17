import { IsEmail } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { IsPasswordPrehash } from '@/auth/validators/is-password-prehash.validator';

export class SignupDto {
  @IsEmail()
  @ApiProperty({ example: 'player@example.com' })
  email!: string;

  @IsPasswordPrehash()
  @ApiProperty({
    description:
      'Domain-separated SHA-256 hex digest (64 lowercase hex chars) of ' +
      '`leaderboard-v1:` + email + `:` + password. Never send plaintext. ' +
      'Client must enforce min 8 characters on plaintext before hashing. ' +
      'Example for email `player@example.com` + plaintext `securePass123` is below.',
    example: 'f75088e29caf97691ef9fb92d30c7a7ba0fbfdb7349e0f11361146860a62d750',
    pattern: '^[a-f0-9]{64}$',
    minLength: 64,
    maxLength: 64,
  })
  password!: string;
}
