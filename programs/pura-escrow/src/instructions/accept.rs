use anchor_lang::prelude::*;

use crate::constants::{STATUS_ACCEPTED, STATUS_OPEN};
use crate::error::ErrorCode;
use crate::state::Booking;

#[derive(Accounts)]
pub struct Accept<'info> {
    pub carrier: Signer<'info>,

    #[account(
        mut,
        constraint = booking.carrier == Pubkey::default() @ ErrorCode::AlreadyClaimed,
        constraint = booking.status == STATUS_OPEN @ ErrorCode::NotOpen,
        // A shipper accepting their own booking made shipper == carrier, which
        // in turn made shipper_token_account and carrier_token_account the
        // same ATA in release()/resolve_dispute() — two mutable accounts of
        // the same type sharing one address. No loss path was found (every
        // movement is a token-program CPI that re-reads state, and
        // fee + carrier_net + shipper_amount == amount either way), but it is
        // the classic duplicate-mutable-account shape and is better made
        // unreachable than reasoned about. Self-dealing also let one wallet
        // manufacture volume at the cost of the take-rate.
        constraint = carrier.key() != booking.shipper @ ErrorCode::SelfAccept,
    )]
    pub booking: Account<'info, Booking>,
}

pub fn handle_accept(ctx: Context<Accept>) -> Result<()> {
    ctx.accounts.booking.carrier = ctx.accounts.carrier.key();
    ctx.accounts.booking.status = STATUS_ACCEPTED;
    msg!("Booking {} accepted by carrier", ctx.accounts.booking.booking_id);
    Ok(())
}
