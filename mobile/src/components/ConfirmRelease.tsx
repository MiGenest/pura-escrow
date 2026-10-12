import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { SheetError } from './SheetError';
import { netAfterPlatformFee, PLATFORM_FEE_PCT } from '@/lib/accept';
import { fmt$, usdc } from '@/lib/format';
import { colors, radius, semantic, space, type } from '@/lib/theme';

/**
 * Release confirmation — a deliberate divergence from the web client, which
 * fires release() straight from the "Confirm delivery" button with no
 * confirm step at all. Same reasoning as ConfirmCancel and ConfirmAccept:
 * real money, phone-sized tap targets, and no undo on-chain.
 *
 * WHAT THIS SHEET MUST GET ACROSS, and web does not:
 *
 * 1. THE CARRIER RECEIVES LESS THAN THE ESCROW. release.rs takes the
 *    platform fee out on the way through, so the shipper's $277 is $263.15
 *    in the carrier's wallet. Web shows only the gross on its button. A
 *    payout screen that quotes a number the recipient will not receive is
 *    misleading even when the total leaving escrow is right, so both are
 *    broken out here.
 *
 * 2. EARLY RELEASE IS A REAL CHOICE, NOT A FORMALITY. The shipper may
 *    release at any time once a carrier has accepted — release.rs allows it
 *    explicitly ("it's their own money, an early release isn't a security
 *    issue"). That means this sheet can be reached BEFORE the carrier has
 *    marked the load delivered, and paying out early forfeits the leverage
 *    the escrow exists to provide. Web draws no distinction; this warns
 *    when `delivered` is false.
 *
 * Backdrop is inert — no tap-outside-dismiss, same call as the other two
 * sheets, so a stray thumb cannot discard the step.
 */
export function ConfirmRelease({
  visible,
  amountRaw,
  delivered,
  from,
  to,
  pda,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  visible: boolean;
  amountRaw: bigint;
  /** status === delivered, i.e. the carrier has called mark_delivered().
   *  False means this is an early release — see the note above. */
  delivered: boolean;
  from: string;
  to: string;
  pda: string;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const gross = usdc(amountRaw);
  const net = usdc(netAfterPlatformFee(Number(amountRaw)));
  const fee = gross - net;
  const shortPda = `${pda.slice(0, 4)}…${pda.slice(-4)}`;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onCancel}>
      {/* Inert on purpose — see the divergence note above. */}
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <Text style={styles.title}>Release payment?</Text>

          {/* Above the details on purpose — see SheetError. */}
          {error ? <SheetError message={error} /> : null}

          {/* Before the numbers, not after: if this is an early release the
              shipper should read that before reading the amount, not once
              their eye has already settled on the button. */}
          {!delivered ? (
            <View style={styles.earlyBox}>
              <Text style={styles.earlyHeading}>The carrier hasn&apos;t marked this delivered</Text>
              <Text style={styles.earlyBody}>
                You can still pay now, but the escrow is what protects you until the load
                arrives. Once released, there is no way to pull it back.
              </Text>
            </View>
          ) : null}

          <View style={styles.row}>
            <Text style={styles.label}>Route</Text>
            <Text style={styles.value} numberOfLines={1}>
              {from} → {to}
            </Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>Booking</Text>
            <Text style={styles.mono}>{shortPda}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>Leaves escrow</Text>
            <Text style={styles.value}>{fmt$(gross)}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>Platform fee ({PLATFORM_FEE_PCT}%)</Text>
            <Text style={styles.value}>−{fmt$(fee)}</Text>
          </View>
          <View style={[styles.row, styles.rowLast]}>
            <Text style={styles.label}>Carrier receives</Text>
            <Text style={styles.net}>{fmt$(net)}</Text>
          </View>

          <Text style={styles.note}>
            {fmt$(net)} goes to the carrier&apos;s wallet and {fmt$(fee)} to the platform. The
            booking is closed on-chain and disappears from Tracking.
          </Text>
          <Text style={styles.warn}>This is recorded on-chain and cannot be undone.</Text>

          <Pressable
            style={({ pressed }) => [styles.primaryBtn, (busy || pressed) && styles.pressed]}
            onPress={onConfirm}
            disabled={busy}
          >
            {busy ? (
              <ActivityIndicator color={semantic.textInverse} />
            ) : (
              <Text style={styles.primaryBtnText}>
                {error ? 'Try again' : `Pay carrier · ${fmt$(net)}`}
              </Text>
            )}
          </Pressable>
          {/* "Not yet", not "Cancel" — on this screen Cancel is a different
              action entirely (it refunds and kills the booking), and on a
              claimed booking it is not even available. Same ambiguity
              ConfirmCancel avoids with "Keep listing". */}
          <Pressable onPress={onCancel} disabled={busy}>
            <Text style={styles.back}>Not yet</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(35,74,84,0.45)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: semantic.bgSurface,
    borderTopLeftRadius: radius.pura20,
    borderTopRightRadius: radius.pura20,
    padding: space.s24,
    paddingBottom: space.s24 + space.s16,
  },
  title: {
    fontSize: type.title - 4,
    fontWeight: '700',
    color: semantic.textPrimary,
    marginBottom: space.s20,
  },
  earlyBox: {
    marginBottom: space.s20,
    backgroundColor: semantic.bgDanger,
    borderColor: semantic.borderDanger,
    borderWidth: 1.5,
    borderRadius: radius.pura12,
    paddingHorizontal: space.s16,
    paddingVertical: space.s12 + 2,
  },
  earlyHeading: { fontSize: type.body, fontWeight: '700', color: semantic.textDanger },
  earlyBody: { marginTop: space.s4, fontSize: type.label, color: semantic.textDanger, lineHeight: 20 },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: space.s12,
    borderBottomWidth: 1,
    borderBottomColor: semantic.borderDefault,
    gap: space.s16,
  },
  rowLast: { borderBottomWidth: 0 },
  label: { fontSize: type.label, color: semantic.textSecondary },
  value: { flexShrink: 1, fontSize: type.label, fontWeight: '600', color: semantic.textPrimary },
  mono: { fontSize: type.caption, fontWeight: '600', color: semantic.textSecondary },
  net: { fontSize: type.body + 2, fontWeight: '700', color: colors.primaryDeep },
  note: {
    marginTop: space.s16,
    fontSize: type.caption,
    color: semantic.textSecondary,
    lineHeight: 18,
  },
  warn: { marginTop: space.s8, fontSize: type.caption, color: colors.danger },
  primaryBtn: {
    marginTop: space.s20,
    backgroundColor: semantic.actionPrimary,
    borderRadius: radius.pura20,
    paddingVertical: space.s16,
    alignItems: 'center',
  },
  primaryBtnText: { color: semantic.textInverse, fontSize: type.body, fontWeight: '600' },
  pressed: { opacity: 0.85 },
  back: {
    marginTop: space.s16,
    textAlign: 'center',
    fontSize: type.label,
    fontWeight: '600',
    color: semantic.textSecondary,
  },
});
