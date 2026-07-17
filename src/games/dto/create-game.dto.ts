import { IsString, IsOptional, MaxLength, MinLength } from 'class-validator';

export class CreateGameDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}
