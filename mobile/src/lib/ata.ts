import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import { Buffer } from 'buffer';

import idl from '@/idl/pura_escrow.json';

/**
 * The two pieces of @solana/spl-token the booking flow actually needs:
 * deriving an associated token account, and creating one idempotently.
 *
 * Not a dependency, for the same reason accept.ts skipped Anchor — the whole
 * of spl-token bought for one PDA derivation and one six-key instruction is
 * a poor trade in a React Native bundle, and both are a handful of lines the
 * program's own IDL already pins the addresses for.
 *
 * Both are byte-compatible with getAssociatedTokenAddressSync and
 * createAssociatedTokenAccountIdempotentInstruction; they have to be, since
 * worker/index.js re-derives the same addresses from the transaction bytes
 * and rejects a mismatch (validateInstructions' `shipper ATA mismatch` /
 * `escrow vault mismatch` / `unexpected ATA creation`).
 */

/** Pulled from the IDL's own account addresses rather than pasted, the same
 *  rule constants.ts follows for PROGRAM_ID: the client builds instructions
 *  from this file's account ordering, so an address that disagrees with the
 *  IDL beside it is incoherent by construction. */
type IdlAccount = { name: string; address?: string };

function idlAccountAddress(instruction: string, account: string): PublicKey {
  const accounts = (idl.instructions.find((i) => i.name === instruction)?.accounts ??
    []) as IdlAccount[];
  const address = accounts.find((a) => a.name === account)?.address;
  if (!address) throw new Error(`IDL is missing ${instruction}.${account}'s address`);
  return new PublicKey(address);
}

export const TOKEN_PROGRAM_ID = idlAccountAddress('initialize', 'token_program');
export const ASSOCIATED_TOKEN_PROGRAM_ID = idlAccountAddress(
  'initialize',
  'associated_token_program'
);

/**
 * Deterministic ATA address. Equivalent to getAssociatedTokenAddressSync
 * with allowOwnerOffCurve: true — the escrow vault's owner is the booking
 * PDA, which is off-curve by construction, and the seeds are identical
 * either way. spl-token's on-curve check only ever rejects; it never changes
 * the address, so omitting it cannot produce a different one.
 */
export function associatedTokenAddress(owner: PublicKey, mint: PublicKey): PublicKey {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  return ata;
}

/**
 * CreateIdempotent — instruction discriminant 1, a single data byte. (Plain
 * Create is zero bytes; the worker accepts either, `data.length <= 1`.)
 *
 * Idempotent matters here: the wallet's ATA is normally created at connect
 * time, so this instruction is usually a no-op, and the non-idempotent
 * variant would fail the whole booking on an account that already exists.
 *
 * Key order is fixed by the ATA program and is also what the worker
 * destructures ([payer, ata, owner, mint]) to check the payer is the real
 * fee payer and the owner is the shipper — so it is load-bearing, not
 * cosmetic.
 */
export function createAssociatedTokenAccountIdempotentInstruction(
  payer: PublicKey,
  ata: PublicKey,
  owner: PublicKey,
  mint: PublicKey
): TransactionInstruction {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
}
