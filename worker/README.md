# Escrow demo server

The Cloudflare Worker behind the escrow demo: the eight HTTP routes the mobile
app calls, over one D1 (SQLite) database.

The escrow program holds the money, the parties and each booking's status
on-chain. This worker keeps what the program does not carry:
- profiles;
- a booking's route and cargo details;
- contact details, which `GET /api/cargo` returns only to a signed caller who
  is the booking's shipper, or its carrier as checked on-chain;
- the outcome of a finished booking, once `release` or `cancel` has closed its
  on-chain account.

It also countersigns transactions as the fee payer, so a wallet never needs SOL
of its own. That route checks every instruction against an allowlist first.

This is a copy of production's worker, with deletions and one addition: the
on-chain carrier check on `POST /api/cargo/accept`. Every other function,
constant and route handler has production's code, and the comments describe
this copy. Where the code differs, a comment that begins
`PUBLIC COPY — differs from production:` says so. To list them:

    grep -n "PUBLIC COPY" *.js

## Routes

| route | who may call it | what it does |
|---|---|---|
| `POST /api/profile` | the wallet, signed | saves the wallet's profile |
| `GET /api/profile?wallet=` | anyone | the public half of a profile (no phone, email or documents) |
| `POST /api/cargo` | the shipper, signed | stores a booking's off-chain details, keyed by its PDA |
| `GET /api/cargo?pdas=` | anyone | details for up to 100 bookings; contact details only to a signed caller recorded on the booking as its shipper or carrier |
| `POST /api/cargo/accept` | the booking's on-chain carrier, signed | checks the carrier on-chain, then records it |
| `POST /api/cargo/complete` | the shipper or the recorded carrier, signed | records the outcome after `release` or `cancel` |
| `GET /api/cargo/history?wallet=` | that wallet, with a read signature | the wallet's finished bookings |
| `POST /api/fee-payer/sign` | the transaction's signer, signed | checks the transaction's instructions, then countersigns it as fee payer |

Signatures are ed25519, base58-encoded, and valid for five minutes:
- **Writes** sign `pura:<scope>:<unix ms>`, sent as `wallet`, `message` and
  `signature`. The signature is not bound to the request body.
- **The two signed reads**, `GET /api/cargo` with `wallet` and
  `GET /api/cargo/history`, sign in the query string (`auth_wallet`,
  `auth_message`, `auth_signature`), bound to the route and the wallet read.
- **`GET /api/profile` and `GET /api/cargo` without `wallet` are public.**

## Run it locally

You need Node.js 22 or later. A local run needs no Cloudflare account.

1. Install the dependencies:

       npm install

2. Create the D1 database. Locally there is nothing to create: wrangler makes
   the database file on first use, under `.wrangler/state`, and the placeholder
   `database_id` in `wrangler.toml` can stay. To deploy instead, run
   `npx wrangler d1 create pura-escrow-demo` and put the id it prints into
   `wrangler.toml`.

3. Apply the schema:

       npx wrangler d1 execute pura-escrow-demo --local --file=schema.sql

4. Fill in `.dev.vars`:

       cp .dev.vars.example .dev.vars

   - `FEE_PAYER_SECRET` is the content of the fee payer's keypair file, for
     example from `solana-keygen new --no-bip39-passphrase -o fee-payer-keypair.json`.
     Fund that address with devnet SOL.
   - `USDC_MINT` is the mint your bookings are paid in.
   - The other two keys are optional; see Settings below.
   - Never commit `.dev.vars` or the keypair file.

5. Start the worker:

       npx wrangler dev

   It listens on http://localhost:8787, and
   `curl http://localhost:8787/api/cargo` answers `{"cargo":{}}`.

The worker makes one RPC call of its own: `POST /api/cargo/accept` reads the
booking's account (see `SOLANA_RPC_URL` below). For transactions, the app
fetches a blockhash, has the worker countersign, and submits the transaction
itself. `PURA_PROGRAM_ID` in `sponsor.js` is the escrow program's address, for
the fee payer's checks and the accept check alike. Change it if you deploy your
own build of the program.

The mobile app talks to the hosted demo at https://pura.misha-9f1.workers.dev.
To use a local worker instead, point the app's `API` constant at it.

## Settings

The keys of `.dev.vars`, all read from the worker's environment:

| key | default | what it sets |
|---|---|---|
| `FEE_PAYER_SECRET` | none (required) | the fee payer's keypair, as the JSON array of 64 numbers a keypair file holds |
| `USDC_MINT` | none (required) | the mint bookings are paid in |
| `FEE_PAYER_DAILY_CAP_LAMPORTS` | 1 SOL per UTC day, from `DEFAULT_DAILY_CAP_LAMPORTS` in `sponsor.js` | the most the fee payer sponsors in a UTC day, all wallets together. Once the day's sponsored spend reaches it, the fee payer refuses to countersign until 00:00 UTC |
| `SOLANA_RPC_URL` | Solana's public devnet RPC, `https://api.devnet.solana.com` | where `POST /api/cargo/accept` reads the booking. The default is fine locally. A deployed worker needs an endpoint that accepts requests from Cloudflare, because the public one refuses Cloudflare's IPs |

Without `FEE_PAYER_SECRET` or `USDC_MINT`, `POST /api/fee-payer/sign` answers
500 and the other routes still work. The hourly limits per wallet and per IP
are not settings: they are the constants `SPONSOR_LIMIT_PER_WALLET` and
`SPONSOR_LIMIT_PER_IP` in `sponsor.js`.

## Files

| file | what it holds |
|---|---|
| `index.js` | the router and the eight route handlers |
| `auth.js` | the wallet-signature checks |
| `sponsor.js` | the fee payer's instruction allowlist, rent maths, hourly request limits and daily lamports cap |
| `schema.sql` | the three tables: `cargo`, `users` and `fee_sponsorships` |
| `wrangler.toml` | the worker's name and its D1 binding |
| `.dev.vars.example` | the four settings, without values |

## What differs from production

Each difference is marked in place in the code:
- `GET /api/cargo/history` lets only the wallet itself read its history.
- `POST /api/fee-payer/sign` refuses the `resolve_dispute` kind, which
  production accepts behind an extra gate.
- The router keeps only the demo's routes.
- The CORS allowlist keeps only the origins this copy serves.
- `POST /api/cargo/accept` checks on-chain that the caller is the booking's
  carrier before recording it.
