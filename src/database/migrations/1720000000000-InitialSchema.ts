import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialSchema1720000000000 implements MigrationInterface {
  name = 'InitialSchema1720000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "users" (
        "id" UUID DEFAULT uuidv7() NOT NULL,
        "email" VARCHAR(255) NOT NULL,
        "password_hash" VARCHAR(255) NOT NULL,
        "created_at" TIMESTAMPTZ DEFAULT now() NOT NULL,
        "updated_at" TIMESTAMPTZ DEFAULT now() NOT NULL,
        CONSTRAINT "PK_users" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_users_email" UNIQUE ("email")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "games" (
        "id" UUID DEFAULT uuidv7() NOT NULL,
        "name" VARCHAR(100) NOT NULL,
        "description" VARCHAR(500),
        "created_at" TIMESTAMPTZ DEFAULT now() NOT NULL,
        CONSTRAINT "PK_games" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_games_name" UNIQUE ("name")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "matches" (
        "id" UUID DEFAULT uuidv7() NOT NULL,
        "player_id" UUID NOT NULL,
        "game_id" UUID NOT NULL,
        "score" INTEGER NOT NULL,
        "created_at" TIMESTAMPTZ DEFAULT now() NOT NULL,
        CONSTRAINT "PK_matches" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_matches_score" CHECK ("score" > 0),
        CONSTRAINT "FK_matches_player" FOREIGN KEY ("player_id") REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_matches_game" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_matches_game_player" ON "matches" ("game_id", "player_id")
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_matches_game_created" ON "matches" ("game_id", "created_at")
    `);

    await queryRunner.query(`
      CREATE TABLE "refresh_tokens" (
        "id" UUID DEFAULT uuidv7() NOT NULL,
        "user_id" UUID NOT NULL,
        "token_hash" VARCHAR(255) NOT NULL,
        "expires_at" TIMESTAMPTZ NOT NULL,
        "revoked" BOOLEAN DEFAULT false NOT NULL,
        "created_at" TIMESTAMPTZ DEFAULT now() NOT NULL,
        CONSTRAINT "PK_refresh_tokens" PRIMARY KEY ("id"),
        CONSTRAINT "FK_refresh_tokens_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_refresh_tokens_user" ON "refresh_tokens" ("user_id")
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_refresh_tokens_hash" ON "refresh_tokens" ("token_hash")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "refresh_tokens"`);
    await queryRunner.query(`DROP TABLE "matches"`);
    await queryRunner.query(`DROP TABLE "games"`);
    await queryRunner.query(`DROP TABLE "users"`);
  }
}
