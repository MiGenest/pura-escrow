import { Connection } from '@solana/web3.js';

import { CLUSTER, PROGRAM_ID, RPC_HTTP, RPC_WS } from './constants';

/**
 * Shared devnet connection. Constructing this does no network I/O — the
 * first RPC call does — so it is safe at module scope.
 *
 * Same endpoint the web client uses (solana/app/src/main.jsx's
 * clusterApiUrl('devnet') and privy.jsx's createSolanaRpc), so both clients
 * read the same chain state. 'confirmed' matches the web app's default.
 */
export const connection = new Connection(RPC_HTTP, {
  commitment: 'confirmed',
  wsEndpoint: RPC_WS,
});

/** Short program id for display — enough to eyeball that a build is pointed
 *  at the right program without printing all 44 characters on a phone. */
export const programIdShort = `${PROGRAM_ID.toBase58().slice(0, 4)}…${PROGRAM_ID.toBase58().slice(-4)}`;

export { CLUSTER, PROGRAM_ID };
