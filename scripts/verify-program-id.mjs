#!/usr/bin/env node
// Fails loudly if the program ID has drifted from the deployed program.
//
// WHY THIS EXISTS
// ---------------
// `anchor build` run in a checkout whose `target/` is empty — a fresh clone,
// a new git worktree, after `cargo clean` — does not error. It silently
// generates a NEW program keypair into target/deploy/, then rewrites
// `declare_id!()` in lib.rs AND `[programs.*]` in Anchor.toml to match it.
// This was observed three times in a row on 2026-09-11, each time in a fresh
// worktree.
//
// The consequence is not a build failure, it is a successful build of the
// wrong program. `anchor deploy` would then publish to an address nobody
// uses, and `anchor upgrade --program-id <real>` would push bytecode whose
// own embedded `declare_id!` disagrees with the account it lives in — so
// every instruction fails a DeclaredProgramIdMismatch check at runtime. On
// mainnet that is a live outage with funds locked in escrow behind it.
//
// MECHANISM CHOICE
// ----------------
// The obvious alternative is committing target/deploy/pura_escrow-keypair.json
// so a fresh checkout always derives the same ID. Rejected: for an already
// deployed upgradeable program that keypair grants nothing (upgrades are
// authorized by the upgrade authority, not the program key), so committing it
// buys no safety — while permanently normalising "a keypair lives in git" in
// a repo where a *real* secret (FEE_PAYER_SECRET) is one careless paste away
// from the same fate. A check that fails loudly costs one command and teaches
// the opposite habit.
//
// USAGE
//   node scripts/verify-program-id.mjs      (or: npm run verify-program-id)
// Run it AFTER `anchor build` and BEFORE any `anchor deploy` / `anchor
// upgrade`. Exits 0 when everything agrees, 1 with a diff when it does not.
//
// If the program ID ever legitimately changes (a genuinely new deployment,
// not an upgrade), update EXPECTED_PROGRAM_ID below in the same commit that
// changes lib.rs — that is the point: the change becomes deliberate and
// reviewable instead of silent.

import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// The live devnet program. Source of truth; everything else is compared to it.
const EXPECTED_PROGRAM_ID = '2eUXsNeT5oCk5Q6NGg6ZXC8Y5Yc3p8DguBBsDzEBiGXt'

const sources = [
  {
    label: 'lib.rs declare_id!()',
    path: 'programs/pura-escrow/src/lib.rs',
    required: true,
    extract: (s) => s.match(/declare_id!\("([1-9A-HJ-NP-Za-km-z]+)"\)/)?.[1],
  },
  {
    label: 'Anchor.toml [programs.*]',
    path: 'Anchor.toml',
    required: true,
    extract: (s) => s.match(/^\s*pura_escrow\s*=\s*"([1-9A-HJ-NP-Za-km-z]+)"/m)?.[1],
  },
  {
    // only present after a build; checked when it is, since this is the
    // artifact the client actually consumes (src/constants.js reads
    // idl.address to derive PROGRAM_ID)
    label: 'built IDL address',
    path: 'target/idl/pura_escrow.json',
    required: false,
    extract: (s) => JSON.parse(s).address,
  },
]

const problems = []
const checked = []

for (const { label, path, required, extract } of sources) {
  const full = join(ROOT, path)
  if (!existsSync(full)) {
    if (required) problems.push(`  ${label} — file not found at ${path}`)
    continue
  }
  let found
  try {
    found = extract(readFileSync(full, 'utf8'))
  } catch (err) {
    problems.push(`  ${label} — could not parse ${path}: ${err.message}`)
    continue
  }
  if (!found) {
    problems.push(`  ${label} — no program ID found in ${path}`)
  } else if (found !== EXPECTED_PROGRAM_ID) {
    problems.push(`  ${label} — ${found}\n      expected ${EXPECTED_PROGRAM_ID}   (${path})`)
  } else {
    checked.push(`  ${label.padEnd(24)} ok`)
  }
}

if (problems.length > 0) {
  console.error(`\nPROGRAM ID MISMATCH — refusing to vouch for this build.\n`)
  console.error(problems.join('\n'))
  console.error(`
This is almost certainly \`anchor build\` having regenerated the program
keypair because target/ was empty (fresh clone / new worktree / cargo clean).
It rewrites lib.rs and Anchor.toml silently.

To fix, from the repo:
  git checkout -- Anchor.toml programs/pura-escrow/src/lib.rs
  anchor build          # re-run; the ID sticks once a keypair exists
  npm run verify-program-id

Do NOT deploy or upgrade until this passes.
`)
  process.exit(1)
}

console.log(`\nProgram ID verified: ${EXPECTED_PROGRAM_ID}`)
console.log(checked.join('\n'))
console.log('')
