import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { SheetError } from './SheetError';
import { netAfterPlatformFee, PLATFORM_FEE_PCT } from '@/lib/accept';
import { fmt$, usdc } from '@/lib/format';
import { colors, radius, semantic, space, type } from '@/lib/theme';

/**
 * Accept confirmation — a deliberate divergence from the web client, which
 * fires accept() straight from the button with no confirm step.
 *
 * The reasoning: accepting is an irreversible on-chain state change, and a
 * mis-tap is far likelier on a phone than a mis-click on a desktop. Web's
 * ConfirmSheet is React DOM and cannot be reused directly, so this mirrors
 * its shape and reuses the accept_net_note copy rather than inventing new
 * wording.
 *
 * The truncated PDA is shown so the booking being claimed is identifiable
 * before committing — the card itself only shows a price, which is not
 * enough to tell two similar loads apart.
 */
export function ConfirmAccept({
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
  const gross = usdc(amountRaw);
  const net = usdc(netAfterPlatformFee(Number(amountRaw)));
  const shortPda = `${pda.slice(0, 4)}…${pda.slice(-4)}`;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onCancel}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <Text style={styles.title}>Accept this load?</Text>

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
          <View style={styles.row}>
            <Text style={styles.label}>Load pays</Text>
            <Text style={styles.value}>{fmt$(gross)}</Text>
          </View>
          <View style={[styles.row, styles.rowLast]}>
            <Text style={styles.label}>You receive</Text>
            <Text style={styles.net}>{fmt$(net)}</Text>
          </View>

          {/* same substance as web's accept_net_note */}
          <Text style={styles.note}>
            You&apos;ll receive {fmt$(net)} on delivery, after the {PLATFORM_FEE_PCT}% platform fee.
          </Text>
          <Text style={styles.warn}>
            This is recorded on-chain and cannot be undone.
          </Text>

          <Pressable
            style={({ pressed }) => [styles.primaryBtn, (busy || pressed) && styles.pressed]}
            onPress={onConfirm}
            disabled={busy}
          >
            {busy ? (
              <ActivityIndicator color={semantic.textInverse} />
            ) : (
              <Text style={styles.primaryBtnText}>{error ? 'Try again' : 'Accept load'}</Text>
            )}
          </Pressable>
          <Pressable onPress={onCancel} disabled={busy}>
            <Text style={styles.cancel}>Cancel</Text>
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
  cancel: {
    marginTop: space.s16,
    textAlign: 'center',
    fontSize: type.label,
    fontWeight: '600',
    color: semantic.textSecondary,
  },
});
