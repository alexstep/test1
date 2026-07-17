import { Module, forwardRef } from '@nestjs/common';
import { MatchesController } from './matches.controller';
import { MatchesService } from './matches.service';
import { LeaderboardModule } from '@/leaderboard/leaderboard.module';

@Module({
  imports: [forwardRef(() => LeaderboardModule)],
  controllers: [MatchesController],
  providers: [MatchesService],
})
export class MatchesModule {}
