import { IsUUID, IsInt, Min } from 'class-validator';

export class CreateMatchDto {
  @IsUUID()
  game_id!: string;

  @IsInt()
  @Min(1)
  score!: number;
}
