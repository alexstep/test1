import { MigrationInterface, QueryRunner } from 'typeorm';

export class MatchIdempotencyKey1720000001000 implements MigrationInterface {
  name = 'MatchIdempotencyKey1720000001000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "matches"
      ADD COLUMN "idempotency_key" VARCHAR(255) NULL
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_matches_player_idem"
      ON "matches" ("player_id", "idempotency_key")
      WHERE "idempotency_key" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "uq_matches_player_idem"`);
    await queryRunner.query(`
      ALTER TABLE "matches" DROP COLUMN "idempotency_key"
    `);
  }
}
