import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { netAfterPlatformFee } from '@/lib/accept';
import { statusOf, type BookingRow } from '@/lib/chain';
import { fmt$, usdc } from '@/lib/format';
import { formatCountdown, msUntilClaimable } from '@/lib/markDelivered';
import { colors, radius, semantic, space, type } from '@/lib/theme';

/**
 * The My Jobs action row — what a carrier can do to a job they already hold.
 *
 * PURELY PRESENTATIONAL. Every piece of state this renders from is resolved
 * by CarrierHome and passed in, and every action is a callback out. That is
 * deliberate rather than incidental: `armed`, `marking`, `claiming` and
 * `error` are single values keyed by PDA in the parent, NOT per-row flags.
 * Arming row A and then row B un-arms A. If this component owned that state
 * instead, both rows would stay armed at once, and the 4s window would leave
 * a row confirmable after the carrier had visually moved on — which defeats
 * the point of arming an irreversible action that starts a 48h clock.
 *
 * So: no useState here, and none should be added. If this needs state, it
 * belongs in CarrierHome next to the handlers that already own it.
 *
 * Only pure derivations happen locally — statusOf, the fee maths and the
 * countdown are all functions of `row` alone.
 */
export function CarrierJobActions({
  row,
  delivered,
  armed,
  marking,
  claiming,
  error,
  onArm,
  onConfirmMarkDelivered,
  onClaim,
}: {
  row: BookingRow;
  /** Resolved from CarrierHome's optimistic `delivered` set — true once this
   *  session confirmed mark_delivered, so the row does not sit on a stale
   *  status until getProgramAccounts catches up. */
  delivered: boolean;
  armed: boolean;
  marking: boolean;
  claiming: boolean;
  error: string | null;
  onArm: () => void;
  onConfirmMarkDelivered: () => void;
  onClaim: () => void;
}) {
  const st = delivered ? 'delivered' : statusOf(row.account);
  const net = netAfterPlatformFee(Number(row.account.amount));
  const waitMs = msUntilClaimable(row.account.deliveredAt);

  return (
    <View>
      {/* IN TRANSIT — self-attest delivery. Two-stage, no modal. */}
      {st === 'transit' && (
        <>
          <Pressable
            style={({ pressed }) => [
              styles.btn, armed && styles.armedBtn, pressed && styles.pressed,
            ]}
            disabled={marking}
            onPress={() => (armed ? onConfirmMarkDelivered() : onArm())}
          >
            {marking ? (
              <ActivityIndicator color={colors.onPrimary} />
            ) : (
              <Text style={[styles.btnText, armed && styles.armedText]}>
                {armed ? 'Tap again to confirm · starts 48h clock' : 'Mark delivered'}
              </Text>
            )}
          </Pressable>
          {/* Same soft nudge web uses. mark_delivered.rs asks the
              client to REQUIRE a photo; neither client does, and
              mobile has no image picker at all — known gap. */}
          <Text style={styles.nudge}>
            Add a delivery photo first if you can — it helps if this ever gets disputed.
            Photos can&apos;t be added from the app yet.
          </Text>
        </>
      )}

      {/* DELIVERED — wait out the review window, then claim. */}
      {st === 'delivered' && (
        waitMs > 0 ? (
          <Text style={styles.nudge}>
            Waiting for the shipper to confirm. If they don&apos;t, you can claim{' '}
            {fmt$(usdc(net))} yourself in {formatCountdown(waitMs)}.
          </Text>
        ) : (
          <Pressable
            style={({ pressed }) => [styles.btn, pressed && styles.pressed]}
            disabled={claiming}
            onPress={() => onClaim()}
          >
            {claiming ? (
              <ActivityIndicator color={colors.onPrimary} />
            ) : (
              /* NET, not gross: release.rs takes the platform fee on
                 the way through, so the gross figure web's button
                 shows is not what lands in the carrier's wallet. */
              <Text style={styles.btnText}>Claim payment · {fmt$(usdc(net))}</Text>
            )}
          </Pressable>
        )
      )}

      {error && (marking || claiming || armed) ? (
        <Text style={styles.actionError}>{error}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  // Same values as CarrierHome's acceptBtn/acceptText — kept as its own copy
  // rather than exported, so the two buttons can diverge without one silently
  // restyling the other.
  btn: {
    marginTop: -space.s4,
    marginBottom: space.s16,
    backgroundColor: colors.primary,
    borderRadius: radius.pura12,
    paddingVertical: space.s12 + 2,
    alignItems: 'center',
  },
  btnText: { color: colors.onPrimary, fontSize: type.label, fontWeight: '700' },
  // Armed state is a colour change, not a layout change: the button must not
  // move under a thumb that is already travelling toward it.
  armedBtn: { backgroundColor: colors.danger },
  armedText: { color: semantic.textInverse },
  pressed: { opacity: 0.85 },
  nudge: {
    marginTop: -space.s4,
    marginBottom: space.s16,
    fontSize: type.caption,
    color: semantic.textSecondary,
    lineHeight: 18,
  },
  actionError: {
    marginTop: -space.s8,
    marginBottom: space.s16,
    fontSize: type.caption,
    color: colors.danger,
    lineHeight: 18,
  },
});
