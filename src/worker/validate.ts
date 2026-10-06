import { zValidator } from '@hono/zod-validator';
import type { ValidationTargets } from 'hono';
import type { ZodType } from 'zod';

/** What a person calls each field, so a refusal never shows an internal key. */
const FIELD: Record<string, string> = {
  fxIdrPerUsd: 'the USD to IDR rate', orderNo: 'the order number', orderDate: 'the order date', shippingIdr: 'the shipping amount',
  dutiesIdr: 'the duties amount', alias: 'the name', newProjectName: 'the new project name', projectId: 'the project', csv: 'the file',
  filename: 'the file name', priority: 'the priority',
};

/**
 * zValidator, but a failure answers with one sentence naming the first bad
 * field, not a dump of zod issues (AGENTS.md: a refusal always says why).
 */
export const validate = <T extends ZodType, Target extends keyof ValidationTargets>(target: Target, schema: T) =>
  zValidator(target, schema, (result, c) => {
    if (result.success) return;
    const issue = result.error.issues[0];
    const key = issue?.path.map(String).join('.') ?? '';
    const where = key ? (FIELD[key] ?? `"${key}"`) : 'the request';
    return c.json({ error: `The request was not valid: ${where} needs ${issue?.message?.startsWith('Invalid') ? 'a valid value' : (issue?.message ?? 'a valid value')}.` }, 400);
  });
