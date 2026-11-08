/**
 * GitCode side of the watch: the working `WatchSource` over `ctx.forge`.
 *
 * `ctx.forge.watch` is an effect on the calling fiber and only the row owns a
 * fiber, so the row passes its context here; the smoke script (bare node) gets
 * a source that composes `ForgeService` itself, exactly as §2.2 measured.
 */
import type { WatchRef, WatchSource, WatchUpdate } from './pr-watch.ts'

/** The part of `ForgeService` this module uses. */
export interface ForgeLike {
  watch(
    ref: { repository: { forge: string; host: string; owner: string; name: string }; number: number },
    listener: (update: WatchUpdate) => void,
  ): () => void
}

/** Wrap `ctx.forge` into the platform-neutral shape `PrWatchService` reads. */
export function forgeWatchSource(forge: ForgeLike): WatchSource {
  return {
    subscribe(ref: WatchRef, listener) {
      return forge.watch(
        { repository: { forge: 'gitcode', host: 'gitcode.com', owner: ref.owner, name: ref.repo }, number: ref.number },
        listener,
      )
    },
  }
}

/** Build a ForgeService-backed source in a bare context (smoke and tests only). */
export async function makeGitCodeWatchSource(options: {
  intervalMs?: number
  profileRoot?: string
}): Promise<WatchSource & { dispose: () => void; forge: ForgeLike }> {
  const { createRequire } = await import('node:module')
  const { resolve } = await import('node:path')
  const { homedir } = await import('node:os')
  const profileRoot = options.profileRoot ?? resolve(homedir(), '.dsh/profiles/dsh-workbench-dev')
  const requireFromProfile = createRequire(`${profileRoot}/package.json`)
  const { Context } = await import(requireFromProfile.resolve('@deepseek-ai/cordis'))
  const Storage = await import(requireFromProfile.resolve('@deepseek-ai/dsh-storage'))
  const StorageJson = await import(requireFromProfile.resolve('@deepseek-ai/dsh-storage-json'))
  const StorageDomain = await import(requireFromProfile.resolve('@deepseek-ai/dsh-storage-domain'))
  const Forge = await import(requireFromProfile.resolve('@deepseek-ai/dsh-experimental-forge'))
  const GitCode = await import(requireFromProfile.resolve('dsh-forge-gitcode'))
  const ctx = new Context()
  const root = `${resolve(homedir(), '.dsh', 'storages', `p2-smoke-${Date.now()}`)}`
  await ctx.plugin(Storage.default ?? Storage.Storage, { root })
  await ctx.plugin(StorageJson, { root })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(Forge.default, {
    activeIntervalMs: options.intervalMs ?? 10_000,
    idleIntervalMs: options.intervalMs ?? 10_000,
    maxBackoffMs: 600_000,
    fetchTimeoutMs: 20_000,
  })
  const forge = ctx.get('forge') as ForgeLike
  await (forge as unknown as { register(provider: unknown): Promise<unknown> }).register(GitCode.makeGitCodeProvider(GitCode.validateConfig({})))
  const source = forgeWatchSource(forge)
  return {
    subscribe: source.subscribe,
    forge,
    dispose() {
      void ctx.storageDomain?.closeAll?.()
    },
  }
}
