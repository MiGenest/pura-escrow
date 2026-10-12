use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct Booking {
    pub booking_id: u64,
    pub amount: u64,
    pub shipper: Pubkey,
    pub carrier: Pubkey,
    pub mint: Pubkey,
    // see constants.rs's STATUS_* — Open(0)/Accepted(1)/Delivered(2)/
    // Disputed(3). Released and Cancelled aren't stored: both close this
    // account (see release.rs/cancel.rs), so "the account doesn't exist"
    // is itself the terminal state — same reasoning D1's cargo/history
    // table already relies on (see /api/cargo/complete).
    pub status: u8,
    pub bump: u8,
    pub pickup_lat: i32,
    pub pickup_lng: i32,
    pub dropoff_lat: i32,
    pub dropoff_lng: i32,
    pub pickup_date: i64,
    pub dropoff_date: i64,
    // unix timestamp mark_delivered() was called, 0 until then. Anchors
    // the REVIEW_WINDOW_SECS clock that lets the carrier self-release if
    // the shipper goes silent post-delivery (see release.rs).
    pub delivered_at: i64,
}
