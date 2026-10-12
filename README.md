# Pura — escrowed freight payment on Solana

Copyright (c) 2026 PURA. All rights reserved. This source is published for hackathon judging only. No permission is granted to use, copy, modify or distribute it without written consent.

A shipper's USDC is locked in an account that the program owns. The carrier is paid when the load is delivered, by a
rule in the program: if the shipper does nothing for 48 hours after delivery, the carrier can release the payment
themselves.

Users sign in with Google, email or SMS through Privy embedded wallets. They hold no SOL and never see a seed phrase.
A server countersigns each transaction as the fee payer, after checking it against an instruction allowlist. That
makes the platform a co-signer of every escrow transaction: it can delay a release, but it cannot redirect one.

**Live on Solana devnet: https://pura.misha-9f1.workers.dev**: the deployed worker that the app in this repository
talks to.

**Program:** `2eUXsNeT5oCk5Q6NGg6ZXC8Y5Yc3p8DguBBsDzEBiGXt` on devnet —
[Solana Explorer](https://explorer.solana.com/address/2eUXsNeT5oCk5Q6NGg6ZXC8Y5Yc3p8DguBBsDzEBiGXt?cluster=devnet)

## What it does

1. **A shipper posts a load.** `initialize` creates a Booking account (a PDA) and moves the shipper's USDC into a
   vault that the PDA itself owns.
2. **A carrier accepts it.** `accept` writes the carrier's address onto the booking.
3. **The carrier marks it delivered.** `mark_delivered` starts a 48-hour review window.
4. **The money is released.** The shipper releases at any time, or the carrier claims once the 48 hours have
   passed. `release` pays 95% to the carrier and 5% to the platform, then closes the vault and the booking.

The other instructions:
- the shipper can `cancel` an open booking for a refund;
- once the booking is accepted, either party can raise a `dispute`, which freezes release and cancel until the
  arbitrator calls `resolve_dispute`.

[ARCHITECTURE.md](ARCHITECTURE.md) shows who may do what, and where each rule is enforced.

## What is in this repository

| path | what |
|---|---|
| `programs/pura-escrow/` | the Anchor program (Rust): seven instructions, one account type |
| `mobile/` | the app (React Native / Expo, TypeScript): the shipper's and the carrier's screens |
| `worker/` | the server the app calls (Cloudflare Worker + D1): the fee-payer countersignature, signed-message authentication, and the off-chain half of a booking (contact details, place names, outcomes) |
| `scripts/verify-program-id.mjs` | fails loudly if a build has drifted from the deployed program ID |
| `ARCHITECTURE.md` | the design on one page |

## How to run it

### The program

Requires:
- Rust (`rust-toolchain.toml` pins 1.89.0);
- the Solana CLI;
- Anchor 1.1.x.

```bash
anchor build
npm run verify-program-id
```

**In a fresh clone, the first `anchor build` rewrites the program ID.** It generates a program keypair and changes the
ID in `lib.rs` and `Anchor.toml` to match it, and `verify-program-id` reports the mismatch. To keep the deployed ID,
restore the two files and build again:

```bash
git checkout -- Anchor.toml programs/pura-escrow/src/lib.rs
anchor build
npm run verify-program-id    # Program ID verified: 2eUXsNeT…
```

### The worker

See [worker/README.md](worker/README.md):
1. create a D1 database;
2. apply `worker/schema.sql`;
3. fill `worker/.dev.vars` from `.dev.vars.example`;
4. run `npx wrangler dev`.

**The fee payer's daily cap.** The fee payer's spending is capped per UTC day by `FEE_PAYER_DAILY_CAP_LAMPORTS`. The
default is 1 SOL. Once a day's sponsored spend reaches the cap, the worker stops countersigning until 00:00 UTC. Every
setting is listed in [worker/README.md](worker/README.md).

### The app

Requires:
- Node 22.13 or later;
- Xcode (iOS) or Android Studio (Android);
- a Privy app with a native (Expo) client.

The app uses native modules, so it runs as a development build, not in Expo Go.

```bash
cd mobile
npm install
cp .env.example .env    # your Privy app ID and native client ID
npx expo run:ios        # or: npx expo run:android
```

The app talks to Solana devnet and to the live worker at https://pura.misha-9f1.workers.dev
(`mobile/src/lib/constants.ts`). To run everything locally, point `API` there at your own worker.

## What this is not

- **Devnet and test USDC.** Nothing here moves real money.
- **A demo price.** The price the app proposes is a fixed demo formula ($1.15 per km × the load's share of a full
  truck), not a market quote.
- **Not audited.** The audit gates mainnet.
- **Single keypairs** hold the program's upgrade authority and the arbitrator role. Both need a multisig and a
  timelock before real money; `constants.rs` records this.
- **No fiat off-ramp.** USDC paid out stays USDC.
