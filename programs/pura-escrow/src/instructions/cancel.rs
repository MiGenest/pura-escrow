use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, CloseAccount, Mint, Token, TokenAccount, TransferChecked},
};

use crate::constants::{EXPECTED_FEE_PAYER, EXPECTED_USDC_MINT, STATUS_OPEN};
use crate::error::ErrorCode;
use crate::state::Booking;

#[derive(Accounts)]
#[instruction(booking_id: u64)]
pub struct Cancel<'info> {
    pub shipper: Signer<'info>,

    #[account(
        mut,
        seeds = [b"booking", shipper.key().as_ref(), &booking_id.to_le_bytes()],
        bump = booking.bump,
        has_one = shipper,
        // Shipper-initiated cancel only works on a still-open, unclaimed
        // booking. Once a carrier has accepted, this instruction refuses
        // outright (booking.carrier != default fails this the moment
        // status leaves Open, since accept() is the only thing that sets
        // it) — a claimed booking can only be unwound through
        // dispute()/resolve_dispute(), which the carrier has a say in.
        // Previously this only checked status == 0, with no carrier
        // check at all: a shipper could cancel — and get a full refund —
        // at any point after a carrier had already accepted and was
        // mid-delivery. That was the single worst finding in this
        // program's review; this constraint is the fix.
        constraint = booking.status == STATUS_OPEN @ ErrorCode::CannotCancelClaimed,
        // Without this, cancel() refunded the shipper and closed the vault
        // but left the Booking PDA alive at status Open with carrier still
        // default — so a cancelled load kept appearing in getProgramAccounts
        // as an open, claimable listing. A carrier could accept() it (both
        // of accept.rs's gates still passed), haul the freight, and then
        // release() would fail forever because the escrow vault it reads no
        // longer exists: work done, payment impossible. Closing the account
        // is what makes cancellation terminal — accept() cannot deserialize
        // an account that no longer exists. See POST-REWRITE-REVIEW.md PR-3.
        //
        // Destination is fee_payer, not shipper, because fee_payer is who
        // paid this rent in initialize.rs (`payer = fee_payer`); this
        // matches release.rs and resolve_dispute.rs, which already close to
        // the same account.
        close = fee_payer,
    )]
    pub booking: Account<'info, Booking>,

    // receives both the booking PDA's rent (`close` above) and the vault
    // ATA's rent (explicit close_account CPI in the handler) — see
    // initialize.rs's fee_payer doc comment.
    //
    // Pinned to EXPECTED_FEE_PAYER: `Signer` alone let the shipper sign
    // their own cancel() as fee_payer and pocket the rent the platform
    // actually paid. See constants.rs and POST-REWRITE-REVIEW.md PR-4.
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
        associated_token::authority = shipper
    )]
    pub shipper_token_account: Account<'info, TokenAccount>,

    // Needed by transfer_checked, which asserts mint + decimals inside the
    // token program. Pinned to EXPECTED_USDC_MINT rather than accepting
    // whatever the caller passes — otherwise the "checked" transfer would be
    // checked against a caller-chosen mint, which is no check at all.
    //
    // Declared AFTER the token accounts and BEFORE the programs on purpose:
    // worker/index.js's validateInstructions() destructures this instruction's
    // accounts positionally (indices 0 and 2 for `cancel`), so appending here
    // leaves every index it reads untouched.
    #[account(address = EXPECTED_USDC_MINT @ ErrorCode::MintMismatch)]
    pub mint: Account<'info, Mint>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handle_cancel(ctx: Context<Cancel>) -> Result<()> {
    let amount = ctx.accounts.booking.amount;
    let booking_id = ctx.accounts.booking.booking_id;
    let shipper_key = ctx.accounts.booking.shipper;
    let bump = ctx.accounts.booking.bump;

    let id_bytes = booking_id.to_le_bytes();
    let seeds: &[&[u8]] = &[b"booking", shipper_key.as_ref(), &id_bytes, &[bump]];
    let signer_seeds = &[seeds];

    // transfer_checked: mint + decimals asserted by the token program itself
    // (see initialize.rs for the full rationale).
    let cpi_accounts = TransferChecked {
        from: ctx.accounts.escrow_vault.to_account_info(),
        mint: ctx.accounts.mint.to_account_info(),
        to: ctx.accounts.shipper_token_account.to_account_info(),
        authority: ctx.accounts.booking.to_account_info(),
    };
    let cpi_ctx = CpiContext::new_with_signer(
        anchor_spl::token::ID,
        cpi_accounts,
        signer_seeds,
    );
    token::transfer_checked(cpi_ctx, amount, ctx.accounts.mint.decimals)?;

    // see release.rs's matching comment: reclaim the now-empty vault's
    // rent instead of leaving it stranded.
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

    msg!("Booking {} cancelled: {} USDC units refunded to shipper", booking_id, amount);
    Ok(())
}
