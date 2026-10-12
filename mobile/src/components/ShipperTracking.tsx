import { PublicKey } from '@solana/web3.js';
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

import { ConfirmCancel } from './ConfirmCancel';
import { ConfirmRelease } from './ConfirmRelease';
import { DeliveryPhoto } from './DeliveryPhoto';
import { shipmentFromBooking } from '@/domain/crypto/mapping';

import { ShipmentCard } from './ShipmentCard';
import { netAfterPlatformFee } from '@/lib/accept';
import { cancelBooking } from '@/lib/cancel';
import { releaseBooking } from '@/lib/release';
import { fetchCargoMeta, type CargoMeta } from '@/lib/cargo';
import { fetchShipperBookings, statusOf, type BookingRow } from '@/lib/chain';
import { fmt$, usdc } from '@/lib/format';
import type { SigningWallet } from '@/lib/profile';
import { connection } from '@/lib/solana';
import { colors, radius, semantic, space, type } from '@/lib/theme';

/**
 * SHIPPER — Tracking. The live half of ShipmentsView.jsx.
 *
 * Two groups from one chain read, exactly as the web client renders them:
 * In transit (anything past Open) then Awaiting carrier (still Open). A
 * FlatList with a flattened, tagged array rather than two lists, so the
 * whole screen scrolls and pull-to-refresh covers both — the same reason
 * CarrierHome uses one list per tab.
 *
 * CANCEL IS OFFERED ON THE `waiting` GROUP ONLY. cancel.rs refuses a
 * claimed booking outright (CannotCancelClaimed, verified against devnet),
 * so a Cancel button on an In-transit card would be a button that always
 * fails. The web client makes the same call, with a comment at
 * ShipmentsView.jsx:409 saying so. Unwinding a claimed booking needs
 * dispute(), which is out of scope for this screen.
 */

type Group = 'transit' | 'waiting';
type Item = { kind: 'header'; group: Group; count: number } | { kind: 'row'; group: Group; row: BookingRow };

export function ShipperTracking({ wallet }: { wallet: SigningWallet }) {
  const [transit, setTransit] = useState<BookingRow[]>([]);
  const [waiting, setWaiting] = useState<BookingRow[]>([]);
  const [meta, setMeta] = useState<Record<string, CargoMeta>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // the booking the confirm sheet is open for, if any
  const [pending, setPending] = useState<BookingRow | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  // Set when the chain succeeded but the D1 completion write did not. The
  // refund is real and final; what is missing is the History row. Silence
  // here would be a lie by omission — see cargo.ts.
  const [unrecorded, setUnrecorded] = useState<{ pda: string; kind: 'cancelled' | 'released' } | null>(null);

  // the booking the release sheet is open for, if any
  const [releasing, setReleasing] = useState<BookingRow | null>(null);
  const [releaseBusy, setReleaseBusy] = useState(false);
  const [releaseError, setReleaseError] = useState<string | null>(null);

  // PDAs this session has SETTLED — cancelled or released — and confirmed
  // on-chain. Both instructions `close` the Booking account, so both hit the
  // same lag; this was named `cancelled` when cancel was the only one.
  //
  // WHY THIS EXISTS. `await load()` straight after confirmTransaction()
  // assumes getProgramAccounts is caught up, and on devnet 2026-09-19 it was
  // not: the cancel confirmed, the refund landed, and the next TWO reads
  // still returned the closed booking (`waiting=4`, then `waiting=4`, then
  // finally `waiting=3`). Both reads genuinely re-fetched — `meta rows: 5
  // for 5 pdas` — so this is RPC lag at `confirmed`, not a render cache.
  //
  // The user-facing effect is the worst possible one: the card they were
  // just told was irreversibly cancelled sits there as if nothing happened,
  // inviting a second tap. (That second tap is safe — the pre-flight
  // simulate fails on a closed account — but it should never be invited.)
  //
  // So confirmation, not the refetch, is what removes the card. The refetch
  // still runs and still reconciles everything else; this only suppresses
  // rows the chain has already told us are gone.
  //
  // THE WEB CLIENT LIKELY HAS THIS SAME BUG, UNFIXED. ShipmentsView.jsx ends
  // both release() and cancel() with `setSelected(null); await fetchAll()` —
  // the identical confirm-then-refetch shape with no optimistic removal. It
  // has not been reproduced there (desktop RPC timing may differ, and nobody
  // has looked), so it is a likely shared bug, not a confirmed one. Written
  // up in docs/RISK-REGISTER.md §2, "Read-after-write: a confirmed cancel
  // still renders" — read that before touching web's cancel flow.
  const [settled, setSettled] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setError(null);
    try {
      const pk = new PublicKey(wallet.address);
      const t0 = Date.now();
      const { transit: t, waiting: w } = await fetchShipperBookings(connection, pk);
      console.log(`[chain] shipper bookings: transit=${t.length} waiting=${w.length} in ${Date.now() - t0}ms`);
      setTransit(t);
      setWaiting(w);
      const pdas = [...t, ...w].map((r) => r.pda.toBase58());
      const md = await fetchCargoMeta(pdas, wallet);
      console.log(`[cargo] meta rows: ${Object.keys(md).length} for ${pdas.length} pdas`);
      setMeta(md);
    } catch (err) {
      console.log('[chain] shipper load FAILED', String(err));
      setError(err instanceof Error ? err.message : 'Could not load your shipments.');
    }
    setLoading(false);
  }, [wallet]);

  useEffect(() => {
    void load();
  }, [load]);

  const confirmCancel = useCallback(async () => {
    if (!pending) return;
    setCancelling(true);
    setCancelError(null);
    const pda = pending.pda.toBase58();
    console.log(`[cancel] start pda=${pda} $${usdc(pending.account.amount)}`);
    try {
      const { signature, recorded } = await cancelBooking(
        wallet,
        pending.pda,
        pending.account.bookingId,
        pending.account.amount
      );
      console.log(`[cancel] ok sig=${signature} recorded=${recorded}`);
      // Before the refetch, not after: this is what actually removes the
      // card, and it must be true the instant the sheet closes.
      setSettled((prev) => new Set(prev).add(pda));
      setPending(null);
      // The refund happened either way; only History is affected.
      setUnrecorded(recorded ? null : { pda, kind: 'cancelled' });
      await load(); // reconcile everything else; may still lag on this pda
    } catch (err) {
      console.log('[cancel] FAILED', JSON.stringify(err, Object.getOwnPropertyNames(Object(err))));
      setCancelError(err instanceof Error ? err.message : 'Could not cancel this load.');
    }
    setCancelling(false);
  }, [pending, wallet, load]);

  const confirmRelease = useCallback(async () => {
    if (!releasing) return;
    setReleaseBusy(true);
    setReleaseError(null);
    const pda = releasing.pda.toBase58();
    console.log(`[release] start pda=${pda} $${usdc(releasing.account.amount)}`);
    try {
      const { signature, recorded, createdCarrierAta } = await releaseBooking({
        wallet,
        bookingPda: releasing.pda,
        bookingId: releasing.account.bookingId,
        shipper: releasing.account.shipper,
        carrier: releasing.account.carrier,
        amountRaw: releasing.account.amount,
      });
      console.log(`[release] ok sig=${signature} recorded=${recorded} ataCreated=${createdCarrierAta}`);
      // Same ordering as cancel, for the same reason: release() closes the
      // account, so getProgramAccounts lags here too. Confirmation removes
      // the card; the refetch only reconciles.
      setSettled((prev) => new Set(prev).add(pda));
      setReleasing(null);
      setUnrecorded(recorded ? null : { pda, kind: 'released' });
      await load();
    } catch (err) {
      console.log('[release] FAILED', JSON.stringify(err, Object.getOwnPropertyNames(Object(err))));
      setReleaseError(err instanceof Error ? err.message : 'Could not release this payment.');
    }
    setReleaseBusy(false);
  }, [releasing, wallet, load]);

  // Applied to BOTH groups, not just `waiting`. A cancelled booking can only
  // ever have been Open, so it should never appear in `transit` — but if a
  // lagging read ever did put it there, hiding it in one group and showing
  // it in the other is worse than either alone.
  const visibleTransit = transit.filter((r) => !settled.has(r.pda.toBase58()));
  const visibleWaiting = waiting.filter((r) => !settled.has(r.pda.toBase58()));

  // One flat array so a single FlatList renders both groups with their
  // headings; headers are omitted for an empty group rather than left
  // hanging over nothing, matching the web's `{transit.length > 0 && …}`.
  // Counts come off the filtered lists so the heading can never disagree
  // with the rows under it.
  const items: Item[] = [
    ...(visibleTransit.length ? ([{ kind: 'header', group: 'transit', count: visibleTransit.length }] as Item[]) : []),
    ...visibleTransit.map((row): Item => ({ kind: 'row', group: 'transit', row })),
    ...(visibleWaiting.length ? ([{ kind: 'header', group: 'waiting', count: visibleWaiting.length }] as Item[]) : []),
    ...visibleWaiting.map((row): Item => ({ kind: 'row', group: 'waiting', row })),
  ];

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={colors.primaryDeep} />
        <Text style={styles.muted}>Reading the chain…</Text>
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorText}>{error}</Text>
        <Pressable style={styles.retryBtn} onPress={() => { setLoading(true); void load(); }}>
          <Text style={styles.retryText}>Try again</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <>
      <FlatList
        data={items}
        keyExtractor={(it) => (it.kind === 'header' ? `h:${it.group}` : it.row.pda.toBase58())}
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl refreshing={false} onRefresh={() => void load()} tintColor={colors.primaryDeep} />
        }
        ListHeaderComponent={
          unrecorded ? (
            <View style={styles.warnBox} accessibilityRole="alert">
              <Text style={styles.warnHeading}>
                {unrecorded.kind === 'released' ? 'Paid, but not recorded' : 'Cancelled, but not recorded'}
              </Text>
              <Text style={styles.warnBody}>
                {unrecorded.kind === 'released'
                  ? 'The carrier has been paid and the booking is closed on-chain. We could not write it to your history, so this one will be missing from the History tab.'
                  : 'The refund went through and the listing is gone. We could not write it to your history, so this one will be missing from the History tab.'}
              </Text>
              <Text style={styles.warnMono}>
                {unrecorded.pda.slice(0, 4)}…{unrecorded.pda.slice(-4)}
              </Text>
            </View>
          ) : null
        }
        ListEmptyComponent={<Text style={styles.muted}>Nothing active right now.</Text>}
        renderItem={({ item }) =>
          item.kind === 'header' ? (
            <Text style={styles.groupLabel}>
              {item.group === 'transit' ? 'In transit' : 'Awaiting carrier'} · {item.count}
            </Text>
          ) : (
            <View>
              <ShipmentCard shipment={shipmentFromBooking(item.row, meta[item.row.pda.toBase58()])} />
              {item.group === 'waiting' && (
                <Pressable
                  style={({ pressed }) => [styles.cancelBtn, pressed && styles.pressed]}
                  onPress={() => { setCancelError(null); setPending(item.row); }}
                >
                  <Text style={styles.cancelText}>
                    Cancel listing · {fmt$(usdc(item.row.account.amount))} back
                  </Text>
                </Pressable>
              )}
              {/* Release is the `transit` group's action, and Cancel is the
                  `waiting` group's — never both on one card. That is not a
                  layout choice: cancel.rs refuses a claimed booking and
                  release.rs refuses an unclaimed one (NotReleasable), so each
                  button is only ever shown where the chain would accept it.
                  A disputed booking is excluded too — dispute() freezes both
                  instructions until resolve_dispute() runs, and neither that
                  nor the dispute UI exists on mobile yet. */}
              {/* Proof of delivery, ABOVE the payout button — mirrors
                  ShipmentsView.jsx:400, where the shipper sees the photo (or
                  the warning that none exists) immediately before the control
                  that releases escrow. That ordering is the point of it being
                  here. Read-only: no wallet is passed, so the component renders
                  its shipper branch and cannot upload. Same gate as the button
                  below — web shows it on transit|delivered but not disputed,
                  which on this screen is the transit group minus disputed. */}
              {item.group === 'transit' && statusOf(item.row.account) !== 'disputed' && (
                <DeliveryPhoto
                  bookingPda={item.row.pda.toBase58()}
                  role="shipper"
                  photo={meta[item.row.pda.toBase58()]?.delivery_photo}
                />
              )}
              {item.group === 'transit' && statusOf(item.row.account) !== 'disputed' && (
                <Pressable
                  style={({ pressed }) => [styles.releaseBtn, pressed && styles.pressed]}
                  onPress={() => { setReleaseError(null); setReleasing(item.row); }}
                >
                  <Text style={styles.releaseText}>
                    Release payment · {fmt$(usdc(netAfterPlatformFee(Number(item.row.account.amount))))} to carrier
                  </Text>
                </Pressable>
              )}
            </View>
          )
        }
      />

      {releasing && (
        <ConfirmRelease
          visible
          amountRaw={releasing.account.amount}
          delivered={statusOf(releasing.account) === 'delivered'}
          from={meta[releasing.pda.toBase58()]?.pickup_name?.split(',')[0] || 'Pickup'}
          to={meta[releasing.pda.toBase58()]?.dropoff_name?.split(',')[0] || 'Dropoff'}
          pda={releasing.pda.toBase58()}
          busy={releaseBusy}
          error={releaseError}
          onCancel={() => setReleasing(null)}
          onConfirm={() => void confirmRelease()}
        />
      )}

      {pending && (
        <ConfirmCancel
          visible
          amountRaw={pending.account.amount}
          from={meta[pending.pda.toBase58()]?.pickup_name?.split(',')[0] || 'Pickup'}
          to={meta[pending.pda.toBase58()]?.dropoff_name?.split(',')[0] || 'Dropoff'}
          pda={pending.pda.toBase58()}
          busy={cancelling}
          error={cancelError}
          onCancel={() => setPending(null)}
          onConfirm={() => void confirmCancel()}
        />
      )}
    </>
  );
}

const styles = StyleSheet.create({
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.s24 },
  muted: { marginTop: space.s12, fontSize: type.label, color: semantic.textSecondary, textAlign: 'center' },
  errorText: { fontSize: type.label, color: colors.danger, textAlign: 'center' },
  listContent: { paddingHorizontal: space.s20, paddingBottom: space.s24 },
  groupLabel: {
    marginTop: space.s16,
    marginBottom: space.s8,
    fontSize: type.caption,
    fontWeight: '700',
    color: semantic.textTertiary,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  // Secondary, not a filled danger button: on web this is `className="secondary"`,
  // and a red-filled button per card would make a list of open listings read
  // as a list of problems. The sheet is where the weight belongs.
  cancelBtn: {
    marginTop: -space.s4,
    marginBottom: space.s16,
    borderWidth: 1.5,
    borderColor: semantic.borderDanger,
    borderRadius: radius.pura20,
    paddingVertical: space.s12,
    alignItems: 'center',
  },
  cancelText: { color: colors.danger, fontSize: type.label, fontWeight: '600' },
  // Filled primary, unlike cancel's outline: this is the expected, wanted
  // end of a booking, and the one action on this screen a shipper is
  // actively looking for once a load lands. Cancel stays quieter.
  releaseBtn: {
    marginTop: -space.s4,
    marginBottom: space.s16,
    backgroundColor: semantic.actionPrimary,
    borderRadius: radius.pura20,
    paddingVertical: space.s12 + 2,
    alignItems: 'center',
  },
  releaseText: { color: semantic.textInverse, fontSize: type.label, fontWeight: '600' },
  pressed: { opacity: 0.85 },
  retryBtn: {
    marginTop: space.s20,
    backgroundColor: semantic.actionPrimary,
    borderRadius: radius.pura20,
    paddingVertical: space.s12 + 2,
    paddingHorizontal: space.s24,
  },
  retryText: { color: semantic.textInverse, fontSize: type.label, fontWeight: '600' },
  warnBox: {
    marginTop: space.s16,
    backgroundColor: semantic.bgDanger,
    borderColor: semantic.borderDanger,
    borderWidth: 1.5,
    borderRadius: radius.pura12,
    paddingHorizontal: space.s16,
    paddingVertical: space.s12 + 2,
  },
  warnHeading: { fontSize: type.body, fontWeight: '700', color: semantic.textDanger },
  warnBody: { marginTop: space.s4, fontSize: type.label, color: semantic.textDanger, lineHeight: 20 },
  warnMono: { marginTop: space.s8, fontSize: type.caption, fontWeight: '600', color: semantic.textDanger },
});
