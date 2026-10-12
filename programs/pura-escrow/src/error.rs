use anchor_lang::prelude::*;

#[error_code]
pub enum ErrorCode {
    #[msg("Only the counter authority can update this counter")]
    Unauthorized,
    #[msg("Counter has reached the maximum value")]
    CounterOverflow,
    #[msg("Booking has already been claimed by a carrier")]
    AlreadyClaimed,
    #[msg("Booking must be Open (unclaimed) for this action")]
    NotOpen,
    #[msg("Platform treasury is not configured — PLATFORM_TREASURY in constants.rs is still the placeholder value")]
    TreasuryNotConfigured,
    #[msg("Fee calculation overflowed or produced an invalid split")]
    InvalidFeeSplit,
    #[msg("A claimed booking can only be cancelled through dispute(), not cancel() — cancel() is shipper-only, unclaimed-only")]
    CannotCancelClaimed,
    #[msg("Booking must be in Accepted status for this action")]
    NotAccepted,
    #[msg("Booking must be in Delivered status for this action")]
    NotDelivered,
    #[msg("Booking must be Accepted or Delivered to be released")]
    NotReleasable,
    #[msg("Booking must be Accepted or Delivered to be disputed")]
    NotDisputable,
    #[msg("Booking must be in Disputed status to be resolved")]
    NotDisputed,
    #[msg("Only the shipper or the carrier on this booking can do this")]
    NotShipperOrCarrier,
    #[msg("The shipper's review window hasn't elapsed yet — only the shipper can release before then")]
    ReviewWindowNotElapsed,
    #[msg("carrier_bps must be between 0 and 10000")]
    InvalidResolutionSplit,
    #[msg("Dispute arbitrator is not configured — ARBITRATOR in constants.rs is still the placeholder value")]
    ArbitratorNotConfigured,
    #[msg("Expected USDC mint is not configured — EXPECTED_USDC_MINT in constants.rs is still the placeholder value")]
    MintNotConfigured,
    #[msg("Token mint does not match this deployment's configured USDC mint")]
    MintMismatch,
    #[msg("fee_payer must be this deployment's configured sponsoring wallet — it receives the rent it originally paid")]
    InvalidFeePayer,
    #[msg("Shipper cannot accept their own booking")]
    SelfAccept,
    #[msg("Two distinct accounts were supplied with the same address")]
    DuplicateAccount,
}
