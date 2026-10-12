import { PublicKey } from '@solana/web3.js';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { ConfirmPost } from './ConfirmPost';
import { PlaceField } from './PlaceField';
import { amountUsdcFor, fetchUsdcBalance, postLoad, priceUsdFor, type NewLoad } from '@/lib/book';
import { VEHICLE_TYPES, type VehicleType } from '@/lib/constants';
import { fmt$ } from '@/lib/format';
import { routeBetween, type Place, type RouteInfo } from '@/lib/geo';
import { storeProfile, type Profile, type SigningWallet } from '@/lib/profile';
import { colors, radius, semantic, space, type } from '@/lib/theme';

/**
 * SHIPPER — post a load. The native counterpart of BookView.
 *
 * Same inputs, same pricing formula, same POST /api/cargo body. What is
 * deliberately NOT here, and why:
 *
 *   - the map. BookView is built around one (tap to drop a pin, drag the
 *     sheet). Distance is the only thing the price needs from it, and
 *     lib/geo.ts gets that from OSRM without rendering anything. A map is
 *     worth adding; it is not worth blocking the escrow path on.
 *   - saved routes and mid-route waypoints. Both sit on top of a working
 *     post; neither changes what lands on-chain.
 *
 * Fields the WORKER validates are constrained here rather than typed freely:
 * required_vehicle_type is a picker over its exact allowlist, because
 * anything else is a 400 that would strand an already-locked escrow with no
 * metadata.
 */

const VEHICLE_LABELS: Record<VehicleType, string> = {
  flatbed: 'Flatbed',
  refrigerated: 'Refrigerated',
  curtainside: 'Curtainside',
  tanker: 'Tanker',
};

/** Accepted by dateToUnix, and the same format the web client's <input
 *  type="date"> produces. Anything else is stored as 0 ("not set"), so this
 *  only decides whether to warn. */
const isDateish = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s.trim());

export function BookLoad({
  wallet,
  profile,
  onProfileChange,
}: {
  wallet: SigningWallet;
  profile: Profile;
  onProfileChange: (p: Profile) => void;
}) {
  const [pickup, setPickup] = useState<Place | null>(null);
  const [dropoff, setDropoff] = useState<Place | null>(null);
  const [weight, setWeight] = useState('3000');
  const [volume, setVolume] = useState('12');
  const [description, setDescription] = useState('');
  const [vehicleType, setVehicleType] = useState<VehicleType | null>(null);
  const [pickupDate, setPickupDate] = useState('');
  const [dropoffDate, setDropoffDate] = useState('');
  const [pickupContactName, setPickupContactName] = useState('');
  const [pickupContactPhone, setPickupContactPhone] = useState('');
  const [dropoffContactName, setDropoffContactName] = useState('');
  const [dropoffContactPhone, setDropoffContactPhone] = useState('');
  // Only ever shown when the profile has no phone — see the note by the
  // input itself.
  const [ownPhone, setOwnPhone] = useState(profile.phone ?? '');

  const [route, setRoute] = useState<RouteInfo | null>(null);
  const [routing, setRouting] = useState(false);
  const [balance, setBalance] = useState<number | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ amount: number; metaSynced: boolean } | null>(null);

  const weightKg = Number(weight) || 0;
  const volumeM3 = Number(volume) || 0;

  const loadBalance = useCallback(async () => {
    const value = await fetchUsdcBalance(new PublicKey(wallet.address));
    console.log(`[book] usdc balance: ${value}`);
    setBalance(value);
  }, [wallet.address]);

  useEffect(() => {
    void loadBalance();
  }, [loadBalance]);

  // Distance is a price input, so it is re-fetched whenever either end
  // changes — and cleared first, so a stale price can never be on screen
  // next to a new route.
  useEffect(() => {
    if (!pickup || !dropoff) {
      setRoute(null);
      return;
    }
    let cancelled = false;
    setRoute(null);
    setRouting(true);
    void routeBetween(pickup, dropoff).then((info) => {
      if (cancelled) return;
      console.log(`[book] route: ${info.km.toFixed(1)}km straight=${info.straight}`);
      setRoute(info);
      setRouting(false);
    });
    return () => {
      cancelled = true;
    };
  }, [pickup, dropoff]);

  const priceUsd = useMemo(
    () => (route ? priceUsdFor(route.km, weightKg, volumeM3) : 0),
    [route, weightKg, volumeM3]
  );
  const amountUsdc = amountUsdcFor(priceUsd);

  const contactPhone = (profile.phone ?? ownPhone).trim();
  const ready = !!pickup && !!dropoff && !!route && weightKg > 0 && volumeM3 > 0;

  const reset = () => {
    setPickup(null);
    setDropoff(null);
    setWeight('3000');
    setVolume('12');
    setDescription('');
    setVehicleType(null);
    setPickupDate('');
    setDropoffDate('');
    setPickupContactName('');
    setPickupContactPhone('');
    setDropoffContactName('');
    setDropoffContactPhone('');
    setRoute(null);
    setError(null);
    setDone(null);
  };

  const confirmPost = async () => {
    if (!pickup || !dropoff || !route) return;
    setBusy(true);
    setError(null);
    const load: NewLoad = {
      pickup,
      dropoff,
      weightKg,
      volumeM3,
      description: description.trim(),
      requiredVehicleType: vehicleType,
      pickupDate: pickupDate.trim(),
      dropoffDate: dropoffDate.trim(),
      pickupContactName: pickupContactName.trim(),
      pickupContactPhone: pickupContactPhone.trim(),
      dropoffContactName: dropoffContactName.trim(),
      dropoffContactPhone: dropoffContactPhone.trim(),
      contactName: profile.name ?? '',
      contactPhone,
      distanceKm: route.km,
      priceUsd,
      amountUsdc,
    };
    console.log(`[book] post: start amount=${amountUsdc} contactPhone=${contactPhone ? 'set' : 'EMPTY'}`);
    try {
      const posted = await postLoad(wallet, load);
      console.log(`[book] posted pda=${posted.bookingPda.toBase58()} metaSynced=${posted.metaSynced}`);
      // The phone the shipper just typed is only useful if it survives the
      // next launch — the server never hands it back (see profile.ts).
      if (!profile.phone && contactPhone) {
        const updated = { ...profile, phone: contactPhone };
        await storeProfile(wallet.address, updated);
        onProfileChange(updated);
      }
      setConfirming(false);
      setDone({ amount: amountUsdc, metaSynced: posted.metaSynced });
      void loadBalance();
    } catch (err) {
      console.log('[book] post FAILED', JSON.stringify(err, Object.getOwnPropertyNames(Object(err))));
      setError(err instanceof Error ? err.message : 'Could not post this load.');
    }
    setBusy(false);
  };

  if (done) {
    return (
      <ScrollView contentContainerStyle={styles.doneBlock}>
        <Text style={styles.doneTitle}>Load posted</Text>
        <Text style={styles.doneNote}>
          {fmt$(done.amount)} is held in escrow until you release it on delivery.
        </Text>
        {!done.metaSynced && (
          <Text style={styles.warn}>
            The booking is live on-chain, but its details (route, weight, contacts) did not
            save. Carriers will see it without them.
          </Text>
        )}
        <Pressable style={({ pressed }) => [styles.primaryBtn, pressed && styles.pressed]} onPress={reset}>
          <Text style={styles.primaryBtnText}>Post another</Text>
        </Pressable>
      </ScrollView>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <PlaceField label="Pickup" value={pickup} onChange={setPickup} editable={!busy} />
        <PlaceField label="Destination" value={dropoff} onChange={setDropoff} editable={!busy} />

        <View style={styles.pairRow}>
          <View style={styles.pairItem}>
            <Text style={styles.label}>Weight (kg)</Text>
            <TextInput
              style={styles.input}
              value={weight}
              onChangeText={setWeight}
              keyboardType="number-pad"
              editable={!busy}
            />
          </View>
          <View style={styles.pairItem}>
            <Text style={styles.label}>Volume (m³)</Text>
            <TextInput
              style={styles.input}
              value={volume}
              onChangeText={setVolume}
              keyboardType="number-pad"
              editable={!busy}
            />
          </View>
        </View>

        <Text style={styles.label}>Cargo</Text>
        <TextInput
          style={styles.input}
          value={description}
          onChangeText={setDescription}
          placeholder="What is being shipped"
          placeholderTextColor={colors.textFaint}
          editable={!busy}
          maxLength={280}
        />

        <Text style={styles.label}>Truck needed</Text>
        <View style={styles.chipRow}>
          {VEHICLE_TYPES.map((v) => (
            <Pressable
              key={v}
              disabled={busy}
              onPress={() => setVehicleType(vehicleType === v ? null : v)}
              style={({ pressed }) => [
                styles.chip,
                vehicleType === v && styles.chipActive,
                pressed && styles.pressed,
              ]}
            >
              <Text style={[styles.chipText, vehicleType === v && styles.chipTextActive]}>
                {VEHICLE_LABELS[v]}
              </Text>
            </Pressable>
          ))}
        </View>

        <View style={styles.pairRow}>
          <View style={styles.pairItem}>
            <Text style={styles.label}>Pickup date</Text>
            <TextInput
              style={styles.input}
              value={pickupDate}
              onChangeText={setPickupDate}
              placeholder="YYYY-MM-DD"
              placeholderTextColor={colors.textFaint}
              editable={!busy}
            />
          </View>
          <View style={styles.pairItem}>
            <Text style={styles.label}>Delivery date</Text>
            <TextInput
              style={styles.input}
              value={dropoffDate}
              onChangeText={setDropoffDate}
              placeholder="YYYY-MM-DD"
              placeholderTextColor={colors.textFaint}
              editable={!busy}
            />
          </View>
        </View>
        {[pickupDate, dropoffDate].some((d) => d.trim() && !isDateish(d)) && (
          <Text style={styles.hint}>Dates need to look like 2026-09-30, or they are left unset.</Text>
        )}

        <Text style={styles.section}>Pickup contact</Text>
        <Text style={styles.hint}>
          Optional. The person at the warehouse, if that is not you — a carrier with nobody
          here falls back to your own details.
        </Text>
        <TextInput
          style={[styles.input, styles.spaced]}
          value={pickupContactName}
          onChangeText={setPickupContactName}
          placeholder="Name"
          placeholderTextColor={colors.textFaint}
          editable={!busy}
        />
        <TextInput
          style={[styles.input, styles.spaced]}
          value={pickupContactPhone}
          onChangeText={setPickupContactPhone}
          placeholder="Phone"
          placeholderTextColor={colors.textFaint}
          keyboardType="phone-pad"
          editable={!busy}
        />

        <Text style={styles.section}>Delivery contact</Text>
        <TextInput
          style={[styles.input, styles.spaced]}
          value={dropoffContactName}
          onChangeText={setDropoffContactName}
          placeholder="Name"
          placeholderTextColor={colors.textFaint}
          editable={!busy}
        />
        <TextInput
          style={[styles.input, styles.spaced]}
          value={dropoffContactPhone}
          onChangeText={setDropoffContactPhone}
          placeholder="Phone"
          placeholderTextColor={colors.textFaint}
          keyboardType="phone-pad"
          editable={!busy}
        />

        {/* The account contact travels with every booking as
            cargo.contact_name/contact_phone, and the worker stores those
            INSERT-only — a booking posted without a phone can never be given
            one. The server never returns a phone (by design), so an install
            that onboarded before profiles were stored locally has none to
            pre-fill, and asking here is the only way to avoid posting an
            un-callable load. */}
        {!profile.phone && (
          <>
            <Text style={styles.section}>Your phone</Text>
            <Text style={styles.hint}>
              Carriers see this once they accept your load. It is saved on this device — it
              is not part of the public profile.
            </Text>
            <TextInput
              style={[styles.input, styles.spaced]}
              value={ownPhone}
              onChangeText={setOwnPhone}
              placeholder="Your phone number"
              placeholderTextColor={colors.textFaint}
              keyboardType="phone-pad"
              editable={!busy}
            />
          </>
        )}

        <View style={styles.priceBox}>
          <View style={styles.priceRow}>
            <Text style={styles.priceLabel}>
              {routing
                ? 'Measuring the route…'
                : route
                  ? `${Math.round(route.km)} km${route.straight ? ' direct' : ''}`
                  : 'Pick both ends to price this load'}
            </Text>
            <Text style={styles.price}>{route ? fmt$(amountUsdc) : '—'}</Text>
          </View>
          <Text style={styles.priceNote}>
            Held in escrow until delivery. Balance{' '}
            {balance === null ? 'loading…' : fmt$(balance)}.
          </Text>
        </View>

        {balance === 0 && (
          <Text style={styles.warn}>
            This wallet holds no USDC, so there is nothing to place in escrow yet.
          </Text>
        )}
        {!profile.name && (
          <Text style={styles.warn}>
            Your profile has no name, so carriers will not see who posted this load.
          </Text>
        )}
        {error ? <Text style={styles.error}>{error}</Text> : null}

        <Pressable
          disabled={!ready || busy || balance === 0}
          onPress={() => {
            setError(null);
            setConfirming(true);
          }}
          style={({ pressed }) => [
            styles.primaryBtn,
            (!ready || busy || balance === 0) && styles.btnDisabled,
            pressed && styles.pressed,
          ]}
        >
          <Text style={styles.primaryBtnText}>
            Review{route ? ` · ${fmt$(amountUsdc)}` : ''}
          </Text>
        </Pressable>
      </ScrollView>

      {confirming && pickup && dropoff && (
        <ConfirmPost
          visible
          amountUsdc={amountUsdc}
          from={pickup.short}
          to={dropoff.short}
          km={route?.km ?? null}
          straightLine={route?.straight ?? false}
          balance={balance}
          busy={busy}
          error={error}
          onCancel={() => setConfirming(false)}
          onConfirm={() => void confirmPost()}
        />
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { paddingHorizontal: space.s20, paddingBottom: space.s24 * 2 },
  label: {
    marginTop: space.s16,
    marginBottom: space.s8,
    fontSize: type.label,
    fontWeight: '600',
    color: semantic.textSecondary,
  },
  section: {
    marginTop: space.s24,
    fontSize: type.label,
    fontWeight: '700',
    color: semantic.textPrimary,
  },
  hint: { marginTop: space.s4, fontSize: type.footnote, color: semantic.textTertiary, lineHeight: 17 },
  input: {
    backgroundColor: semantic.bgSubtle,
    borderColor: semantic.borderDefault,
    borderWidth: 1,
    borderRadius: radius.pura12,
    paddingHorizontal: space.s16,
    paddingVertical: space.s12 + 2,
    fontSize: type.body,
    color: semantic.textPrimary,
  },
  spaced: { marginTop: space.s8 },
  pairRow: { flexDirection: 'row', gap: space.s12 },
  pairItem: { flex: 1 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.s8 },
  chip: {
    borderWidth: 1,
    borderColor: semantic.borderDefault,
    backgroundColor: semantic.bgSurface,
    borderRadius: radius.puraPill,
    paddingHorizontal: space.s16,
    paddingVertical: space.s8,
  },
  chipActive: { borderColor: colors.primaryDeep, backgroundColor: colors.primarySoft },
  chipText: { fontSize: type.caption, fontWeight: '600', color: semantic.textSecondary },
  chipTextActive: { color: colors.primaryDeep },
  priceBox: {
    marginTop: space.s24,
    backgroundColor: semantic.bgSurface,
    borderColor: semantic.borderDefault,
    borderWidth: 1,
    borderRadius: radius.pura12,
    padding: space.s16,
  },
  priceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.s12,
  },
  priceLabel: { flex: 1, fontSize: type.label, color: semantic.textSecondary },
  price: { fontSize: type.title - 6, fontWeight: '700', color: colors.primaryDeep },
  priceNote: { marginTop: space.s8, fontSize: type.footnote, color: semantic.textTertiary },
  warn: { marginTop: space.s12, fontSize: type.caption, color: colors.danger, lineHeight: 18 },
  error: { marginTop: space.s12, fontSize: type.caption, color: colors.danger },
  primaryBtn: {
    marginTop: space.s24,
    backgroundColor: semantic.actionPrimary,
    borderRadius: radius.pura20,
    paddingVertical: space.s16,
    alignItems: 'center',
  },
  primaryBtnText: { color: semantic.textInverse, fontSize: type.body, fontWeight: '600' },
  btnDisabled: { opacity: 0.45 },
  pressed: { opacity: 0.85 },
  doneBlock: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: space.s24 },
  doneTitle: { fontSize: type.title, fontWeight: '700', color: semantic.textPrimary },
  doneNote: {
    marginTop: space.s12,
    fontSize: type.subtitle,
    color: semantic.textSecondary,
    textAlign: 'center',
  },
});
