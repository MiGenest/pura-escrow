use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Mint, Token, TokenAccount, TransferChecked},
};

use crate::constants::{
    EXPECTED_FEE_PAYER, EXPECTED_USDC_MINT, EXPECTED_USDC_MINT_PLACEHOLDER, STATUS_OPEN,
};
use crate::error::ErrorCode;
use crate::state::Booking;

#[derive(Accounts)]
#[instruction(amount: u64, booking_id: u64)]
pub struct Initialize<'info> {
    pub shipper: Signer<'info>,

    // pays for the booking PDA + escrow vault ATA's rent, and is who gets
    // that rent back when the account closes (release.rs/cancel.rs both
    // `close = fee_payer`). In the sponsored flow (src/lib/transactions.js's
    // sponsorAndSend) this is the app's fee-payer wallet, which already
    // co-signs every sponsored transaction server-side — this just gives
    // that existing signature an explicit role in the instruction instead
    // of laundering rent through a separate top-up-then-spend transfer to
    // the shipper's own wallet (the previous design; see git history).
    // Pinned to EXPECTED_FEE_PAYER, same as the three closing instructions.
    // This deliberately closes the door the previous comment here left open
    // ("nothing stops a self-funded shipper from passing their own key"):
    // now that release/cancel/resolve_dispute all refund rent *to*
    // EXPECTED_FEE_PAYER, letting anyone else fund it would mean paying rent
    // that can only ever be refunded to somebody else. Constraining both
    // ends keeps payer and payee the same account by construction rather
    // than by convention. worker/index.js's validateInstructions() already
    // required this off-chain (requireRealFeePayer, called for all four
    // instructions); this makes it true for hand-built transactions too.
    // See constants.rs and POST-REWRITE-REVIEW.md PR-4.
    #[account(mut, address = EXPECTED_FEE_PAYER @ ErrorCode::InvalidFeePayer)]
    pub fee_payer: Signer<'info>,

    #[account(
        init,
        payer = fee_payer,
        space = 8 + Booking::INIT_SPACE,
        seeds = [b"booking", shipper.key().as_ref(), &booking_id.to_le_bytes()],
        bump
    )]
    pub booking: Account<'info, Booking>,

    /// CHECK: carrier is just a wallet address here, no data read
    pub carrier: UncheckedAccount<'info>,

    // must equal this deployment's configured USDC mint (see constants.rs)
    // — without this, nothing stops a shipper from funding an escrow with
    // a worthless SPL token that merely happens to share this program's
    // account layout, silently defeating the "USDC is locked" premise the
    // rest of the app (and the take-rate economics) assumes.
    #[account(address = EXPECTED_USDC_MINT @ ErrorCode::MintMismatch)]
    pub mint: Account<'info, Mint>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = shipper
    )]
    pub shipper_token_account: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = fee_payer,
        associated_token::mint = mint,
        associated_token::authority = booking
    )]
    pub escrow_vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[allow(clippy::too_many_arguments)]
pub fn handle_initialize(
    ctx: Context<Initialize>,
    amount: u64,
    booking_id: u64,
    pickup_lat: i32,
    pickup_lng: i32,
    dropoff_lat: i32,
    dropoff_lng: i32,
    pickup_date: i64,
    dropoff_date: i64,
) -> Result<()> {
    // fail closed: refuses every initialize while EXPECTED_USDC_MINT still
    // equals the placeholder — same deliberate guard as release.rs's
    // treasury check, not a condition expected to trip once deployed with
    // the real mint filled in.
    require_keys_neq!(
        EXPECTED_USDC_MINT,
        EXPECTED_USDC_MINT_PLACEHOLDER,
        ErrorCode::MintNotConfigured
    );

    ctx.accounts.booking.booking_id = booking_id;
    ctx.accounts.booking.amount = amount;
    ctx.accounts.booking.shipper = ctx.accounts.shipper.key();
    ctx.accounts.booking.carrier = ctx.accounts.carrier.key();
    ctx.accounts.booking.mint = ctx.accounts.mint.key();
    ctx.accounts.booking.status = STATUS_OPEN;
    ctx.accounts.booking.bump = ctx.bumps.booking;
    ctx.accounts.booking.pickup_lat = pickup_lat;
    ctx.accounts.booking.pickup_lng = pickup_lng;
    ctx.accounts.booking.dropoff_lat = dropoff_lat;
    ctx.accounts.booking.dropoff_lng = dropoff_lng;
    ctx.accounts.booking.pickup_date = pickup_date;
    ctx.accounts.booking.dropoff_date = dropoff_date;
    ctx.accounts.booking.delivered_at = 0;

    // transfer_checked rather than the deprecated transfer: it asserts the
    // mint and decimals at the token program, so a mismatched token account
    // fails inside the CPI instead of relying solely on this program's own
    // account constraints. Belt and braces — the accounts above are already
    // pinned to EXPECTED_USDC_MINT — and it is the only form Token-2022
    // supports. Decimals come from the mint account already in scope, which
    // carries `address = EXPECTED_USDC_MINT`, so it cannot be substituted.
    let cpi_accounts = TransferChecked {
        from: ctx.accounts.shipper_token_account.to_account_info(),
        mint: ctx.accounts.mint.to_account_info(),
        to: ctx.accounts.escrow_vault.to_account_info(),
        authority: ctx.accounts.shipper.to_account_info(),
    };
    let cpi_ctx = CpiContext::new(anchor_spl::token::ID, cpi_accounts);
    token::transfer_checked(cpi_ctx, amount, ctx.accounts.mint.decimals)?;

    msg!("Booking {} created: {} USDC units locked", booking_id, amount);
    Ok(())
}
