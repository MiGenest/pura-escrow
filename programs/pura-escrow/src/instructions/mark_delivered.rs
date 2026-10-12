use anchor_lang::prelude::*;

use crate::constants::{STATUS_ACCEPTED, STATUS_DELIVERED};
use crate::error::ErrorCode;
use crate::state::Booking;

// Carrier self-attests delivery on-chain. This program has no oracle for
// "did the cargo actually arrive" — GPS/photo proof lives off-chain (D1's
// cargo.delivery_photo, uploaded via the client's DeliveryPhoto component)
// and stays advisory there. What's on-chain is just a timestamp that
// starts the shipper's REVIEW_WINDOW_SECS clock (see release.rs): the
// shipper can release or dispute any time after this call, and if they do
// neither, the carrier can self-release once the window elapses. The
// client should require a delivery photo be attached before it lets a
// carrier call this — that's a UX gate, not an on-chain one, same
// division of labor as everywhere else proof-of-delivery already works
// in this app.
#[derive(Accounts)]
pub struct MarkDelivered<'info> {
    pub carrier: Signer<'info>,

    #[account(
        mut,
        has_one = carrier @ ErrorCode::NotShipperOrCarrier,
        constraint = booking.status == STATUS_ACCEPTED @ ErrorCode::NotAccepted,
    )]
    pub booking: Account<'info, Booking>,
}

pub fn handle_mark_delivered(ctx: Context<MarkDelivered>) -> Result<()> {
    ctx.accounts.booking.status = STATUS_DELIVERED;
    ctx.accounts.booking.delivered_at = Clock::get()?.unix_timestamp;
    msg!("Booking {} marked delivered by carrier", ctx.accounts.booking.booking_id);
    Ok(())
}
