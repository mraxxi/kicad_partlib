// wrangler types narrows vars to their literal value (""); widen the two Access vars to string.
export type AppEnv = Omit<Env, 'ACCESS_TEAM_DOMAIN' | 'ACCESS_AUD'> & {
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  /** Set ONLY in tests and .dev.vars; unset in deployed environments so a missing Access config fails closed. */
  ALLOW_UNAUTHENTICATED?: string;
}

export interface Vars {
  meter: import('../db/meter').Meter;
  identity: string;
}
