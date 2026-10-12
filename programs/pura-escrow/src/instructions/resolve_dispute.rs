use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, CloseAccount, Mint, Token, TokenAccount, TransferChecked},
};

use crate::constants::{
    ARBITRATOR, ARBITRATOR_PLACEHOLDER, BPS_DENOMINATOR, EXPECTED_FEE_PAYER, EXPECTED_USDC_MINT, PLATFORM_FEE_BPS,
    PLATFORM_TREASURY, PLATFORM_TREASURY_PLACEHOLDER, STATUS_DISPUTED,
};
use crate::error::ErrorCode;
use crate::state::Booking;

// Splits a disputed booking's escrowed funds between carrier and shipper
// by `carrier_bps` (0 = full refund to shipper, same outcome as cancel();
// 10000 = full payout to carrier, same split as release(); anything in
// between is a partial-delivery-style split). The platform's take-rate
// applies only to the slice actually awarded to the carrier — a full
// refund (carrier_bps = 0) takes zero platform fee, since nothing was
// successfully brokered in that outcome.
#[derive(Accounts)]
#[instruction(booking_id: u64, carrier_bps: u16)]
pub struct ResolveDispute<'info> {
    // the arbitrator — the only key that can split a disputed escrow,
    // checked against constants.rs's ARBITRATOR in the handler below; see
    // that constant's comment for the custody caveat that comes with it
    // being a single keypair today.
    pub arbitrator: Signer<'info>,

    /// CHECK: only used to derive/validate the booking PDA's seeds below.
    pub shipper: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [b"booking", shipper.key().as_ref(), &booking_id.to_le_bytes()],
        bump = booking.bump,
        has_one = shipper,
        constraint = booking.status == STATUS_DISPUTED @ ErrorCode::NotDisputed,
        close = fee_payer,
    )]
    pub booking: Box<Account<'info, Booking>>,

    // receives the Booking PDA's rent (`close` above) and the escrow
    // vault ATA's rent (explicit close_account CPI in the handler) — the
    // same account that paid both in initialize().
    //
    // Pinned to EXPECTED_FEE_PAYER: `Signer` alone let any signer occupy
    // this account and collect rent the platform actually paid. See
    // constants.rs and POST-REWRITE-REVIEW.md PR-4.
    #[account(mut, address = EXPECTED_FEE_PAYER @ ErrorCode::InvalidFeePayer)]
    pub fee_payer: Signer<'info>,

    #[account(
        mut,
        associated_token::mint = booking.mint,
        associated_token::authority = booking
    )]
    pub escrow_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        associated_token::mint = booking.mint,
        associated_token::authority = shipper
    )]
    pub shipper_token_account: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        associated_token::mint = booking.mint,
        associated_token::authority = carrier,
        // THE pair that could actually collide: identical ATAs when
        // shipper == carrier. accept.rs now forbids that, so this is
        // belt-and-braces — asserted here so a future change to accept()
        // cannot silently reopen the duplicate-mutable-account shape.
        constraint = carrier_token_account.key() != shipper_token_account.key() @ ErrorCode::DuplicateAccount,
        constraint = carrier_token_account.key() != escrow_vault.key() @ ErrorCode::DuplicateAccount,
    )]
    pub carrier_token_account: Box<Account<'info, TokenAccount>>,

    /// CHECK: carrier receives its awarded share, no data read
    #[account(address = booking.carrier)]
    pub carrier: UncheckedAccount<'info>,

    #[account(
        mut,
        associated_token::mint = booking.mint,
        associated_token::authority = PLATFORM_TREASURY,
        constraint = treasury_token_account.key() != carrier_token_account.key() @ ErrorCode::DuplicateAccount,
        constraint = treasury_token_account.key() != shipper_token_account.key() @ ErrorCode::DuplicateAccount,
        constraint = treasury_token_account.key() != escrow_vault.key() @ ErrorCode::DuplicateAccount,
    )]
    pub treasury_token_account: Box<Account<'info, TokenAccount>>,

    // transfer_checked needs the mint; pinned to EXPECTED_USDC_MINT. Declared
    // after the token accounts and before the programs so the worker's
    // positional destructuring (indices 0,3,6,7) is unaffected.
    #[account(address = EXPECTED_USDC_MINT @ ErrorCode::MintMismatch)]
    pub mint: Box<Account<'info, Mint>>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handle_resolve_dispute(ctx: Context<ResolveDispute>, carrier_bps: u16) -> Result<()> {
    require_keys_neq!(ARBITRATOR, ARBITRATOR_PLACEHOLDER, ErrorCode::ArbitratorNotConfigured);
    require_keys_eq!(ctx.accounts.arbitrator.key(), ARBITRATOR, ErrorCode::Unauthorized);
    require_keys_neq!(
        PLATFORM_TREASURY,
        PLATFORM_TREASURY_PLACEHOLDER,
        ErrorCode::TreasuryNotConfigured
    );
    require!(carrier_bps as u64 <= BPS_DENOMINATOR, ErrorCode::InvalidResolutionSplit);

    let amount = ctx.accounts.booking.amount;
    let booking_id = ctx.accounts.booking.booking_id;
    let shipper_key = ctx.accounts.booking.shipper;
    let bump = ctx.accounts.booking.bump;

    let carrier_gross = amount
        .checked_mul(carrier_bps as u64)
        .and_then(|v| v.checked_div(BPS_DENOMINATOR))
        .ok_or(ErrorCode::InvalidFeeSplit)?;
    let fee_amount = carrier_gross
        .checked_mul(PLATFORM_FEE_BPS)
        .and_then(|v| v.checked_div(BPS_DENOMINATOR))
        .ok_or(ErrorCode::InvalidFeeSplit)?;
    let carrier_net = carrier_gross
        .checked_sub(fee_amount)
        .ok_or(ErrorCode::InvalidFeeSplit)?;
    let shipper_amount = amount
        .checked_sub(carrier_gross)
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
        token::transfer_checked(
            CpiContext::new_with_signer(anchor_spl::token::ID, fee_cpi_accounts, signer_seeds),
            fee_amount,
            ctx.accounts.mint.decimals,
        )?;
    }

    if carrier_net > 0 {
        let carrier_cpi_accounts = TransferChecked {
            from: ctx.accounts.escrow_vault.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            to: ctx.accounts.carrier_token_account.to_account_info(),
            authority: ctx.accounts.booking.to_account_info(),
        };
        token::transfer_checked(
            CpiContext::new_with_signer(anchor_spl::token::ID, carrier_cpi_accounts, signer_seeds),
            carrier_net,
            ctx.accounts.mint.decimals,
        )?;
    }

    if shipper_amount > 0 {
        let shipper_cpi_accounts = TransferChecked {
            from: ctx.accounts.escrow_vault.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            to: ctx.accounts.shipper_token_account.to_account_info(),
            authority: ctx.accounts.booking.to_account_info(),
        };
        token::transfer_checked(
            CpiContext::new_with_signer(anchor_spl::token::ID, shipper_cpi_accounts, signer_seeds),
            shipper_amount,
            ctx.accounts.mint.decimals,
        )?;
    }

    // vault's entire balance was just distributed across up to three
    // transfers above (fee + carrier_net + shipper_amount == amount) —
    // reclaim its now-empty rent same as release()/cancel() do.
    let close_cpi_accounts = CloseAccount {
        account: ctx.accounts.escrow_vault.to_account_info(),
        destination: ctx.accounts.fee_payer.to_account_info(),
        authority: ctx.accounts.booking.to_account_info(),
    };
    token::close_account(CpiContext::new_with_signer(
        anchor_spl::token::ID,
        close_cpi_accounts,
        signer_seeds,
    ))?;

    msg!(
        "Booking {} dispute resolved: {} bps to carrier ({} net + {} fee), {} to shipper",
        booking_id, carrier_bps, carrier_net, fee_amount, shipper_amount
    );
    Ok(())
}
