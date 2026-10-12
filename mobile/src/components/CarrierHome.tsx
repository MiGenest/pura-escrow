import { PublicKey } from '@solana/web3.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CarrierJobActions } from './CarrierJobActions';
import { ConfirmAccept } from './ConfirmAccept';
import { shipmentFromBooking } from '@/domain/crypto/mapping';

import { ShipmentCard } from './ShipmentCard';
import { acceptBooking } from '@/lib/accept';
import { markDelivered } from '@/lib/markDelivered';
import { releaseBooking } from '@/lib/release';
import { fetchCargoMeta, type CargoMeta } from '@/lib/cargo';
import { fmt$, usdc } from '@/lib/format';
import { fetchCarrierBookings, type BookingRow } from '@/lib/chain';
import type { Profile, SigningWallet } from '@/lib/profile';
import { CLUSTER, connection, programIdShort } from '@/lib/solana';
import { colors, radius, semantic, space, type } from '@/lib/theme';

/**
 * Carrier main view — READ ONLY.
 *
 * Tabs mirror CARRIER_TABS in solana/app/src/constants.js exactly:
 * Loads / Jobs / Earnings / Profile. Loads and Jobs are the same data load
 * split two ways, which is how the web client does it too (one CarrierView
 * with view="nearby" | "mine").
 *
 * Accept is deliberately absent. It needs an Anchor instruction, the
 * fee-payer sponsorship round-trip and wallet.signTransaction — an unproven
 * signing primitive here — so it gets its own audit-and-build pass once
 * list rendering is proven on device.
 */

type TabId = 'loads' | 'jobs' | 'earnings' | 'profile';

const TABS: { id: TabId; label: string }[] = [
  { id: 'loads', label: 'Loads' },
  { id: 'jobs', label: 'Jobs' },
  { id: 'earnings', label: 'Earnings' },
  { id: 'profile', label: 'Profile' },
];

export function CarrierHome({
  wallet,
  profile,
  onSignOut,
}: {
  wallet: SigningWallet;
  profile: Profile;
  onSignOut: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [tab, setTab] = useState<TabId>('loads');
  const [open, setOpen] = useState<BookingRow[]>([]);
  const [mine, setMine] = useState<BookingRow[]>([]);
  const [meta, setMeta] = useState<Record<string, CargoMeta>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // the booking the confirm sheet is open for, if any
  const [pending, setPending] = useState<BookingRow | null>(null);
  const [accepting, setAccepting] = useState(false);
  const [acceptError, setAcceptError] = useState<string | null>(null);

  // Two-stage confirm, deliberately NOT a modal. mark_delivered moves no
  // money, so a full sheet would overstate it — but it is irreversible
  // (mark_delivered.rs requires status == ACCEPTED, so there is no
  // un-deliver) and it starts a 48h clock the carrier cannot stop. Arming
  // the button defeats the mis-tap and names the consequence, at a weight
  // that matches the action. Reverts on its own so a walked-away-from
  // armed button cannot be pressed later by accident.
  const [armedPda, setArmedPda] = useState<string | null>(null);
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [marking, setMarking] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // Optimistic state, same reasoning as ShipperTracking's `settled` set:
  // getProgramAccounts lags behind a confirmed transaction, so the row is
  // moved forward on confirmation rather than on the refetch. `delivered`
  // covers a status mutation, `settled` covers an account close.
  const [delivered, setDelivered] = useState<Set<string>>(new Set());
  const [settled, setSettled] = useState<Set<string>>(new Set());
  const [claiming, setClaiming] = useState<string | null>(null);

  const arm = useCallback((pda: string) => {
    if (armTimer.current) clearTimeout(armTimer.current);
    setActionError(null);
    setArmedPda(pda);
    armTimer.current = setTimeout(() => setArmedPda(null), 4000);
  }, []);

  useEffect(() => () => { if (armTimer.current) clearTimeout(armTimer.current); }, []);

  const load = useCallback(async () => {
    setError(null);
    try {
      const pk = new PublicKey(wallet.address);
      const t0 = Date.now();
      const { mine: m, open: o } = await fetchCarrierBookings(connection, pk);
      console.log(`[chain] getProgramAccounts: open=${o.length} mine=${m.length} in ${Date.now() - t0}ms`);
      setOpen(o);
      setMine(m);
      const pdas = [...o, ...m].map((r) => r.pda.toBase58());
      const md = await fetchCargoMeta(pdas, wallet);
      console.log(`[cargo] meta rows: ${Object.keys(md).length} for ${pdas.length} pdas`);
      setMeta(md);
    } catch (err) {
      console.log('[chain] load FAILED', String(err));
      setError(err instanceof Error ? err.message : 'Could not load bookings.');
    }
    setLoading(false);
  }, [wallet]);

  const confirmAccept = useCallback(async () => {
    if (!pending) return;
    setAccepting(true);
    setAcceptError(null);
    const pda = pending.pda.toBase58();
    console.log(`[accept] start pda=${pda}`);
    try {
      const { signature, metaSynced } = await acceptBooking(wallet, pending.pda);
      console.log(`[accept] ok sig=${signature} metaSynced=${metaSynced}`);
      setPending(null);
      setLoading(true);
      await load(); // re-read the chain so the card moves Loads -> Jobs
    } catch (err) {
      console.log(
        '[accept] FAILED',
        JSON.stringify(err, Object.getOwnPropertyNames(Object(err)))
      );
      setAcceptError(err instanceof Error ? err.message : 'Could not accept this load.');
    }
    setAccepting(false);
  }, [pending, wallet, load]);

  const confirmMarkDelivered = useCallback(async (row: BookingRow) => {
    const pda = row.pda.toBase58();
    if (armTimer.current) clearTimeout(armTimer.current);
    setArmedPda(null);
    setMarking(pda);
    setActionError(null);
    console.log(`[delivered] start pda=${pda}`);
    try {
      const { signature } = await markDelivered(wallet, row.pda);
      console.log(`[delivered] ok sig=${signature}`);
      // Confirmation, not the refetch, moves the card forward.
      setDelivered((prev) => new Set(prev).add(pda));
      await load();
    } catch (err) {
      console.log('[delivered] FAILED', JSON.stringify(err, Object.getOwnPropertyNames(Object(err))));
      setActionError(err instanceof Error ? err.message : 'Could not mark this delivered.');
    }
    setMarking(null);
  }, [wallet, load]);

  const claimPayment = useCallback(async (row: BookingRow) => {
    const pda = row.pda.toBase58();
    setClaiming(pda);
    setActionError(null);
    console.log(`[release] carrier self-release start pda=${pda}`);
    try {
      // Same instruction the shipper's release uses — releaseBooking derives
      // `authority` from the signing wallet, so it is authority-agnostic and
      // needs no carrier-specific variant. release.rs decides which party is
      // allowed, and the pre-flight simulate surfaces ReviewWindowNotElapsed
      // if the countdown below was optimistic about the cluster clock.
      const { signature, recorded } = await releaseBooking({
        wallet,
        bookingPda: row.pda,
        bookingId: row.account.bookingId,
        shipper: row.account.shipper,
        carrier: row.account.carrier,
        amountRaw: row.account.amount,
      });
      console.log(`[release] carrier ok sig=${signature} recorded=${recorded}`);
      setSettled((prev) => new Set(prev).add(pda));
      await load();
    } catch (err) {
      console.log('[release] carrier FAILED', JSON.stringify(err, Object.getOwnPropertyNames(Object(err))));
      setActionError(err instanceof Error ? err.message : 'Could not claim this payment.');
    }
    setClaiming(null);
  }, [wallet, load]);

  useEffect(() => {
    void load();
  }, [load]);

  // A self-released job's account is closed, so it should leave the list the
  // moment the chain confirms rather than whenever getProgramAccounts catches up.
  const list = (tab === 'loads' ? open : mine).filter((r) => !settled.has(r.pda.toBase58()));

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>
          {tab === 'loads' ? 'Open loads' : tab === 'jobs' ? 'My jobs' : TABS.find((x) => x.id === tab)?.label}
        </Text>
        {(tab === 'loads' || tab === 'jobs') && (
          <Text style={styles.headerCount}>{list.length}</Text>
        )}
      </View>

      {tab === 'loads' || tab === 'jobs' ? (
        loading ? (
          <View style={styles.centered}>
            <ActivityIndicator color={colors.primaryDeep} />
            <Text style={styles.muted}>Reading the chain…</Text>
          </View>
        ) : error ? (
          <View style={styles.centered}>
            <Text style={styles.errorText}>{error}</Text>
            <Pressable style={styles.retryBtn} onPress={() => { setLoading(true); void load(); }}>
              <Text style={styles.retryText}>Try again</Text>
            </Pressable>
          </View>
        ) : (
          <FlatList
            data={list}
            keyExtractor={(r) => r.pda.toBase58()}
            contentContainerStyle={styles.listContent}
            refreshControl={
              <RefreshControl refreshing={false} onRefresh={() => void load()} tintColor={colors.primaryDeep} />
            }
            ListEmptyComponent={
              <Text style={styles.muted}>
                {tab === 'loads' ? 'No open loads right now.' : 'No jobs accepted yet.'}
              </Text>
            }
            renderItem={({ item }) => {
              const pda = item.pda.toBase58();
              return (
                <View>
                  <ShipmentCard shipment={shipmentFromBooking(item, meta[pda])} />

                  {tab === 'loads' && (
                    <Pressable
                      style={({ pressed }) => [styles.acceptBtn, pressed && styles.pressed]}
                      onPress={() => { setAcceptError(null); setPending(item); }}
                    >
                      <Text style={styles.acceptText}>
                        Accept · {fmt$(usdc(item.account.amount))}
                      </Text>
                    </Pressable>
                  )}

                  {/* Every flag below is resolved HERE, not in the child: these
                      are single values keyed by PDA, so only one row is ever
                      armed / marking / claiming at a time. See the note at the
                      top of CarrierJobActions. */}
                  {tab === 'jobs' && (
                    <CarrierJobActions
                      row={item}
                      delivered={delivered.has(pda)}
                      armed={armedPda === pda}
                      marking={marking === pda}
                      claiming={claiming === pda}
                      error={actionError}
                      onArm={() => arm(pda)}
                      onConfirmMarkDelivered={() => void confirmMarkDelivered(item)}
                      onClaim={() => void claimPayment(item)}
                    />
                  )}
                </View>
              );
            }}
          />
        )
      ) : tab === 'earnings' ? (
        <View style={styles.centered}>
          <Text style={styles.muted}>Earnings is not built yet.</Text>
        </View>
      ) : (
        <View style={styles.centered}>
          <Text style={styles.profileRole}>
            {profile.role === 'carrier' ? 'Carrier' : 'Shipper'}
            {profile.name ? ` · ${profile.name}` : ''}
          </Text>
          <Text style={styles.muted}>
            {wallet.address.slice(0, 4)}…{wallet.address.slice(-4)}
          </Text>
          {/* Sign-out lives here, matching the web client's Profile tab. This
              replaces the temporary buttons screens 1 and 2 carried. */}
          <Pressable style={styles.retryBtn} onPress={onSignOut}>
            <Text style={styles.retryText}>Sign out</Text>
          </Pressable>
        </View>
      )}

      <Text style={styles.footer}>
        {CLUSTER} · program {programIdShort}
      </Text>

      {pending && (
        <ConfirmAccept
          visible
          amountRaw={pending.account.amount}
          from={meta[pending.pda.toBase58()]?.pickup_name?.split(',')[0] || 'Pickup'}
          to={meta[pending.pda.toBase58()]?.dropoff_name?.split(',')[0] || 'Dropoff'}
          pda={pending.pda.toBase58()}
          busy={accepting}
          error={acceptError}
          onCancel={() => setPending(null)}
          onConfirm={() => void confirmAccept()}
        />
      )}

      <View style={[styles.tabBar, { paddingBottom: insets.bottom || space.s12 }]}>
        {TABS.map((tb) => (
          <Pressable key={tb.id} style={styles.tab} onPress={() => setTab(tb.id)}>
            <Text style={[styles.tabLabel, tab === tb.id && styles.tabLabelActive]}>{tb.label}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: semantic.bgCanvas },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.s20,
    paddingVertical: space.s16,
  },
  headerTitle: { fontSize: type.title - 4, fontWeight: '700', color: semantic.textPrimary },
  headerCount: { fontSize: type.subtitle, color: semantic.textTertiary },
  listContent: { paddingHorizontal: space.s20, paddingBottom: space.s24 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.s24 },
  muted: { marginTop: space.s12, fontSize: type.label, color: semantic.textSecondary, textAlign: 'center' },
  profileRole: { fontSize: type.title - 6, fontWeight: '700', color: semantic.textPrimary },
  errorText: { fontSize: type.label, color: colors.danger, textAlign: 'center' },
  retryBtn: {
    marginTop: space.s20,
    backgroundColor: semantic.actionPrimary,
    borderRadius: radius.pura20,
    paddingVertical: space.s12 + 2,
    paddingHorizontal: space.s24,
  },
  retryText: { color: semantic.textInverse, fontSize: type.label, fontWeight: '600' },
  footer: {
    textAlign: 'center',
    color: semantic.textTertiary,
    fontSize: type.footnote,
    paddingVertical: space.s8,
  },
  tabBar: {
    flexDirection: 'row',
    borderTopWidth: 1,
    borderTopColor: semantic.borderDefault,
    backgroundColor: semantic.bgSurface,
    paddingTop: space.s12,
  },
  tab: { flex: 1, alignItems: 'center' },
  tabLabel: { fontSize: type.caption, color: semantic.textTertiary, fontWeight: '600' },
  tabLabelActive: { color: colors.primaryDeep },
  acceptBtn: {
    marginTop: -space.s4,
    marginBottom: space.s16,
    backgroundColor: colors.primary,
    borderRadius: radius.pura12,
    paddingVertical: space.s12 + 2,
    alignItems: 'center',
  },
  acceptText: { color: colors.onPrimary, fontSize: type.label, fontWeight: '700' },
  pressed: { opacity: 0.85 },
});
