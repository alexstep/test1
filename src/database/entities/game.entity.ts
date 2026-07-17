import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  OneToMany,
  type Relation,
} from 'typeorm';
import { Match } from './match.entity';

@Entity('games')
export class Game {
  @PrimaryColumn('uuid', { default: () => 'uuidv7()' })
  id!: string;

  @Column({ type: 'varchar', length: 100, unique: true })
  name!: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  description!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @OneToMany(() => Match, (match) => match.game)
  matches!: Relation<Match[]>;
}
