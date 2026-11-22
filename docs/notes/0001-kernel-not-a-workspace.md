# 0001 — kernel/ as a path alias, not a workspace

**Status**: accepted
**Date**: 2026-04-17

## Context

`kernel/` holds shared types, zod schemas, API path constants, and SSE event names. Both `server/` and `mobile/` import it. The natural shape would be an npm workspace.

## Decision

Keep `kernel/` as a plain TypeScript folder, **not** an npm workspace. Consumers import via tsconfig `paths`:

```json
"paths": {
  "@chord/kernel": ["../kernel/src/index.ts"],
  "@chord/kernel/*": ["../kernel/src/*"]
}
```

Mobile additionally wires `kernel/` as a metro `watchFolder` + `extraNodeModules` alias so Expo hot-reloads kernel edits.

`kernel/package.json` exists only to mark the folder as ESM (`"type": "module"`). It may include `"private": true` so tooling treats it as non-publishable, but it must **not** include a `"name"` field (npm will try to resolve it as a workspace package). It is not a root workspace member and has no dependencies.

## Alternatives considered

- **Workspace (`"@chord/kernel"` in root `workspaces`).** Tried first. `npm install` succeeded and symlinks worked under Node, but `tsx` and Metro both tripped over the symlinked subpath resolution — Metro's Haste module system is particularly rough around npm-symlinked scoped packages. The sibling `webapp-start` project lands on the same "not a workspace" answer for the same reason.
- **file: dependency** (`"@chord/kernel": "file:../kernel"`). Solves the resolver problem but introduces a tarball-style install step — kernel edits require re-install to propagate. Loses hot reload.
- **Relative imports everywhere** (`../../kernel/src/types/message`). Ugly and brittle — every reorg breaks imports. Doesn't scale.

## Consequences

- If kernel ever needs a real dependency (rather than just TS types), it must be listed in *both* `server/package.json` and `mobile/package.json`.
- The production build must include kernel sources via the tsconfig `include` pattern (`include: [src/**, ../kernel/src/**]`), with no `rootDir` set. TSC emits `dist/server/src/**` + `dist/kernel/src/**`.
- A cleaner build pattern would rsync `kernel/` into `server/src/_kernel/` at build time (the webapp-start approach). Not wired — see `../tasks/`.
- Internal kernel imports must not use `.js` extensions. Metro doesn't resolve `.js` → `.ts` at runtime without a babel plugin. This is the one footgun for kernel contributors.
