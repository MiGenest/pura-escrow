# Pura — architecture

Escrowed freight payment on Solana. A shipper's USDC is locked in an account
the program owns, and where it goes is decided by the program's rules rather
than by someone deciding to pay. The platform co-signs every transaction, which
is a trust assumption; "Gasless, and what that costs in trust" below covers it.

Devnet. Program `2eUXsNeT5oCk5Q6NGg6ZXC8Y5Yc3p8DguBBsDzEBiGXt`, Anchor, 1,090
lines of Rust.

---

## The shape

```
  iPhone (shipper)        iPhone (carrier)
  React Native / Expo     React Native / Expo
  Privy embedded wallet   Privy embedded wallet
         │                        │
         │  builds + partially signs the transaction
         │  (the user's wallet never holds SOL)
         ▼                        ▼
  ┌──────────────────────────────────────────────┐
  │  Cloudflare Worker                           │
  │   • countersigns as FEE PAYER, after         │
  │     validating the instruction list          │
  │   • D1: contact details, route names,        │
  │     outcomes after an account closes         │
  └──────────────────────────────────────────────┘
         │ sends
         ▼
  ┌──────────────────────────────────────────────┐
  │  pura_escrow — 7 instructions                │
  │   initialize · accept · mark_delivered       │
  │   release · cancel · dispute                 │
  │   resolve_dispute                            │
  │                                              │
  │  Booking PDA  seeds: ["booking",             │
  │                       shipper, booking_id]   │
  │  Escrow vault  an ATA the PDA itself owns    │
  └──────────────────────────────────────────────┘
```

## The one account

`Booking` is a fixed-width struct: `booking_id`, `amount`, `shipper`,
`carrier`, `mint`, `status`, `bump`, four i32 coordinates, `pickup_date`,
`dropoff_date`, `delivered_at`.

`status` is a plain `u8` — `0` Open, `1` Accepted, `2` Delivered, `3` Disputed
— not a Rust enum, so the layout stays byte-for-byte decodable by the clients
without the IDL.

**Released and Cancelled are not status values.** Both close the account, so
*the account not existing* is the terminal state. There is no stored byte that
can disagree with what happened.

## Who may do what, and where it is enforced

| | enforced by |
|---|---|
| only the shipper may `initialize` | PDA seeds — the address derives from their key |
| only the named carrier may `mark_delivered` | `has_one` / address constraint |
| the shipper may `release` any time after Accepted | their own money, no extra gate |
| the carrier may `release` only once Delivered **and** 48h have passed | `REVIEW_WINDOW_SECS`, checked against `delivered_at` |
| the split is 95/5 | `PLATFORM_FEE_BPS = 500`, compiled in |
| the treasury cannot be substituted | `associated_token::authority = PLATFORM_TREASURY`, a constant |
| only the arbitrator may `resolve_dispute` | `ARBITRATOR` constant |

**None of that is in the server.** The server cannot move escrowed funds. The
team could, today, in two ways: by upgrading the program (its upgrade authority
is a single keypair), and by splitting a disputed escrow as the arbitrator. Both
keys need a multisig before real money; see the end of this page.

## Gasless, and what that costs in trust

Users hold no SOL and never see a seed phrase. The phone builds the
transaction, partially signs it, and the Worker countersigns as fee payer —
paying the signature and the account rent, which comes back when the booking
closes.

Because the program pins the fee payer, every escrow transaction needs the
platform's countersignature. The platform can therefore delay a release by not
sponsoring it, but it cannot redirect one: where the money goes is decided by
the program.

The Worker does not sign what it is handed. `validateInstructions` rejects any
instruction outside System, Token, Associated Token and `pura_escrow`, and
requires the final instruction to be the escrow call that was claimed. For
`initialize` it also re-derives the Booking PDA from its seeds and pins the
mint.

The fee-payer account is pinned three times. The program requires
`address = EXPECTED_FEE_PAYER` on it, the Worker checks it
(`requireRealFeePayer`), and the client refuses to broadcast otherwise
(`assertFeePayerIsSponsor`). Without that pin, any signer could take the
fee-payer slot and collect rent the platform paid.

Sponsorship is limited per wallet and per IP each hour. It is also limited by
one daily lamport cap across all callers (`FEE_PAYER_DAILY_CAP_LAMPORTS`,
default 1 SOL), logged in D1.

## What the server is for

Three things the chain deliberately does not hold:

1. **Contact details.** Phone numbers are not on-chain. The Worker returns them
   only to a signed caller who is recorded on the booking: its shipper, or its
   carrier. A carrier is recorded only after the Worker has read the booking
   on-chain and found that wallet named as its carrier.
2. **The human-readable half** — place names, cargo description, vehicle type.
3. **Outcomes after closure.** Release and cancel close the account, so the
   readable result is recorded in D1 by a signed report from either party. The
   transaction itself stays in the ledger.

Eight routes, three tables (`cargo`, `users`, `fee_sponsorships`):
- **Every write is signed by the wallet.** The signature covers a message that
  names the action and a timestamp, and is accepted for five minutes.
- **Reads that reveal private details are signed too.** The read's signature
  names the route and the wallet being read.
- **Two reads are public:** a profile's public half, and a booking's route and
  cargo details.

See `worker/README.md` for the details.

## Verified end to end

The full cycle was run on devnet on 2026-09-30, on two phones running
standalone Release builds: post, accept, mark delivered, release. The 95/5
split was exact. A booking delivered at 11:24 UTC on 30 Sep became
carrier-claimable at exactly 11:24 UTC on 2 Oct.

## What this is not

- **Devnet, and unaudited.** The audit gates mainnet.
- **Test USDC**, from this deployment's own devnet mint.
- **Single keypairs** hold the upgrade authority and the arbitrator role. Both
  need a multisig and a timelock before real money. Recorded in the code.
- **No fiat off-ramp.** A carrier paid in USDC has no in-app path to lari;
  there is no GEL rail.
