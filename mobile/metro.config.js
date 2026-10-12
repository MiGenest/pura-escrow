// Required by @privy-io/expo. Several of its transitive dependencies publish
// "exports" maps that Metro's default resolution picks the wrong condition
// for, which surfaces as opaque "Unable to resolve module" / wrong-build
// errors at runtime rather than at install time. Lifted from Privy's Expo
// setup docs — keep in sync with them rather than editing by intuition.
//
// https://docs.privy.io/basics/react-native/installation
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Expo's default config already installs its own resolver here — that is what
// implements the `@/*` -> `./src/*` aliases from tsconfig.json's `paths`.
// Assigning over it (as Privy's snippet does verbatim) silently removes alias
// resolution, and the symptom is a bare "Unable to resolve module @/lib/..."
// on the FIRST aliased import in the entry chain. Capture it and delegate.
const expoResolveRequest = config.resolver.resolveRequest;

// Prefer Expo's resolver (aliases) and fall back to Metro's bare one only if
// a future Expo version stops installing it.
const delegate = (ctx, moduleName, platform) =>
  typeof expoResolveRequest === 'function'
    ? expoResolveRequest(ctx, moduleName, platform)
    : ctx.resolveRequest(ctx, moduleName, platform);

const resolveRequestWithPackageExports = (context, moduleName, platform) => {
  // isows and zustand ship exports maps whose "react-native"/"browser"
  // conditions resolve to builds Metro cannot consume; force the legacy
  // main-field path instead.
  if (moduleName === 'isows') {
    return delegate({ ...context, unstable_enablePackageExports: false }, moduleName, platform);
  }

  if (moduleName.startsWith('zustand')) {
    return delegate({ ...context, unstable_enablePackageExports: false }, moduleName, platform);
  }

  // jose's node build uses APIs React Native lacks — take the browser one.
  if (moduleName === 'jose') {
    return delegate({ ...context, unstable_conditionNames: ['browser'] }, moduleName, platform);
  }

  // Privy's own packages, conversely, REQUIRE exports-map resolution.
  if (moduleName.startsWith('@privy-io/')) {
    return delegate({ ...context, unstable_enablePackageExports: true }, moduleName, platform);
  }

  return delegate(context, moduleName, platform);
};

config.resolver.resolveRequest = resolveRequestWithPackageExports;

module.exports = config;
