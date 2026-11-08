/**
 * Local re-export of the frozen forge projection for community modules.
 *
 * dsh copies the linked package into the profile node_modules, so the `community/`
 * modules cannot reach `../../../contracts/forge-provider.ts`; they import this
 * one hop instead. Types only, erased at build time.
 */
export type {
  ChangeRequestCheck,
  ChangeRequestSnapshot,
  ChecksRollup,
  ForgeFailure,
  Mergeability,
  ReviewDecision,
} from '../../../../contracts/forge-provider.ts'
