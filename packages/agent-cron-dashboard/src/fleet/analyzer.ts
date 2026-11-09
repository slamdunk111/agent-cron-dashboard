/**
 * LLM analyser (P6 task 3, design §5.4): one prompt template, one frozen output
 * schema, one retry, one cache.
 *
 * The provider is injected as {@link AnalysisPort} so the unit tests replay a
 * scripted stream and the host row passes `ctx.llm.stream` (dsh-llm) through.
 * A failed or aborted stream never blocks the pipeline: the analyser returns
 * `failed` and the record keeps `analysis.state = pending` while the ledger row
 * stays visible ("未分析" is shown, not hidden).
 */
import { fileURLToPath } from 'node:url'
import CONFIG_SCHEMA from '../config.schema.json' with { type: 'json' }
import Ajv2020 from 'ajv/dist/2020.js'
import type { ErrorSample, FleetJobRecord, IssueRecord } from '../../../../contracts/records.ts'
import { normalize } from './fingerprint.ts'
import { createHash } from 'node:crypto'

/** The subset of dsh-llm `StreamChunk` the analyser consumes. */
export type AnalysisChunk =
  | { readonly type: 'text-delta'; readonly text: string }
  | { readonly type: 'finish'; readonly reason: { readonly kind: 'stop' | 'aborted' | 'error' | 'max-tokens' | 'tool-calls'; readonly failure?: { readonly code?: string; readonly message?: string } } }
  | { readonly type: 'block-start' | 'block-end' | 'usage' | 'reasoning-delta' | 'tool-call-delta'; readonly [key: string]: unknown }

/** One model call: provider and model are fixed by the composition. */
export interface AnalysisRequest {
  readonly provider: string
  readonly model: string
  readonly system: string
  readonly messages: readonly { readonly role: 'user'; readonly content: string }[]
  readonly maxTokens: number
}

/** Streaming port (dsh-llm `ctx.llm.stream` adapted in `index.ts`). */
export interface AnalysisPort {
  readonly provider: string
  readonly model: string
  stream(request: AnalysisRequest): AsyncIterable<AnalysisChunk>
}

/** Frozen model output (`contracts/config.schema.json` `$defs.analysisOutput`). */
export interface AnalysisOutput {
  readonly rootCauseHypothesis: string
  readonly impact: string
  readonly suggestedFix: readonly string[]
  readonly confidence: number
  readonly needMoreInfo: readonly string[]
}

/** Raised when the model text does not satisfy the frozen schema. */
export class AnalysisFormatError extends Error {
  readonly detail: string

  constructor(detail: string) {
    super(`analysis output rejected: ${detail}`)
    this.name = 'AnalysisFormatError'
    this.detail = detail
  }
}

/** Outcome of one analysis attempt. */
export interface AnalysisCallResult {
  readonly state: 'done' | 'failed'
  readonly output: AnalysisOutput | null
  /** How many model calls were spent (1 or 2). */
  readonly attempts: number
  /** Failure cause (`error:<code>`, `aborted`, `format`, `empty`), null on success. */
  readonly failure: string | null
  readonly model: string
}

/** Input the analyser needs about the failing job. */
export interface AnalysisJobContext {
  readonly job: FleetJobRecord | undefined
  /** Recent runs of the same job, newest first (bounded by the caller). */
  readonly recentRuns: readonly { readonly startedAt: string; readonly status: string }[]
}

/** Cached analysis per signature, invalidated by a changed sample detail. */
interface CacheEntry {
  /** Distinct normalized sample texts, joined (similarity is measured against this). */
  readonly detail: string
  readonly output: AnalysisOutput
  readonly model: string
}

/** Default similarity floor below which a variant is re-analysed (Levenshtein ratio). */
export const DEFAULT_CACHE_SIMILARITY = 0.9

/**
 * The frozen schema shipped with the package.
 *
 * The bundle cannot hop above its own directory once dsh copies the linked
 * package into a profile's node_modules, so `scripts/sync-contracts.mjs` keeps a
 * byte-identical copy of `contracts/config.schema.json` at
 * `src/config.schema.json`, and esbuild embeds it at bundle time (the JSON import
 * above). No runtime file read, so the built bundle works from any directory.
 */
const SCHEMA = CONFIG_SCHEMA as Record<string, unknown> & { $defs: Record<string, Record<string, unknown>> }

/** The `$defs.analysisOutput` definition of the frozen schema. */
const ANALYSIS_DEF = SCHEMA.$defs['analysisOutput']!

/** Location of this module (kept for diagnostics only; the schema is embedded). */
export const ANALYSER_MODULE_URL = fileURLToPath(import.meta.url)


/** Compile the frozen `$defs.analysisOutput` once (strict Ajv, no custom keywords). */
const validateOutput = new Ajv2020({ allErrors: true, strict: true }).compile({ ...ANALYSIS_DEF, $defs: SCHEMA.$defs })

/** The schema text handed to the model (the same frozen document, no second copy). */
export const ANALYSIS_OUTPUT_SCHEMA_TEXT = JSON.stringify(ANALYSIS_DEF, null, 2)

/** Levenshtein distance between two strings (two-row DP, bounded memory). */
export function levenshtein(a: string, b: string): number {
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let row = 1; row <= a.length; row += 1) {
    const current = [row]
    for (let column = 1; column <= b.length; column += 1) {
      const cost = a[row - 1] === b[column - 1] ? 0 : 1
      current.push(Math.min(previous[column]! + 1, current[column - 1]! + 1, previous[column - 1]! + cost))
    }
    previous = current
  }
  return previous[b.length]!
}

/**
 * Similarity of two sample details in [0, 1] (1 = identical).
 * @param left - first detail text.
 * @param right - second detail text.
 */
export function similarity(left: string, right: string): number {
  const longest = Math.max(left.length, right.length)
  if (longest === 0) return 1
  return 1 - levenshtein(left, right) / longest
}

/** The distinct normalized sample texts the cache compares (instants and repeats collapse). */
export function detailTextOf(samples: readonly ErrorSample[]): string {
  return [...new Set(samples.map((sample) => normalize(sample.message)))].join('\n')
}

/** Hash of {@link detailTextOf}, kept for reporting one stable cell per record. */
export function detailHashOf(samples: readonly ErrorSample[]): string {
  return createHash('sha1').update(detailTextOf(samples)).digest('hex')
}

/**
 * Render the prompt: at most three samples, the job context, the recent runs,
 * and the frozen output schema.
 * @param record - the ledger row.
 * @param context - job record and recent runs.
 */
export function buildPrompt(record: IssueRecord, context: AnalysisJobContext): string {
  const samples = record.samples.slice(-3)
  const job = context.job
  const runs = context.recentRuns.slice(0, 5)
  return [
    'You are diagnosing one recurring cron-job error for a personal workbench.',
    `SOURCE: ${record.sourceId}`,
    `JOB: ${record.jobId ?? '(unattributed)'}`,
    `JOB NAME: ${job?.name ?? '(unknown)'}`,
    `JOB SCRIPT: ${job?.script ?? '(none)'}`,
    `JOB SCHEDULE: ${job?.schedule ?? '(unknown)'}`,
    `OCCURRENCES SO FAR: ${String(record.count)} (first ${record.firstSeen}, last ${record.lastSeen})`,
    `SEVERITY: ${record.severity}`,
    '',
    'RECENT RUNS (newest first):',
    ...(runs.length === 0 ? ['(none recorded)'] : runs.map((run) => `- ${run.startedAt} ${run.status}`)),
    '',
    'ERROR SAMPLES (masked, newest last):',
    ...samples.map((sample, index) => `--- sample ${String(index + 1)} (${sample.occurredAt}, ${sample.severity}) ---\n${sample.message}`),
    '',
    'Answer with one JSON object and nothing else, matching exactly this JSON Schema:',
    ANALYSIS_OUTPUT_SCHEMA_TEXT,
  ].join('\n')
}

/**
 * Parse the model text into the frozen output shape.
 * @param text - accumulated model text (optionally fenced as ```json).
 * @throws AnalysisFormatError when the text is not JSON or violates the schema.
 */
export function parseAnalysis(text: string): AnalysisOutput {
  const stripped = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
  if (stripped === '') throw new AnalysisFormatError('empty output')
  let parsed: unknown
  try {
    parsed = JSON.parse(stripped)
  } catch (error) {
    throw new AnalysisFormatError(`not JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!validateOutput(parsed)) throw new AnalysisFormatError(JSON.stringify(validateOutput.errors ?? []))
  const value = parsed as AnalysisOutput
  return {
    rootCauseHypothesis: value.rootCauseHypothesis,
    impact: value.impact,
    suggestedFix: value.suggestedFix,
    confidence: value.confidence,
    needMoreInfo: [...value.needMoreInfo],
  }
}

/** Options of the analyser. */
export interface ErrorAnalyzerOptions {
  readonly port: AnalysisPort
  readonly maxTokens?: number
  /** Similarity floor for reusing a cached analysis; below it the variant is re-analysed. */
  readonly cacheSimilarity?: number
  readonly system?: string
}

const DEFAULT_SYSTEM = 'You analyse error logs. Output only the JSON object the user asks for, with no prose.'

/** Task 3 analyser: prompt → stream → schema → retry once → cache. */
export class ErrorAnalyzer {
  private readonly port: AnalysisPort
  private readonly maxTokens: number
  private readonly cacheSimilarity: number
  private readonly system: string
  private readonly cache = new Map<string, CacheEntry>()
  /** Calls made so far (the evidence line quotes it). */
  calls = 0

  constructor(options: ErrorAnalyzerOptions) {
    this.port = options.port
    this.maxTokens = options.maxTokens ?? 1024
    this.cacheSimilarity = options.cacheSimilarity ?? DEFAULT_CACHE_SIMILARITY
    this.system = options.system ?? DEFAULT_SYSTEM
  }

  /** Provider name of the port (stored with the analysis). */
  get provider(): string {
    return this.port.provider
  }

  /** Model name of the port. */
  get model(): string {
    return this.port.model
  }

  /** `provider/model` label stored with an analysis (used by the tool face and the UI snapshot). */
  get label(): string {
    return `${this.provider}/${this.model}`
  }

  /**
   * Cached model answer for a signature, or undefined.
   * @param signature - fingerprint of the record.
   * @param detail - text the similarity floor is measured on (the normalized samples, not their hash).
   */
  cached(signature: string, detail: string): AnalysisOutput | undefined {
    const entry = this.cache.get(signature)
    return entry !== undefined && similarity(entry.detail, detail) >= this.cacheSimilarity ? entry.output : undefined
  }

  /**
   * Analyse one record: cached answer first, then up to two model calls.
   * @param record - the ledger row.
   * @param context - job context and recent runs.
   */
  async run(record: IssueRecord, context: AnalysisJobContext): Promise<AnalysisCallResult> {
    const detail = detailTextOf(record.samples)
    const cached = this.cached(record.signature, detail)
    if (cached !== undefined) return { state: 'done', output: cached, attempts: 0, failure: null, model: this.port.model }
    const request: AnalysisRequest = {
      provider: this.port.provider,
      model: this.port.model,
      system: this.system,
      messages: [{ role: 'user', content: buildPrompt(record, context) }],
      maxTokens: this.maxTokens,
    }
    let failure = 'unknown'
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      this.calls += 1
      const collected = await this.collect(request)
      if (collected.failure === null) {
        try {
          const output = parseAnalysis(collected.text)
          this.cache.set(record.signature, { detail, output, model: this.port.model })
          return { state: 'done', output, attempts: attempt, failure: null, model: this.port.model }
        } catch (error) {
          failure = `format: ${error instanceof AnalysisFormatError ? error.detail.slice(0, 120) : String(error)}`
          continue
        }
      }
      failure = collected.failure
    }
    return { state: 'failed', output: null, attempts: 2, failure, model: this.port.model }
  }

  /** Drain one stream into text, classifying the terminal finish. */
  private async collect(request: AnalysisRequest): Promise<{ text: string; failure: string | null }> {
    let text = ''
    let failure: string | null = null
    try {
      for await (const chunk of this.port.stream(request)) {
        if (chunk.type === 'text-delta') text += chunk.text
        if (chunk.type === 'finish') {
          const reason = chunk.reason
          if (reason.kind === 'error') failure = `error:${reason.failure?.code ?? 'unknown'}`
          else if (reason.kind === 'aborted') failure = 'aborted'
          else if (reason.kind !== 'stop') failure = `finish:${reason.kind}`
        }
      }
    } catch (error) {
      failure = `throw: ${error instanceof Error ? error.message.slice(0, 120) : String(error)}`
    }
    if (failure === null && text.trim() === '') failure = 'empty'
    return { text, failure }
  }
}
