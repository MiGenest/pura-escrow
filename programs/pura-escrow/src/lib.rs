pub mod constants;
pub mod error;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("2eUXsNeT5oCk5Q6NGg6ZXC8Y5Yc3p8DguBBsDzEBiGXt");

#[program]
pub mod pura_escrow {
    use super::*;

    #[allow(clippy::too_many_arguments)]
    pub fn initialize(
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
        crate::instructions::initialize::handle_initialize(
            ctx, amount, booking_id, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng,
            pickup_date, dropoff_date,
        )
    }

    pub fn accept(ctx: Context<Accept>) -> Result<()> {
        crate::instructions::accept::handle_accept(ctx)
    }

    pub fn mark_delivered(ctx: Context<MarkDelivered>) -> Result<()> {
        crate::instructions::mark_delivered::handle_mark_delivered(ctx)
    }

    pub fn release(ctx: Context<Release>, booking_id: u64) -> Result<()> {
        crate::instructions::release::handle_release(ctx)
    }

    pub fn cancel(ctx: Context<Cancel>, booking_id: u64) -> Result<()> {
        crate::instructions::cancel::handle_cancel(ctx)
    }

    pub fn dispute(ctx: Context<Dispute>) -> Result<()> {
        crate::instructions::dispute::handle_dispute(ctx)
    }

    pub fn resolve_dispute(
        ctx: Context<ResolveDispute>,
        booking_id: u64,
        carrier_bps: u16,
    ) -> Result<()> {
        crate::instructions::resolve_dispute::handle_resolve_dispute(ctx, carrier_bps)
    }
}
