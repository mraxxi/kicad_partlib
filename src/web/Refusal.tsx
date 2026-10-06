/**
 * Every refusal reads the same: one sentence (`error`) or a list of per-row sentences (`errors`) under a heading.
 * Nothing renders for no error or an empty list: an empty `errors` array is truthy and once drew a red box with no reason.
 */
export function Refusal({ error, errors, heading = 'This cannot be imported:' }: { error?: string; errors?: string[]; heading?: string }) {
  if (error) return <div className="box bad" role="alert">{error}</div>;
  if (!errors || errors.length === 0) return null;
  return <div className="box bad" role="alert"><b>{heading}</b><ul>{errors.map((e) => <li key={e}>{e}</li>)}</ul></div>;
}
