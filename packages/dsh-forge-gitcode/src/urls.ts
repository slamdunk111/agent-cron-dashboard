/**
 * GitCode web URL and git remote recognition.
 *
 * GitCode serves three web shapes for the same change request — the canonical
 * `/pull/{n}` (what the site links to), plus the GitHub-flavoured `/pulls/{n}`
 * and the GitLab-flavoured `/merge_requests/{n}` (all three answer 200 on the
 * live host). Remotes appear as `https://gitcode.com/{o}/{r}.git`,
 * `git@gitcode.com:{o}/{r}.git`, `ssh://git@gitcode.com/{o}/{r}.git` and the
 * same shapes without `.git`.
 *
 * Project paths may be nested (`group/sub-group/repo`), so the trailing
 * `pull|pulls|merge_requests` segment anchors the split instead of assuming
 * exactly one owner level.
 */
export interface GitCodeRepository {
  readonly forge: string
  readonly host: string
  readonly owner: string
  readonly name: string
}

export interface GitCodeChangeRequestRef {
  readonly repository: GitCodeRepository
  readonly number: number
}

const CHANGE_REQUEST_SEGMENT = /^(?:pull|pulls|merge_requests)$/
const NUMBER = /^\d+$/

/** Split `a/b/c` into owner `a/b` and name `c`; undefined when the path is too short. */
function splitProject(segments: string[]): { owner: string; name: string } | undefined {
  if (segments.length < 2) return undefined
  const name = segments[segments.length - 1]
  const owner = segments.slice(0, -1).join('/')
  const bad = /^$|[\s?#]/
  if (bad.test(owner) || bad.test(name) || name.startsWith('-') || !/^[A-Za-z0-9_.-]+$/.test(name)) return undefined
  return { owner, name }
}

function repositoryOf(host: string, owner: string, name: string): GitCodeRepository {
  return { forge: 'gitcode', host: host.toLowerCase(), owner, name }
}

/** Strip a leading `git+` prefix and a scheme/`git@` prefix down to host + path. */
function remoteParts(raw: string): { host: string; path: string } | undefined {
  let text = raw.trim().replace(/^git\+/, '')
  if (text.length === 0) return undefined
  const scp = /^[A-Za-z0-9_.-]+@([A-Za-z0-9_.-]+):(.+)$/.exec(text)
  if (scp !== null && !text.includes('://')) return { host: scp[1], path: scp[2] }
  try {
    const parsed = new URL(text)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:' && parsed.protocol !== 'ssh:' && parsed.protocol !== 'git:') {
      return undefined
    }
    return { host: parsed.hostname, path: parsed.pathname.replace(/^\//, '') }
  } catch {
    return undefined
  }
}

/**
 * Map a git remote URL to a GitCode repository.
 * @param url - remote as written in `git remote -v` (any of the forms above).
 * @param hosts - hosts this provider serves (default `gitcode.com`).
 * @returns the repository, or undefined when the remote is not GitCode.
 */
export function repositoryFromRemote(url: string, hosts: readonly string[] = ['gitcode.com']): GitCodeRepository | undefined {
  const parts = remoteParts(url)
  if (parts === undefined) return undefined
  const host = parts.host.toLowerCase()
  if (!hosts.includes(host)) return undefined
  const path = parts.path.replace(/\.git$/i, '').replace(/\/+$/, '')
  const segments = path.split('/').filter((segment) => segment.length > 0)
  const project = splitProject(segments)
  if (project === undefined) return undefined
  return repositoryOf(host, project.owner, project.name)
}

/**
 * Map a change request web URL to its reference.
 * @param url - `/pull/{n}`, `/pulls/{n}` or `/merge_requests/{n}` page URL.
 * @param hosts - hosts this provider serves.
 * @returns the reference, or undefined when the URL is not a GitCode change request.
 */
export function changeRequestFromUrl(url: string, hosts: readonly string[] = ['gitcode.com']): GitCodeChangeRequestRef | undefined {
  let parsed: URL
  try {
    parsed = new URL(url.trim())
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined
  const host = parsed.hostname.toLowerCase()
  if (!hosts.includes(host)) return undefined
  const segments = parsed.pathname.replace(/^\//, '').replace(/\/+$/, '').split('/')
  if (segments.length < 3) return undefined
  const last = segments[segments.length - 1]
  const marker = segments[segments.length - 2]
  if (!CHANGE_REQUEST_SEGMENT.test(marker) || !NUMBER.test(last)) return undefined
  const project = splitProject(segments.slice(0, -2))
  if (project === undefined) return undefined
  return { repository: repositoryOf(host, project.owner, project.name), number: Number(last) }
}

/** Canonical web page of a change request (GitCode links to `/pull/{n}`). */
export function changeRequestUrl(ref: GitCodeChangeRequestRef): string {
  return `https://${ref.repository.host}/${ref.repository.owner}/${ref.repository.name}/pull/${ref.number}`
}

/** Web page of one file at a commit. */
export function fileUrl(ref: GitCodeChangeRequestRef, commit: string, path: string): string {
  return `https://${ref.repository.host}/${ref.repository.owner}/${ref.repository.name}/blob/${commit}/${path.replace(/^\//, '')}`
}

/** `api/v5` base for a repository. */
export function apiBase(ref: GitCodeChangeRequestRef): string {
  return `https://${ref.repository.host}/api/v5/repos/${ref.repository.owner}/${ref.repository.name}`
}

/** Web `.diff` URL of a change request (the api/v5 `.diff` form answers 400). */
export function diffUrl(ref: GitCodeChangeRequestRef): string {
  return `https://${ref.repository.host}/${ref.repository.owner}/${ref.repository.name}/pull/${ref.number}.diff`
}
