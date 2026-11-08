/**
 * The schedule timing shape this bundle speaks (mirrors the parts of
 * `@deepseek-ai/dsh-schedule`'s `ScheduleTiming` the digest uses).
 *
 * Copied rather than imported: `dsh-schedule` is a Host package of the running
 * profile, not a dependency of this bundle (the same reason `config.ts` keeps
 * its own typed layer). The smoke types the real service against this shape,
 * so a drift in the host API shows up as a compile error at the call site.
 */
export type ScheduleTiming = { readonly kind: 'cron'; readonly cron: { readonly expression: string; readonly time_zone: string } }
