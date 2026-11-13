import { readFile } from "node:fs/promises";
import { join } from "node:path";
import postgres from "postgres";

/** Initialize the current application schema in an empty database. */
export async function initializeDatabase(databaseUrl: string): Promise<void> {
  const schema = await readFile(join(import.meta.dir, "..", "schema.sql"), "utf8");
  const client = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    await client.begin(async (transaction) => {
      await transaction`select pg_advisory_xact_lock(hashtextextended('pdsduet:initialize', 0))`;
      const [existing] = await transaction<{ name: string | null }[]>`
        select to_regclass('public.users')::text as name
      `;
      if (!existing?.name) await transaction.unsafe(schema);
    });
  } finally {
    await client.end({ timeout: 5 });
  }
}

if (import.meta.main) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl?.trim()) throw new Error("DATABASE_URL is required to initialize the database.");
  await initializeDatabase(databaseUrl);
  console.info("PDSDuet database schema is initialized.");
}
