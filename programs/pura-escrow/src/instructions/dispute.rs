use anchor_lang::prelude::*;

use crate::constants::{STATUS_ACCEPTED, STATUS_DELIVERED, STATUS_DISPUTED};
use crate::error::ErrorCode;
use crate::state::Booking;

// Either party can freeze a booking pending arbitration. No fund movement
// here — this only flips status so release()/cancel() both refuse to run
// (see their STATUS_ACCEPTED/STATUS_DELIVERED/STATUS_OPEN gates) until
// resolve_dispute() runs. The actual dispute reason/evidence stays
// off-chain in D1 (cargo.dispute_reason, POST /api/cargo/dispute) exactly
// as it does today — this instruction doesn't duplicate that. It adds the
// on-chain half: while a booking is disputed, neither release() nor
// cancel() can move the escrow, so a dispute recorded off-chain is also
// binding on-chain until resolve_dispute() settles it — the off-chain
// record says why; this instruction makes it hold. (resolve_dispute.rs
// holds the split.)
#[derive(Accounts)]
pub struct Dispute<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        constraint = (
            authority.key() == booking.shipper || authority.key() == booking.carrier
        ) @ ErrorCode::NotShipperOrCarrier,
        constraint = (
            booking.status == STATUS_ACCEPTED || booking.status == STATUS_DELIVERED
        ) @ ErrorCode::NotDisputable,
    )]
    pub booking: Account<'info, Booking>,
}

pub fn handle_dispute(ctx: Context<Dispute>) -> Result<()> {
    ctx.accounts.booking.status = STATUS_DISPUTED;
    msg!("Booking {} disputed", ctx.accounts.booking.booking_id);
    Ok(())
}
