import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { fetchCargoHistory, type CargoHistoryRow } from '@/lib/cargo';
import { fmt$, usdc } from '@/lib/format';
import type { SigningWallet } from '@/lib/profile';
import { colors, radius, semantic, space, type } from '@/lib/theme';

/**
 * SHIPPER — History. The D1 half of ShipmentsView.jsx.
 *
 * Nothing here comes from the chain: release()/cancel() close the Booking
 * account, so a finished booking has no on-chain existence at all. These
 * rows are what the acting client recorded at the moment it finished (see
 * recordCargoCompletion), and that is the whole of the record.
 *
 * Consequences that shape this screen:
 *   - No PublicKey, no bigint, no live coordinates. ShipmentCard cannot
 *     render these, so the row below is its own flat thing, same as the
 *     web client's separate history branch.
 *   - No pagination. The worker caps at 100 with no cursor.
 *   - A refused signature is NOT an empty history. See below.
 *
 * DO NOT INFER HISTORY'S CONTENTS FROM LIVE ON-CHAIN BOOKINGS. During this
 * screen's build (2026-09-19) it was asserted that History was empty because
 * every booking with a live on-chain account had `completed_status = null`,
 * and the first cancel was called its "first-ever row". Both were wrong: the
 * first real fetch on a device returned finished bookings.
 *
 * The mistake is structural, not a slip. A row appears here precisely BECAUSE
 * its on-chain account is gone, so checking `getProgramAccounts` results — or
 * GET /api/cargo for those PDAs — samples exactly the set that CANNOT be in
 * History yet. Those were older bookings finished through the web client,
 * invisible to any on-chain query.
 *
 * The only way to know what History holds is to read the route: a signed
 * GET /api/cargo/history, which needs the wallet. Anything else is a guess
 * about a table whose whole purpose is to outlive the chain.
 */

function Row({ row }: { row: CargoHistoryRow }) {
  const cancelled = row.completed_status === 'cancelled';
  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <Text style={styles.price}>{fmt$(usdc(row.completed_amount))}</Text>
        <View style={[styles.badge, cancelled ? styles.badgeCancelled : styles.badgeDone]}>
          <Text style={[styles.badgeText, cancelled ? styles.badgeTextCancelled : styles.badgeTextDone]}>
            {cancelled ? 'Cancelled' : 'Completed'}
          </Text>
        </View>
      </View>

      <View style={styles.route}>
        <View style={[styles.dot, { backgroundColor: colors.primaryDeep }]} />
        <Text style={styles.place} numberOfLines={1}>
          {row.pickup_name?.split(',')[0] || '—'}
        </Text>
        <Text style={styles.arrow}>→</Text>
        <View style={[styles.dot, { backgroundColor: colors.primaryDark }]} />
        <Text style={styles.place} numberOfLines={1}>
          {row.dropoff_name?.split(',')[0] || '—'}
        </Text>
      </View>

      <Text style={styles.when}>
        {new Date(row.completed_at).toLocaleDateString()} ·{' '}
        {row.booking_pda.slice(0, 4)}…{row.booking_pda.slice(-4)}
      </Text>
    </View>
  );
}

export function ShipperHistory({ wallet }: { wallet: SigningWallet }) {
  const [rows, setRows] = useState<CargoHistoryRow[]>([]);
  const [authRequired, setAuthRequired] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const res = await fetchCargoHistory(wallet);
    setRows(res.rows);
    setAuthRequired(res.authRequired);
    setLoading(false);
  }, [wallet]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={colors.primaryDeep} />
        <Text style={styles.muted}>Loading your history…</Text>
      </View>
    );
  }

  // TAKES PRECEDENCE OVER THE EMPTY STATE, exactly as on web. A refused or
  // rejected read signature returns zero rows, which is indistinguishable
  // from a genuinely empty history unless this is said out loud — and
  // "you've completed nothing" is a far worse thing to tell a shipper
  // wrongly than "we couldn't check". The retry re-prompts the wallet.
  if (authRequired) {
    return (
      <View style={styles.centered}>
        <View style={styles.authBox} accessibilityRole="alert">
          <Text style={styles.authHeading}>History needs your signature</Text>
          <Text style={styles.authBody}>
            Your completed shipments are private, so reading them needs a signature from your
            wallet. Nothing was charged and nothing was sent — this only proves the wallet is
            yours.
          </Text>
        </View>
        <Pressable style={styles.retryBtn} onPress={() => { setLoading(true); void load(); }}>
          <Text style={styles.retryText}>Try again</Text>
        </Pressable>
      </View>
    );
  }

  const total = rows.reduce((sum, r) => sum + usdc(r.completed_amount), 0);

  return (
    <FlatList
      data={rows}
      keyExtractor={(r) => r.booking_pda}
      contentContainerStyle={styles.listContent}
      refreshControl={
        <RefreshControl refreshing={false} onRefresh={() => void load()} tintColor={colors.primaryDeep} />
      }
      ListHeaderComponent={
        rows.length ? (
          <View style={styles.stats}>
            <View style={styles.stat}>
              <Text style={styles.statValue}>{fmt$(total)}</Text>
              <Text style={styles.statLabel}>Total spend</Text>
            </View>
            <View style={styles.stat}>
              <Text style={styles.statValue}>{fmt$(total / rows.length)}</Text>
              <Text style={styles.statLabel}>Avg load price</Text>
            </View>
          </View>
        ) : null
      }
      ListEmptyComponent={
        <Text style={styles.muted}>
          No completed shipments yet. A load shows up here once it is delivered and paid, or
          cancelled.
        </Text>
      }
      renderItem={({ item }) => <Row row={item} />}
    />
  );
}

const styles = StyleSheet.create({
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.s24 },
  muted: { marginTop: space.s24, fontSize: type.label, color: semantic.textSecondary, textAlign: 'center', lineHeight: 20 },
  listContent: { paddingHorizontal: space.s20, paddingBottom: space.s24 },
  stats: {
    flexDirection: 'row',
    gap: space.s12,
    marginTop: space.s16,
    marginBottom: space.s8,
  },
  stat: {
    flex: 1,
    backgroundColor: semantic.bgSurface,
    borderColor: semantic.borderDefault,
    borderWidth: 1,
    borderRadius: radius.pura12,
    paddingVertical: space.s12,
    alignItems: 'center',
  },
  statValue: { fontSize: type.body + 2, fontWeight: '700', color: semantic.textPrimary },
  statLabel: { marginTop: space.s4, fontSize: type.footnote, color: semantic.textSecondary },
  card: {
    backgroundColor: semantic.bgSurface,
    borderColor: semantic.borderDefault,
    borderWidth: 1,
    borderRadius: radius.pura20,
    padding: space.s16,
    marginTop: space.s12,
  },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  price: { fontSize: type.title - 4, fontWeight: '700', color: semantic.textPrimary },
  badge: { paddingHorizontal: space.s12, paddingVertical: space.s4, borderRadius: radius.puraPill },
  // Mirrors the web badge pairs: `done` reuses the delivered colours,
  // `cancelled` is the muted neutral, NOT danger — a cancellation the
  // shipper chose is not an error state.
  badgeDone: { backgroundColor: colors.primarySoft },
  badgeCancelled: { backgroundColor: semantic.borderDefault },
  badgeText: { fontSize: type.footnote, fontWeight: '600' },
  badgeTextDone: { color: colors.primaryDeep },
  badgeTextCancelled: { color: semantic.textSecondary },
  route: { flexDirection: 'row', alignItems: 'center', marginTop: space.s12, gap: space.s8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  place: { flexShrink: 1, fontSize: type.label, color: semantic.textPrimary },
  arrow: { color: semantic.textTertiary, fontSize: type.caption },
  when: { marginTop: space.s12, fontSize: type.caption, color: semantic.textTertiary },
  authBox: {
    backgroundColor: semantic.bgSurface,
    borderColor: semantic.borderDefault,
    borderWidth: 1,
    borderRadius: radius.pura12,
    paddingHorizontal: space.s16,
    paddingVertical: space.s16,
  },
  authHeading: { fontSize: type.body, fontWeight: '700', color: semantic.textPrimary },
  authBody: { marginTop: space.s8, fontSize: type.label, color: semantic.textSecondary, lineHeight: 20 },
  retryBtn: {
    marginTop: space.s20,
    backgroundColor: semantic.actionPrimary,
    borderRadius: radius.pura20,
    paddingVertical: space.s12 + 2,
    paddingHorizontal: space.s24,
  },
  retryText: { color: semantic.textInverse, fontSize: type.label, fontWeight: '600' },
});
