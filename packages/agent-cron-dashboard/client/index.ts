/**
 * Client half of the `agent-cron-dashboard` bundle (P0 placeholder).
 *
 * P7 fills this module with the workbench page (community board + fleet
 * board, error ledger, resolve form) following
 * `references/ui-plugin.md` and `references/verification.md`. Until then the
 * module loads, declares no slot, and exposes the bundle-level client id so
 * HMR and the profile inspector can see one module generation.
 */
window.__ModuleLoader__.load({
  id: 'agent-cron-dashboard',
  factory(require) {
    return {
      // No dsh services are needed for an empty module; P7 injects `slots`.
      inject: [],
      apply() {
        // P7 registers the sidebar page here.
      },
    }
  },
})
