import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
  Check,
  type Relation,
} from 'typeorm';
import { User } from './user.entity';
import { Game } from './game.entity';

@Entity('matches')
@Index(['gameId', 'playerId'])
@Index(['gameId', 'createdAt'])
@Index('uq_matches_player_idem', ['playerId', 'idempotencyKey'], {
  unique: true,
  where: '"idempotency_key" IS NOT NULL',
})
@Check('"score" > 0')
export class Match {
  @PrimaryColumn('uuid', { default: () => 'uuidv7()' })
  id!: string;

  @Column({ type: 'uuid', name: 'player_id' })
  playerId!: string;

  @Column({ type: 'uuid', name: 'game_id' })
  gameId!: string;

  @Column({ type: 'int' })
  score!: number;

  /** Client-supplied Idempotency-Key (scoped per player). Null when header omitted. */
  @Column({
    type: 'varchar',
    length: 255,
    name: 'idempotency_key',
    nullable: true,
  })
  idempotencyKey!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @ManyToOne(() => User, (user) => user.matches, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'player_id' })
  player!: Relation<User>;

  @ManyToOne(() => Game, (game) => game.matches, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'game_id' })
  game!: Relation<Game>;
}
