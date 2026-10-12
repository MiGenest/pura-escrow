import { Image } from 'expo-image';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { pickDeliveryPhoto, uploadDeliveryPhoto, type PhotoSource } from '@/lib/photo';
import type { SigningWallet } from '@/lib/profile';
import { colors, radius, semantic, space, type } from '@/lib/theme';

/**
 * Proof of delivery — the carrier attaches a photo, the shipper sees it (or a
 * soft warning that none exists) before releasing escrow.
 *
 * NEVER A HARD GATE. Nothing here can block Mark delivered or release, by
 * design — see the long note in lib/photo.ts for why mobile matches web's
 * policy rather than the stricter intent stated in mark_delivered.rs. A failed
 * or absent photo is surfaced, never enforced.
 *
 * Two capture paths where web has one. Web's `<input capture="environment">`
 * prefers the rear camera while still allowing a library pick; iOS has no
 * single control with that behaviour, so Take photo and Choose photo are
 * separate and the carrier picks.
 */
export function DeliveryPhoto({
  bookingPda,
  wallet,
  role,
  photo,
  onUploaded,
}: {
  bookingPda: string;
  /** Required for the carrier path — the upload is signed. Absent for the
   *  shipper, who only ever views. */
  wallet?: SigningWallet;
  role: 'carrier' | 'shipper';
  /** Existing data URL from cargo.delivery_photo, if one was already attached. */
  photo?: string | null;
  onUploaded?: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Shown immediately on a successful upload so the carrier sees their own
  // photo without waiting for a cargo-meta refetch to bring it back.
  const [justUploaded, setJustUploaded] = useState<string | null>(null);

  const shown = justUploaded ?? photo ?? null;

  const attach = useCallback(async (source: PhotoSource) => {
    if (!wallet) return;
    setBusy(true);
    setError(null);
    try {
      const dataUrl = await pickDeliveryPhoto(source);
      if (!dataUrl) { setBusy(false); return; }   // cancelled — not an error
      const res = await uploadDeliveryPhoto(wallet, bookingPda, dataUrl);
      if (res.ok) {
        setJustUploaded(dataUrl);
        if (onUploaded) await onUploaded();
      } else {
        setError(res.error);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not attach that photo.');
    }
    setBusy(false);
  }, [wallet, bookingPda, onUploaded]);

  if (role === 'shipper') {
    return shown ? (
      <View style={styles.row}>
        <Image source={{ uri: shown }} style={styles.thumb} contentFit="cover" />
        <Text style={styles.note}>Delivery photo</Text>
      </View>
    ) : (
      <Text style={styles.note}>No delivery photo was attached to this load.</Text>
    );
  }

  return (
    <View style={styles.wrap}>
      {shown ? <Image source={{ uri: shown }} style={styles.thumb} contentFit="cover" /> : null}
      <View style={styles.btnRow}>
        <Pressable
          style={({ pressed }) => [styles.btn, pressed && styles.pressed]}
          disabled={busy}
          onPress={() => void attach('camera')}
        >
          {busy ? (
            <ActivityIndicator color={colors.primaryDeep} />
          ) : (
            <Text style={styles.btnText}>{shown ? 'Retake' : 'Take photo'}</Text>
          )}
        </Pressable>
        <Pressable
          style={({ pressed }) => [styles.btn, pressed && styles.pressed]}
          disabled={busy}
          onPress={() => void attach('library')}
        >
          <Text style={styles.btnText}>Choose photo</Text>
        </Pressable>
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: -space.s4, marginBottom: space.s16, gap: space.s8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.s12, marginBottom: space.s12 },
  btnRow: { flexDirection: 'row', gap: space.s8 },
  // Outlined, not filled: attaching a photo is optional and must not compete
  // with Mark delivered for attention. Same reasoning as cancel's outline.
  btn: {
    flex: 1,
    borderWidth: 1.5,
    borderColor: semantic.borderDefault,
    borderRadius: radius.pura12,
    paddingVertical: space.s12,
    alignItems: 'center',
  },
  btnText: { color: colors.primaryDeep, fontSize: type.label, fontWeight: '600' },
  pressed: { opacity: 0.85 },
  thumb: {
    width: 72,
    height: 72,
    borderRadius: radius.pura12,
    backgroundColor: semantic.bgSubtle,
  },
  note: { flexShrink: 1, fontSize: type.caption, color: semantic.textSecondary, lineHeight: 18 },
  error: { fontSize: type.caption, color: colors.danger, lineHeight: 18 },
});
