import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LeaderboardController } from './leaderboard.controller';
import { LeaderboardService } from './leaderboard.service';
import { LeaderboardGateway } from './leaderboard.gateway';
import { Match } from '@/database/entities/match.entity';
import { Game } from '@/database/entities/game.entity';
import { User } from '@/database/entities/user.entity';
import { GamesModule } from '@/games/games.module';
import { AuthModule } from '@/auth/auth.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Match, Game, User]),
    forwardRef(() => GamesModule),
    AuthModule,
  ],
  controllers: [LeaderboardController],
  providers: [LeaderboardService, LeaderboardGateway],
  exports: [LeaderboardService],
})
export class LeaderboardModule {}
