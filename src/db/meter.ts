/**
 * D1 meters rows SCANNED (read) and rows written including index writes, and
 * since 2026-09-01 queries FAIL once a daily cap is hit. So every D1 call in
 * this app goes through a Meter, which sums `meta.rows_read` / `rows_written`
 * for the request; the worker flushes the totals to usage_daily afterwards.
 */
export class Meter {
  rowsRead = 0;
  rowsWritten = 0;

  add(result: D1Result<unknown>): void {
    this.rowsRead += result.meta.rows_read ?? 0;
    this.rowsWritten += result.meta.rows_written ?? 0;
  }

  async batch(db: D1Database, statements: D1PreparedStatement[]): Promise<D1Result<unknown>[]> {
    const results = await db.batch(statements);
    for (const r of results) this.add(r);
    return results;
  }

  async all<T>(stmt: D1PreparedStatement): Promise<T[]> {
    const r = await stmt.all<T>();
    this.add(r);
    return r.results;
  }

  async flush(db: D1Database, now = new Date()): Promise<void> {
    if (this.rowsRead === 0 && this.rowsWritten === 0) return;
    const day = now.toISOString().slice(0, 10);
    await db
      .prepare(
        `INSERT INTO usage_daily(day, rows_read, rows_written, requests) VALUES (?1, ?2, ?3, 1)
         ON CONFLICT(day) DO UPDATE SET rows_read = rows_read + ?2,
           rows_written = rows_written + ?3, requests = requests + 1`,
      )
      .bind(day, this.rowsRead, this.rowsWritten)
      .run();
  }
}
