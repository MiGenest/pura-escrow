import {
  PublicKey,
  SendTransactionError,
  Transaction,
  type TransactionInstruction,
} from '@solana/web3.js';
import { Buffer } from 'buffer';

import { API, FEE_PAYER } from './constants';
import { encodeMessageForPrivy, toBase58Signature, type SigningWallet } from './profile';
import { connection } from './solana';

/**
 * Fee-payer sponsorship — the half of solana/app/src/lib/transactions.js's
 * sponsorAndSend() that is identical for every instruction kind.
 *
 * Extracted from accept.ts when the booking flow became the second caller.
 * The transaction bytes are unchanged by the move: same steps, same order,
 * same `kind` strings.
 *
 * buildAndSimulate() holds the pre-flight half. What a failed simulation
 * MEANS ("this load can't be accepted" vs "you don't have enough USDC") is
 * still flow-specific, so each caller passes its own `failure` — but the
 * building, the blockhash and the stale-blockhash retry are shared, because
 * that race is a property of the RPC endpoint, not of any one instruction.
 *
 * assertFeePayerIsSponsor in particular must exist exactly once. A second
 * copy is a second thing to forget to update, and the failure it guards
 * against — a user's own empty wallet silently paying rent and fees — is
 * invisible until someone checks a balance.
 */

export const FEEPAYER_MESSAGE_PREFIX = 'pura:feepayer:';

/**
 * A blockhash fetched from one node and simulated against another that has
 * not caught up yet. Seen on devnet 2026-09-18: an accept simulated as
 * "BlockhashNotFound", the tap was wasted, and the immediate retry worked.
 * api.devnet.solana.com load-balances across nodes at different heights, so
 * this is routine rather than exceptional.
 *
 * Matches both spellings: the in-band `value.err` is the enum name
 * ("BlockhashNotFound"), while an RPC-level rejection says "Blockhash not
 * found".
 */
const STALE_BLOCKHASH = /BlockhashNotFound|Blockhash not found/i;

/** Total simulation attempts before giving up on a stale blockhash. Two was
 *  not enough: on devnet 2026-09-20 a mark_delivered needed three taps, each
 *  one burning both of its attempts. */
const SIM_ATTEMPTS = 3;
/** Delay before retry 1 and retry 2. Short enough not to feel like a hang,
 *  long enough that the endpoint has advanced a slot or two. */
const SIM_BACKOFF_MS = [400, 900];

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The embedded wallet's webview failed to service a signing request. Seen on
 * device 2026-09-18: a post simulated clean, then threw
 *
 *   {"message":"An unexpected error occurred",
 *    "code":"embedded_wallet_request_error", ...}
 *
 * out of Privy's handleEmbeddedWalletMessages via react-native-webview's
 * onMessage. The immediate re-tap succeeded, which is the signature of a
 * transient bridge failure rather than a real refusal.
 *
 * Matched on the CODE, never on the message text. "An unexpected error
 * occurred" is generic enough to appear on failures that are not transient,
 * and — more importantly — a user DECLINING to sign must never be swallowed
 * by a retry. A rejection carries a different code and falls straight
 * through this check untouched.
 */
function isWalletRequestError(err: unknown): boolean {
  if (typeof err === 'object' && err !== null) {
    const { code } = err as { code?: unknown };
    if (code === 'embedded_wallet_request_error') return true;
  }
  return /embedded_wallet_request_error/i.test(describeError(err));
}

/** Privy throws plain objects, not Errors — String() on one yields
 *  "[object Object]", which is worse than useless in a device log. */
function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/** What the user sees when the wallet could not be reached. Deliberately
 *  says nothing was sent — that is the only fact they actually need, and
 *  after a failed on-chain attempt it is the one they most want. */
const WALLET_UNAVAILABLE =
  'Your wallet did not respond, so nothing was signed or sent. Tap Try again.';

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The fee-payer authorisation signature, retried once on a transient wallet
 * bridge failure — same shape as buildAndSimulate's blockhash retry, and for
 * the same reason: the user did nothing wrong and has nothing to act on.
 *
 * Safe to retry because this message is pure authorisation: a fresh
 * timestamp, no on-chain effect, nothing submitted, and the worker only ever
 * sees the one that succeeds.
 *
 * The retry deliberately stops before the SUBMISSION steps. Everything past
 * the signature either costs the platform something on repeat (POST
 * /api/fee-payer/sign is rate-limited and counts against the fee payer's
 * daily lamport cap) or risks a second broadcast. Those need their own
 * handling, not this loop.
 *
 * WHAT IS SAFE TO RETRY, and why this generalises. Every message this wraps
 * is pure authorisation: a fresh timestamp, no on-chain effect, nothing
 * submitted, and the worker only ever sees the one that succeeds. That
 * property holds for the post-chain metadata signatures too, which is why
 * they can share this helper rather than needing a different mechanism.
 *
 * This is NOT buildAndSimulate's blockhash retry. That one re-simulates
 * against a lagging RPC; this one re-asks a wallet bridge that was not
 * ready. Different failure, different remedy, deliberately separate.
 */
export async function signWithRetry(
  wallet: SigningWallet,
  prefix: string,
  tag: string
) {
  const label = `${scopeOf(prefix)} sig`;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await signPrefixed(wallet, prefix);
    } catch (err) {
      // A user DECLINING to sign carries a different code and must fall
      // straight through untouched — re-prompting someone who just said no
      // is worse than the failure it would paper over.
      if (!isWalletRequestError(err)) throw err;
      if (attempt === 1) {
        console.log(`[${tag}] ${label}: wallet bridge failed, retrying once`);
        // A beat for the webview to settle. The failure mode is the bridge
        // not being ready, so an instant retry tends to hit the same state.
        await pause(400);
        continue;
      }
      console.log(`[${tag}] ${label} FAILED after retry :: ${describeError(err)}`);
      throw new Error(WALLET_UNAVAILABLE);
    }
  }
  /* istanbul ignore next — the loop either returns or throws */
  throw new Error(WALLET_UNAVAILABLE);
}

const signFeePayerAuth = (wallet: SigningWallet, tag: string) =>
  signWithRetry(wallet, FEEPAYER_MESSAGE_PREFIX, tag);

export type SimulationFailure = {
  err: unknown;
  logs: string[];
  /** The first Anchor/program error line, when the program produced one —
   *  by far the most useful thing to show a user, and absent for failures
   *  that never reached the program. */
  anchorLine: string | undefined;
};

/**
 * Build the transaction, simulate it, and hand back one that is ready to
 * sign — retrying ONCE with a fresh blockhash if that is all that was wrong.
 *
 * Simulation runs before any wallet prompt on purpose: sigVerify is off, so
 * the program's own deserialization and authority checks run without real
 * signatures, and a doomed transaction costs no taps. The retry is deliberately
 * silent to the user — a stale blockhash is not something they did, and not
 * something they can act on.
 */
export async function buildAndSimulate({
  wallet,
  instructions,
  tag,
  failure,
}: {
  wallet: SigningWallet;
  instructions: TransactionInstruction[];
  tag: string;
  /** Turns a genuine simulation failure into the message this flow shows. */
  failure: (info: SimulationFailure) => Error;
}): Promise<Transaction> {
  const signer = new PublicKey(wallet.address);

  for (let attempt = 1; attempt <= SIM_ATTEMPTS; attempt++) {
    // Backoff BEFORE the retry, not after the failure: the point is to give
    // the endpoint time to catch up, and refetching a blockhash the instant
    // the last one was rejected tends to get the same answer. Skipped on the
    // first attempt so the common case costs nothing.
    if (attempt > 1) await sleep(SIM_BACKOFF_MS[attempt - 2]);

    // A fresh Transaction each time — the point of the retry is a NEW
    // blockhash, so reusing the object would retry the same stale one.
    const tx = new Transaction().add(...instructions);
    tx.feePayer = FEE_PAYER;
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

    console.log(`[${tag}] simulate: start${attempt > 1 ? ` (retry ${attempt - 1}/${SIM_ATTEMPTS - 1})` : ''}`);

    let result;
    try {
      result = await connection.simulateTransaction(tx, undefined, [signer]);
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      if (attempt < SIM_ATTEMPTS && STALE_BLOCKHASH.test(text)) {
        console.log(`[${tag}] simulate: stale blockhash from RPC, refetching`);
        continue;
      }
      if (STALE_BLOCKHASH.test(text)) break;   // exhausted — fall to the network message
      throw err;
    }

    if (!result.value.err) {
      console.log(`[${tag}] simulate: ok`);
      return tx;
    }

    const errText = JSON.stringify(result.value.err);
    if (STALE_BLOCKHASH.test(errText)) {
      if (attempt < SIM_ATTEMPTS) {
        console.log(`[${tag}] simulate: stale blockhash, refetching and retrying`);
        continue;
      }
      // Exhausted. Deliberately does NOT call failure(): see below.
      break;
    }

    const logs = result.value.logs ?? [];
    const anchorLine = logs.find((l) => /AnchorError|Error Code|Error Number/.test(l));
    console.log(`[${tag}] simulate FAILED ${errText} :: ${anchorLine ?? '(no anchor line)'}`);
    throw failure({ err: result.value.err, logs, anchorLine });
  }

  // EVERY attempt hit a stale blockhash. This is a transient RPC condition,
  // never a verdict about the booking — so it must NOT go through failure(),
  // whose callers word their messages as permanent ("This payment can't be
  // released", "This load can't be marked delivered"). On 2026-09-20 it did
  // exactly that: this branch was unreachable, because the old guard only
  // continued on attempt 1, so a second stale blockhash fell through to
  // failure() and told a carrier their load could not be marked delivered
  // when the truth was that devnet was briefly behind. It took three taps.
  //
  // Nothing has been signed or submitted at this point — simulation happens
  // before any wallet prompt — so saying so is both true and the most useful
  // thing a user can be told.
  console.log(`[${tag}] simulate FAILED: blockhash still not found after ${SIM_ATTEMPTS} attempts`);
  throw new Error('The network is busy right now — nothing was sent. Try again in a moment.');
}

/** 'pura:feepayer:' -> 'feepayer'. Just for log lines. */
const scopeOf = (prefix: string) => prefix.replace(/^pura:/, '').replace(/:$/, '') || prefix;

/**
 * Timing probe around the two halves of a Privy signature.
 *
 * Added 2026-09-19 to locate a `user-signer:sign` timeout that survives a
 * cold start, a fresh OAuth login, both accounts, and both networks — while
 * auth.privy.io loads fine in the device's browser.
 *
 * The split matters because these fail for different reasons. Reading the
 * SDK: `signWithUserSigner` does `invoke('privy:user-signer:sign', …)`, which
 * posts a message into the embedded-wallet WebView and waits for a reply
 * keyed by callback id. Unlike `create()`, it does NOT call `waitForReady()`
 * first — so if that WebView never came up, the message goes nowhere and the
 * only symptom is a timeout with no other error. Whether `getProvider()`
 * returns promptly therefore tells us whether the SDK believes it has a live
 * wallet at all, and the request duration tells us whether we are hitting the
 * SDK's own timeout or failing earlier.
 *
 * Logging only — no retry, no behaviour change.
 */
export async function timedSignMessage(
  wallet: SigningWallet,
  message: string,
  scope: string
): Promise<string> {
  const t0 = Date.now();
  console.log(`[sign] ${scope}: getProvider…`);

  let provider;
  try {
    provider = await wallet.getProvider();
  } catch (err) {
    console.log(`[sign] ${scope}: getProvider THREW after ${Date.now() - t0}ms :: ${describeError(err)}`);
    throw err;
  }

  const tProvider = Date.now();
  console.log(`[sign] ${scope}: getProvider ok in ${tProvider - t0}ms — request…`);

  try {
    const { signature } = await provider.request({
      method: 'signMessage',
      params: { message: encodeMessageForPrivy(message) },
    });
    console.log(
      `[sign] ${scope}: request ok in ${Date.now() - tProvider}ms (total ${Date.now() - t0}ms)`
    );
    return signature;
  } catch (err) {
    console.log(
      `[sign] ${scope}: request FAILED after ${Date.now() - tProvider}ms ` +
        `(total ${Date.now() - t0}ms) :: ${describeError(err)}`
    );
    throw err;
  }
}

/** The plain `<prefix><ts>` message form used by every write scope. The read
 *  scope's bound form is different and lives in cargo.ts. */
export async function signPrefixed(wallet: SigningWallet, prefix: string) {
  const message = `${prefix}${Date.now()}`;
  const signature = await timedSignMessage(wallet, message, scopeOf(prefix));
  return { wallet: wallet.address, message, signature: toBase58Signature(signature) };
}

/**
 * Refuses to send anything whose fee payer is not the platform's. Checked on
 * the bytes about to go out, not trusted from earlier in the flow — this is
 * the one place a bug could actually charge the user's own (empty) wallet.
 */
export function assertFeePayerIsSponsor(txBytes: Uint8Array, walletPubkey: PublicKey) {
  const tx = Transaction.from(Buffer.from(txBytes));
  if (!tx.feePayer?.equals(FEE_PAYER) || tx.feePayer.equals(walletPubkey)) {
    throw new Error('BUG: fee payer on signed transaction is not FEE_PAYER — refusing to send');
  }
}

/**
 * Steps 3-6 of both on-chain flows: authorise the sponsorship, sign as the
 * program's required signer, have the worker countersign as fee payer, and
 * submit.
 *
 * `tx` must already carry its instructions, feePayer and blockhash — and
 * should already have been simulated, because every prompt below costs the
 * user a tap.
 */
export async function sponsorSignAndSend({
  wallet,
  tx,
  kind,
  tag,
}: {
  wallet: SigningWallet;
  tx: Transaction;
  kind: string;
  /** Log prefix, e.g. 'accept' or 'book' — these lines are how a failure on
   *  a real device gets diagnosed without a debugger attached. */
  tag: string;
}): Promise<string> {
  const signerPubkey = new PublicKey(wallet.address);

  console.log(`[${tag}] feepayer sig: start`);
  const auth = await signFeePayerAuth(wallet, tag);

  // Privy takes a live Transaction and returns it mutated.
  console.log(`[${tag}] signTransaction: start`);
  const provider = await wallet.getProvider();
  const { signedTransaction } = await provider.request({
    method: 'signTransaction',
    params: { transaction: tx },
  });

  const unsponsored = Buffer.from(
    signedTransaction.serialize({ requireAllSignatures: false })
  ).toString('base64');

  // The worker validates the instruction shape against `kind` independently
  // (validateInstructions), then countersigns.
  console.log(`[${tag}] fee-payer/sign: start kind=${kind}`);
  const res = await fetch(`${API}/api/fee-payer/sign`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...auth, kind, tx: unsponsored }),
  });
  const data = (await res.json()) as { signedTx?: string; error?: string };
  if (!data.signedTx) throw new Error(data.error || `sponsorship failed (${res.status})`);

  const finalBytes = new Uint8Array(Buffer.from(data.signedTx, 'base64'));
  assertFeePayerIsSponsor(finalBytes, signerPubkey);

  console.log(`[${tag}] sendRawTransaction: start`);
  let signature: string;
  try {
    signature = await connection.sendRawTransaction(finalBytes);
  } catch (err) {
    // web3.js hides the useful part behind getLogs(); the summary alone says
    // only "custom program error: 0xbbb". Surfacing the Anchor line is what
    // turned 2026-09-18's failure from opaque into a five-minute diagnosis.
    if (err instanceof SendTransactionError) {
      const logs = await err.getLogs(connection).catch(() => null);
      const anchorLine = (logs ?? []).find((l) => /AnchorError|Error Code/.test(l));
      console.log(`[${tag}] send FAILED :: ${anchorLine ?? err.message}`);
      if (logs) console.log(`[${tag}] logs: ${JSON.stringify(logs.slice(0, 8))}`);
      throw new Error(anchorLine?.replace(/^Program log: /, '') ?? err.message);
    }
    throw err;
  }

  const { value } = await connection.confirmTransaction(signature, 'confirmed');
  if (value.err) throw new Error(`transaction failed on-chain: ${JSON.stringify(value.err)}`);
  console.log(`[${tag}] confirmed on-chain: ${signature}`);
  return signature;
}
