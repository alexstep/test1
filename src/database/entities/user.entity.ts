import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
  BeforeInsert,
  BeforeUpdate,
  type Relation,
} from 'typeorm';
import { RefreshToken } from './refresh-token.entity';
import { Match } from './match.entity';
import {
  EncryptedEmailTransformer,
  emailBlindIndex,
} from '@/database/crypto/db-crypto';

@Entity('users')
export class User {
  @PrimaryColumn('uuid', { default: () => 'uuidv7()' })
  id!: string;

  // Email at rest uses two columns:
  // - email: AES-GCM ciphertext (EncryptedEmailTransformer) - confidential, randomized
  //   per write, not searchable by plaintext value.
  // - emailBlindIndex: deterministic HMAC of normalized email - same input always
  //   yields the same hash, enabling unique constraint and login lookups.
  @Column({
    type: 'varchar',
    length: 512,
    transformer: EncryptedEmailTransformer,
  })
  email!: string;

  @Column({
    type: 'varchar',
    length: 64,
    name: 'email_blind_index',
    unique: true,
  })
  emailBlindIndex!: string;

  @Column({ type: 'varchar', length: 255, name: 'password_hash' })
  passwordHash!: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;

  @OneToMany(() => RefreshToken, (token) => token.user)
  refreshTokens!: Relation<RefreshToken[]>;

  @OneToMany(() => Match, (match) => match.player)
  matches!: Relation<Match[]>;

  // Blind index must be derived from plaintext email. Hooks run before the
  // transformer encrypts on DB write, so this.email is still plaintext here.
  // TypeORM does not apply transformers to WHERE clauses - lookups use
  // emailBlindIndex, not the encrypted column.
  @BeforeInsert()
  @BeforeUpdate()
  syncEmailBlindIndex(): void {
    if (this.email) {
      this.emailBlindIndex = emailBlindIndex(this.email);
    }
  }
}
