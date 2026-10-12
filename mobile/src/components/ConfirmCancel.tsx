import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { SheetError } from './SheetError';
import { fmt$, usdc } from '@/lib/format';
import { colors, radius, semantic, space, type } from '@/lib/theme';

/**
 * Cancel confirmation — same shell as ConfirmAccept, two deliberate
 * divergences from the web client's ConfirmSheet.
 *
 * 1. THE REFUND AMOUNT IS SHOWN. Web says only "You'll get your escrowed
 *    funds back immediately", with no figure. On a phone the card behind
 *    this sheet is already covered, so the number the shipper is deciding
 *    about is not on screen anywhere — naming it is what makes this a
 *    decision rather than a guess. It is also the strongest defence against
 *    cancelling the wrong load out of four similar ones.
 *
 * 2. NO TAP-OUTSIDE-TO-DISMISS. Web's ConfirmSheet closes on an overlay
 *    click, a desktop convention that on a phone means a stray thumb on the
 *    dimmed area silently discards the step. The backdrop here is an inert
 *    View, not a Pressable, so the only ways out are the explicit Keep
 *    listing control and the hardware back button (onRequestClose, which
 *    Android users expect). Matches ConfirmAccept, which made the same call.
 *
 * The truncated PDA is shown for the same reason ConfirmAccept shows it:
 * price and route alone do not separate two similar loads, and three of the
 * four open devnet bookings are Tbilisi → Batumi.
 */
export function ConfirmCancel({
  visible,
  amountRaw,
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
  from: string;
  to: string;
  pda: string;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const refund = usdc(amountRaw);
  const shortPda = `${pda.slice(0, 4)}…${pda.slice(-4)}`;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onCancel}>
      {/* Inert on purpose — see the divergence note above. */}
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <Text style={styles.title}>Cancel this load?</Text>

          {/* Above the details on purpose — see SheetError. */}
          {error ? <SheetError message={error} /> : null}

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
          <View style={[styles.row, styles.rowLast]}>
            <Text style={styles.label}>You get back</Text>
            <Text style={styles.refund}>{fmt$(refund)}</Text>
          </View>

          {/* Same substance as web's confirm_cancel_message, with the figure
              web omits. No platform fee is deducted on a cancel — cancel.rs
              transfers the vault's full balance back — so this is the whole
              escrowed amount, not a net. */}
          <Text style={styles.note}>
            The full {fmt$(refund)} in escrow returns to your wallet immediately.
            Your listing is removed and carriers can no longer see it.
          </Text>
          <Text style={styles.warn}>This is recorded on-chain and cannot be undone.</Text>

          <Pressable
            style={({ pressed }) => [styles.dangerBtn, (busy || pressed) && styles.pressed]}
            onPress={onConfirm}
            disabled={busy}
          >
            {busy ? (
              <ActivityIndicator color={semantic.textInverse} />
            ) : (
              <Text style={styles.dangerBtnText}>
                {error ? 'Try again' : `Yes, cancel · ${fmt$(refund)}`}
              </Text>
            )}
          </Pressable>
          {/* "Keep listing", not "Cancel" — on a sheet whose confirm action
              is itself called Cancel, a Cancel button is genuinely ambiguous
              about which cancel it means. ConfirmAccept can safely say
              Cancel because nothing else there is called that. */}
          <Pressable onPress={onCancel} disabled={busy}>
            <Text style={styles.keep}>Keep listing</Text>
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
  refund: { fontSize: type.body + 2, fontWeight: '700', color: colors.primaryDeep },
  note: {
    marginTop: space.s16,
    fontSize: type.caption,
    color: semantic.textSecondary,
    lineHeight: 18,
  },
  warn: { marginTop: space.s8, fontSize: type.caption, color: colors.danger },
  dangerBtn: {
    marginTop: space.s20,
    backgroundColor: colors.danger,
    borderRadius: radius.pura20,
    paddingVertical: space.s16,
    alignItems: 'center',
  },
  dangerBtnText: { color: semantic.textInverse, fontSize: type.body, fontWeight: '600' },
  pressed: { opacity: 0.85 },
  keep: {
    marginTop: space.s16,
    textAlign: 'center',
    fontSize: type.label,
    fontWeight: '600',
    color: semantic.textSecondary,
  },
});
