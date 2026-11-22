const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '..');
const kernelRoot = path.resolve(workspaceRoot, 'kernel');

const config = getDefaultConfig(projectRoot);

// Watch the workspace root so hoisted node_modules (assets, etc.) are served,
// plus the kernel sources so edits in ../kernel hot-reload here.
config.watchFolders = [workspaceRoot, kernelRoot];

// Resolve packages via mobile/node_modules first, then the hoisted root.
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

// Alias "@chord/kernel" imports to the kernel source so tsconfig paths + metro match.
config.resolver.extraNodeModules = {
  ...config.resolver.extraNodeModules,
  '@chord/kernel': path.resolve(kernelRoot, 'src'),
};

config.resolver.disableHierarchicalLookup = false;

// Don't walk server-only native deps. Metro's file-map watcher chokes on
// half-written npm tmp files inside these trees (e.g. node_modules/sharp/
// scratch state), and they're never resolvable from the mobile bundle
// anyway. Combine with whatever blockList getDefaultConfig already set.
const escapedRoot = workspaceRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const serverOnlyBlocks = [
  new RegExp(`${escapedRoot}[\\\\/]node_modules[\\\\/]sharp[\\\\/].*`),
  new RegExp(`${escapedRoot}[\\\\/]node_modules[\\\\/]@img[\\\\/].*`),
  // npm bin shims (node_modules/.bin/*) are symlinks. On Windows under OneDrive,
  // lstat-ing them throws EACCES and crashes Metro's fallback file watcher.
  // They're never resolvable from the bundle; skip the whole .bin dir in every
  // node_modules tree (root + mobile).
  /[\\/]node_modules[\\/]\.bin([\\/]|$)/,
];
config.resolver.blockList = config.resolver.blockList
  ? [].concat(config.resolver.blockList, serverOnlyBlocks)
  : serverOnlyBlocks;

// libphonenumber-js's package `exports` maps the `import` condition to its ESM
// build (`./index.js`), whose explicit-`.js` relative imports Metro can't
// resolve under SDK 54's package-exports resolution. Its `require`/`main` is a
// clean CommonJS build. Disable package exports for THIS package only so Metro
// picks the CommonJS entry; everything else keeps exports resolution.
const defaultResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === 'libphonenumber-js' || moduleName.startsWith('libphonenumber-js/')) {
    return context.resolveRequest(
      { ...context, unstable_enablePackageExports: false },
      moduleName,
      platform,
    );
  }
  return (defaultResolveRequest ?? context.resolveRequest)(context, moduleName, platform);
};

module.exports = config;
