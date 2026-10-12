import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { SheetError } from './SheetError';
import { fmt$ } from '@/lib/format';
import { colors, radius, semantic, space, type } from '@/lib/theme';

/**
 * Confirmation before posting a load — the same divergence from the web
 * client that ConfirmAccept already made, for a stronger reason.
 *
 * BookView fires submit() straight from its CTA. Its only guards are the
 * price printed on the button and an "amount held" line above it. But this
 * action moves the shipper's own USDC into escrow: accepting a load commits
 * a carrier's time, posting one commits their money. A mis-tap here is worse
 * than a mis-tap there, and phones invite mis-taps.
 *
 * The route and the amount are both shown because the amount is DERIVED from
 * the route (distance x rate x load factor) — a wrong destination is the
 * likeliest cause of a surprising price, and it should be visible in the
 * same glance as the number.
 */
export function ConfirmPost({
  visible,
  amountUsdc,
  from,
  to,
  km,
  straightLine,
  balance,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  visible: boolean;
  amountUsdc: number;
  from: string;
  to: string;
  km: number | null;
  /** true when the distance is the straight-line fallback rather than a road
   *  route — it feeds the price, so it is disclosed rather than hidden. */
  straightLine: boolean;
  balance: number | null;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const remaining = balance === null ? null : balance - amountUsdc;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onCancel}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <Text style={styles.title}>Post this load?</Text>

          {/* Above the details on purpose — see SheetError. */}
          {error ? <SheetError message={error} /> : null}

          <View style={styles.row}>
            <Text style={styles.label}>Route</Text>
            <Text style={styles.value} numberOfLines={1}>
              {from} → {to}
            </Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>Distance</Text>
            <Text style={styles.value}>
              {km === null ? '—' : `${Math.round(km)} km`}
              {straightLine ? ' (direct)' : ''}
            </Text>
          </View>
          <View style={[styles.row, remaining === null && styles.rowLast]}>
            <Text style={styles.label}>Held in escrow</Text>
            <Text style={styles.amount}>{fmt$(amountUsdc)}</Text>
          </View>
          {remaining !== null && (
            <View style={[styles.row, styles.rowLast]}>
              <Text style={styles.label}>Left after posting</Text>
              <Text style={styles.value}>{fmt$(Math.max(0, remaining))}</Text>
            </View>
          )}

          <Text style={styles.note}>
            {fmt$(amountUsdc)} leaves your wallet now and is held until you release it on
            delivery. Cancelling the load returns it.
          </Text>
          {straightLine && (
            <Text style={styles.note}>
              Road distance was unavailable, so this price uses the straight-line distance —
              usually shorter than the real drive.
            </Text>
          )}
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
                {error ? 'Try again' : `Post load · ${fmt$(amountUsdc)}`}
              </Text>
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
  amount: { fontSize: type.body + 2, fontWeight: '700', color: colors.primaryDeep },
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
