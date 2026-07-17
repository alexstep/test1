import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  decryptEmail,
  encryptEmail,
  emailBlindIndex,
} from '@/database/crypto/db-crypto';

export class EncryptUserEmail1720000001000 implements MigrationInterface {
  name = 'EncryptUserEmail1720000001000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" DROP CONSTRAINT "UQ_users_email"`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "email" TYPE VARCHAR(512)`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD "email_blind_index" VARCHAR(64)`,
    );

    const rows: Array<{ id: string; email: string }> = await queryRunner.query(
      `SELECT "id", "email" FROM "users"`,
    );

    for (const row of rows) {
      const ciphertext = encryptEmail(row.email);
      const index = emailBlindIndex(row.email);
      await queryRunner.query(
        `UPDATE "users" SET "email" = $1, "email_blind_index" = $2 WHERE "id" = $3`,
        [ciphertext, index, row.id],
      );
    }

    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "email_blind_index" SET NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD CONSTRAINT "UQ_users_email_blind_index" UNIQUE ("email_blind_index")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const rows: Array<{ id: string; email: string }> = await queryRunner.query(
      `SELECT "id", "email" FROM "users"`,
    );

    for (const row of rows) {
      const plaintext = decryptEmail(row.email);
      await queryRunner.query(`UPDATE "users" SET "email" = $1 WHERE "id" = $2`, [
        plaintext,
        row.id,
      ]);
    }

    await queryRunner.query(
      `ALTER TABLE "users" DROP CONSTRAINT "UQ_users_email_blind_index"`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" DROP COLUMN "email_blind_index"`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "email" TYPE VARCHAR(255)`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD CONSTRAINT "UQ_users_email" UNIQUE ("email")`,
    );
  }
}
