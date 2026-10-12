/** Ported verbatim from solana/app/src/lib/format.js so both clients
 *  render the same numbers. Amounts are USDC (6 decimals) throughout. */

export const usdc = (a: bigint | number) =>
  (typeof a === 'bigint' ? Number(a) : a) / 1_000_000;

/** Display only — drops the "USDC" unit in favour of a plain dollar sign,
 *  same as web. */
export const fmt$ = (n: number) => `$${Number.isInteger(n) ? n : n.toFixed(2)}`;
