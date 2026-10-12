use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, CloseAccount, Mint, Token, TokenAccount, TransferChecked},
};

use crate::constants::{
    BPS_DENOMINATOR, EXPECTED_FEE_PAYER, EXPECTED_USDC_MINT, PLATFORM_FEE_BPS, PLATFORM_TREASURY,
    PLATFORM_TREASURY_PLACEHOLDER, REVIEW_WINDOW_SECS, STATUS_ACCEPTED, STATUS_DELIVERED,
};
use crate::error::ErrorCode;
use crate::state::Booking;

#[derive(Accounts)]
#[instruction(booking_id: u64)]
pub struct Release<'info> {
    // whoever is authorizing this release: booking.shipper (any time once
    // Accepted — it's their own money, an early release isn't a security
    // issue) or booking.carrier (only once Delivered and
    // REVIEW_WINDOW_SECS has elapsed since mark_delivered — see the
    // handler). Which one is valid depends on booking.status/delivered_at,
    // not knowable until the handler runs, so this isn't constrained to a
    // specific key here.
    pub authority: Signer<'info>,

    /// CHECK: only used to derive/validate the booking PDA's seeds below;
    /// not read otherwise.
    pub shipper: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [b"booking", shipper.key().as_ref(), &booking_id.to_le_bytes()],
        bump = booking.bump,
        has_one = shipper,
        close = fee_payer,
    )]
    pub booking: Account<'info, Booking>,

    // receives both the booking PDA's rent (via `close` above) and the
    // escrow vault ATA's rent (via the explicit close_account CPI in the
    // handler) — the same account that paid both in initialize(). See
    // initialize.rs's fee_payer doc comment for why this replaced the
    // previous shipper-top-up design.
    //
    // Pinned to EXPECTED_FEE_PAYER: `Signer` alone let ANY signer occupy
    // this account and collect rent the platform actually paid. See
    // constants.rs and POST-REWRITE-REVIEW.md PR-4.
    #[account(mut, address = EXPECTED_FEE_PAYER @ ErrorCode::InvalidFeePayer)]
    pub fee_payer: Signer<'info>,

    #[account(
        mut,
        associated_token::mint = booking.mint,
        associated_token::authority = booking
    )]
    pub escrow_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = booking.mint,
        associated_token::authority = carrier,
        // belt-and-braces duplicate-mutable-account guard: accept.rs now
        // forbids shipper == carrier, so these cannot collide via that route.
        // Asserted here anyway because a future change to accept()'s
        // constraints must not silently reopen it.
        constraint = carrier_token_account.key() != escrow_vault.key() @ ErrorCode::DuplicateAccount,
    )]
    pub carrier_token_account: Account<'info, TokenAccount>,

    /// CHECK: carrier receives payment, no data read
    #[account(address = booking.carrier)]
    pub carrier: UncheckedAccount<'info>,

    // platform's take-rate destination. `associated_token::authority =
    // PLATFORM_TREASURY` means this MUST be the ATA for the hardcoded
    // treasury constant — the caller cannot substitute a different
    // destination, since that constant is compiled into the program, not
    // supplied by any account or instruction argument.
    #[account(
        mut,
        associated_token::mint = booking.mint,
        associated_token::authority = PLATFORM_TREASURY,
        constraint = treasury_token_account.key() != carrier_token_account.key() @ ErrorCode::DuplicateAccount,
        constraint = treasury_token_account.key() != escrow_vault.key() @ ErrorCode::DuplicateAccount,
    )]
    pub treasury_token_account: Account<'info, TokenAccount>,

    // transfer_checked needs the mint. Pinned to EXPECTED_USDC_MINT so the
    // "checked" transfer is not checked against a caller-chosen mint.
    // Declared after the token accounts and before the programs so
    // worker/index.js's positional destructuring (indices 0,3,5,6 for
    // `release`) is unaffected.
    #[account(address = EXPECTED_USDC_MINT @ ErrorCode::MintMismatch)]
    pub mint: Account<'info, Mint>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handle_release(ctx: Context<Release>) -> Result<()> {
    // fail closed: refuses every release while PLATFORM_TREASURY still
    // equals the placeholder generated for this patch (see constants.rs)
    // — this is the deliberate guard against ever sending real funds to a
    // pubkey nobody holds the key for, not a check that's expected to ever
    // actually trigger once deployed correctly.
    require_keys_neq!(
        PLATFORM_TREASURY,
        PLATFORM_TREASURY_PLACEHOLDER,
        ErrorCode::TreasuryNotConfigured
    );

    let status = ctx.accounts.booking.status;
    require!(
        status == STATUS_ACCEPTED || status == STATUS_DELIVERED,
        ErrorCode::NotReleasable
    );

    let authority_key = ctx.accounts.authority.key();
    if authority_key == ctx.accounts.booking.shipper {
        // shipper-authorized release: always allowed once Accepted, no
        // extra gate.
    } else if authority_key == ctx.accounts.booking.carrier {
        require!(status == STATUS_DELIVERED, ErrorCode::NotDelivered);
        let elapsed = Clock::get()?
            .unix_timestamp
            .saturating_sub(ctx.accounts.booking.delivered_at);
        require!(elapsed >= REVIEW_WINDOW_SECS, ErrorCode::ReviewWindowNotElapsed);
    } else {
        return err!(ErrorCode::NotShipperOrCarrier);
    }

    let amount = ctx.accounts.booking.amount;
    let booking_id = ctx.accounts.booking.booking_id;
    let shipper_key = ctx.accounts.booking.shipper;
    let bump = ctx.accounts.booking.bump;

    let fee_amount = amount
        .checked_mul(PLATFORM_FEE_BPS)
        .and_then(|v| v.checked_div(BPS_DENOMINATOR))
        .ok_or(ErrorCode::InvalidFeeSplit)?;
    let carrier_amount = amount
        .checked_sub(fee_amount)
        .ok_or(ErrorCode::InvalidFeeSplit)?;

    let id_bytes = booking_id.to_le_bytes();
    let seeds: &[&[u8]] = &[b"booking", shipper_key.as_ref(), &id_bytes, &[bump]];
    let signer_seeds = &[seeds];

    if fee_amount > 0 {
        let fee_cpi_accounts = TransferChecked {
            from: ctx.accounts.escrow_vault.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            to: ctx.accounts.treasury_token_account.to_account_info(),
            authority: ctx.accounts.booking.to_account_info(),
        };
        let fee_cpi_ctx = CpiContext::new_with_signer(
            anchor_spl::token::ID,
            fee_cpi_accounts,
            signer_seeds,
        );
        token::transfer_checked(fee_cpi_ctx, fee_amount, ctx.accounts.mint.decimals)?;
    }

    let carrier_cpi_accounts = TransferChecked {
        from: ctx.accounts.escrow_vault.to_account_info(),
        mint: ctx.accounts.mint.to_account_info(),
        to: ctx.accounts.carrier_token_account.to_account_info(),
        authority: ctx.accounts.booking.to_account_info(),
    };
    let carrier_cpi_ctx = CpiContext::new_with_signer(
        anchor_spl::token::ID,
        carrier_cpi_accounts,
        signer_seeds,
    );
    token::transfer_checked(carrier_cpi_ctx, carrier_amount, ctx.accounts.mint.decimals)?;

    // vault is empty now (fee_amount + carrier_amount == amount, the
    // vault's entire balance) — reclaim its rent to fee_payer instead of
    // leaving it stranded forever. Anchor's `close = fee_payer` on the
    // booking account above only closes Anchor-native accounts; an SPL
    // TokenAccount needs this explicit CPI, authorized by the same PDA
    // signer seeds used for the transfers above.
    let close_cpi_accounts = CloseAccount {
        account: ctx.accounts.escrow_vault.to_account_info(),
        destination: ctx.accounts.fee_payer.to_account_info(),
        authority: ctx.accounts.booking.to_account_info(),
    };
    let close_cpi_ctx = CpiContext::new_with_signer(
        anchor_spl::token::ID,
        close_cpi_accounts,
        signer_seeds,
    );
    token::close_account(close_cpi_ctx)?;

    msg!(
        "Booking {} released: {} USDC units paid to carrier, {} USDC units platform fee",
        booking_id, carrier_amount, fee_amount
    );
    Ok(())
}
