/**
 * Client half of the `agent-cron-dashboard` bundle (P0 placeholder).
 *
 * The loader provides `window.__ModuleLoader__` in the browser realm (see
 * `cordis-plugin-development/templates/decoration/client.js`); the declaration
 * below only makes the module type-checkable from the host side.
 *
 * P7 fills this module with the workbench page (community board + fleet
 * board, error ledger, resolve form) following
 * `references/ui-plugin.md` and `references/verification.md`. Until then the
 * module loads, declares no slot, and exposes the bundle-level client id so
 * HMR and the profile inspector can see one module generation.
 */
declare global {
  interface Window {
    __ModuleLoader__: {
      load(module: { id: string; factory(require: (id: string) => unknown): unknown }): void
    }
  }
}

export {}

window.__ModuleLoader__.load({
  id: 'agent-cron-dashboard',
  factory(_require) {
    return {
      // No dsh services are needed for an empty module; P7 injects `slots`.
      inject: [],
      apply() {
        // P7 registers the sidebar page here.
      },
    }
  },
})
