/**
 * Must be imported before anything that touches Privy or @solana/web3.js.
 * React Native's JS runtime (Hermes) lacks several Web APIs both depend on;
 * without these the failures are late and misleading — a crypto call that
 * returns zeros, or a "TextEncoder is not defined" thrown from deep inside a
 * vendored bundle rather than from the code that needed it.
 *
 * Ordering matters: react-native-get-random-values installs crypto.getRandomValues,
 * which @solana/web3.js reads at MODULE load, so it has to come first.
 *
 * Per Privy's Expo setup docs:
 * https://docs.privy.io/basics/react-native/installation
 */
import 'react-native-get-random-values';
import 'fast-text-encoding';
import '@ethersproject/shims';

import { Buffer } from 'buffer';

// @solana/web3.js assumes a global Buffer (account data, instruction bytes).
// Hermes has none, so provide it explicitly rather than relying on a bundler
// shim that may or may not be applied. Typed via globalThis because RN's
// `global` has no ambient declaration under expo/tsconfig.base.
const g = globalThis as typeof globalThis & { Buffer?: typeof Buffer };
if (typeof g.Buffer === 'undefined') {
  g.Buffer = Buffer;
}
