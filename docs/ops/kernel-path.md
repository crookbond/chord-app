# Why kernel/ isn't an npm workspace

`kernel/` holds shared types, zod schemas, API path constants, and SSE event names. Both `server/` and `mobile/` import it.

The obvious shape would be "another npm workspace." We don't do that.

## What we do instead

- `kernel/` has a minimal `package.json` with `{ "private": true, "type": "module" }` plus an optional `//` human note, **no `name`**, and it is not registered in root `workspaces`. This marker is just there so Node / tsx treat the kernel `.ts` files as ESM.
- Both `server/tsconfig.json` and `mobile/tsconfig.json` declare path aliases:
  ```json
  "paths": {
    "@chord/kernel": ["../kernel/src/index.ts"],
    "@chord/kernel/*": ["../kernel/src/*"]
  }
  ```
- `mobile/metro.config.js` adds:
  ```js
  config.watchFolders = [path.resolve(__dirname, '../kernel')];
  config.resolver.extraNodeModules = {
    '@chord/kernel': path.resolve(__dirname, '../kernel/src'),
  };
  ```
  so Metro resolves `@chord/kernel` → `kernel/src/index.ts` at runtime, and hot-reloads kernel edits.

## Why not a workspace

Expo's Metro bundler has historically been rough around npm workspaces — symlinks in `node_modules/@scope/foo` don't always round-trip through Metro's resolver predictably, especially with React Native's Haste module system. The webapp-start project in the sibling repo lands on the same answer (path alias, no workspace) for the same reason.

We tried workspace-mode first. `npm install` succeeded but `tsx` still couldn't resolve subpath imports cleanly until we added the `{ "type": "module" }` package.json. At that point "path alias + marker file" was simpler and had fewer moving parts than "workspace + special metro config + marker file," so we kept only the alias path.

## Build implications

`server`'s production build runs `tsc` with `include: [src/**/*, ../kernel/src/**/*]` and no `rootDir`. TSC emits both `server/dist/src/**` and `server/dist/kernel/src/**` which the path alias resolution in the compiled JS can find.

(There's a cleaner pattern — rsync `kernel/` into `server/src/_kernel/` during build, the same one webapp-start uses. Not wired yet; see `tasks/`.)

## Pitfalls

- Don't add `.js` extensions to internal kernel imports (`./types/user`, not `./types/user.js`). TSC's bundler moduleResolution handles both, but Metro does not resolve `.js` → `.ts` at runtime unless you add a babel plugin.
- Don't give `kernel/package.json` a `name` field. If you do, npm will try to register it in the workspace graph and fail with 404s ("@chord/kernel not in registry") because it's not installed anywhere.
- If you need kernel to ship its own dependency (not just TS types), add it to *both* `server` and `mobile`'s `dependencies`. There's no single "install once for kernel" step.
