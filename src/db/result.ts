/** A refusal always carries one full sentence saying why (AGENTS.md: refusals). */
export interface Refusal {
  ok: false;
  status: 404 | 409 | 422;
  message: string;
  /** Extra structured detail, e.g. the field-level diff on a rev conflict. */
  detail?: unknown;
}
export const refuse = (status: Refusal['status'], message: string, detail?: unknown): Refusal => ({ ok: false, status, message, detail });
export type Outcome<T> = ({ ok: true } & T) | Refusal;
