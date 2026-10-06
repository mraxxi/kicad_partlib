import { zValidator } from '@hono/zod-validator';
import type { ValidationTargets } from 'hono';
import type { ZodType } from 'zod';

/**
 * zValidator, but a failure answers with one sentence naming the first bad
 * field, not a dump of zod issues (AGENTS.md: a refusal always says why).
 */
export const validate = <T extends ZodType, Target extends keyof ValidationTargets>(target: Target, schema: T) =>
  zValidator(target, schema, (result, c) => {
    if (result.success) return;
    const issue = result.error.issues[0];
    const where = issue?.path.length ? `"${issue.path.join('.')}"` : 'the request';
    return c.json({ error: `The request was not valid: ${where} needs ${issue?.message?.startsWith('Invalid') ? 'a valid value' : (issue?.message ?? 'a valid value')}.` }, 400);
  });
