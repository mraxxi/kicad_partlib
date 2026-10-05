import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';

// The tests run the schema that ships: every real file in migrations/, in order.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
