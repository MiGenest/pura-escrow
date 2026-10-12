import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';

import { formatMoney, type Shipment, type ShipmentStatus } from '@/domain/types';
import { colors, radius, semantic, space, type } from '@/lib/theme';

/**
 * Port of solana/app/src/components/ShipmentCard.jsx — the LIVE web card,
 * field for field. Deliberately not the Figma card: re-designing it is a
 * cross-platform task to do for web and mobile together, not a mobile-only
 * divergence. No countdown, no PriceBlock/HeldNotice — none of those exist
 * on web either.
 */

const STATUS_LABEL: Record<ShipmentStatus, string> = {
  open: 'Open',
  accepted: 'Accepted',
  in_transit: 'In transit',
  delivered: 'Delivered',
  released: 'Paid out',
  invoiced: 'Invoiced',
  paid: 'Paid',
  cancelled: 'Cancelled',
  disputed: 'Disputed',
};

const BADGE_COLORS: Record<ShipmentStatus, { bg: string; fg: string }> = {
  // Mirrors the web client's --badge-*-bg / --badge-*-fg pairs. The statuses
  // the escrow never produces (invoiced/paid) still need a colour: the type
  // requires every status to have one.
  open: { bg: colors.primarySoft, fg: '#12414C' },
  accepted: { bg: colors.primaryDark, fg: '#FFFFFF' },
  in_transit: { bg: colors.primaryDark, fg: '#FFFFFF' },
  delivered: { bg: colors.primarySoft, fg: colors.primaryDeep },
  released: { bg: colors.primarySoft, fg: colors.primaryDeep },
  invoiced: { bg: colors.field, fg: colors.textMuted },
  paid: { bg: colors.primarySoft, fg: colors.primaryDeep },
  cancelled: { bg: colors.field, fg: colors.textMuted },
  disputed: { bg: '#F6DCC9', fg: '#8A4A12' },
};

function ContactRow({ label, name, phone }: { label: string; name: string; phone?: string | null }) {
  return (
    <View style={styles.contactRow}>
      <Text style={styles.contactName} numberOfLines={1}>
        {label}: {name}
      </Text>
      {phone ? (
        // stopPropagation equivalent: this Pressable sits above the card's
        // own press target, so tapping the number dials instead of opening
        // the card — same intent as the web card's onClick guard.
        <Pressable onPress={() => void Linking.openURL(`tel:${phone}`)} hitSlop={8}>
          <Text style={styles.contactPhone}>{phone}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function ShipmentCard({
  shipment,
  distance,
  onPress,
}: {
  shipment: Shipment;
  distance?: number;
  onPress?: () => void;
}) {
  // The disputed override the web card applies is now upstream, in the
  // adapter: a disputed mirror flag outranks the on-chain status there, so
  // `shipment.status` already carries the answer.
  const badgeKey = shipment.status;
  const badge = BADGE_COLORS[badgeKey];
  const from = shipment.pickupName?.split(',')[0];
  const to = shipment.dropoffName?.split(',')[0];

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.card, pressed && onPress ? styles.pressed : null]}
    >
      <View style={styles.head}>
        <Text style={styles.price}>{formatMoney(shipment.amount)}</Text>
        <View style={[styles.badge, { backgroundColor: badge.bg }]}>
          <Text style={[styles.badgeText, { color: badge.fg }]}>{STATUS_LABEL[badgeKey]}</Text>
        </View>
      </View>

      <View style={styles.route}>
        <View style={[styles.dot, { backgroundColor: colors.primaryDeep }]} />
        <Text style={styles.place} numberOfLines={1}>
          {from || shipment.pickup?.lat.toFixed(3) || '—'}
        </Text>
        <Text style={styles.arrow}>→</Text>
        <View style={[styles.dot, { backgroundColor: colors.primaryDark }]} />
        <Text style={styles.place} numberOfLines={1}>
          {to || shipment.dropoff?.lat.toFixed(3) || '—'}
        </Text>
      </View>

      <View style={styles.facts}>
        {shipment.weightKg != null && <Text style={styles.fact}>{shipment.weightKg} kg</Text>}
        {shipment.volumeM3 != null && <Text style={styles.fact}>{shipment.volumeM3} m³</Text>}
        {shipment.distanceKm != null && (
          <Text style={styles.fact}>{Math.round(shipment.distanceKm)} km</Text>
        )}
        {shipment.stops ? <Text style={styles.fact}>{shipment.stops} stops</Text> : null}
        {distance !== undefined && <Text style={styles.fact}>{distance.toFixed(0)} km away</Text>}
      </View>

      {/* Presence alone is the gate, exactly as on web: the worker only
          includes contact fields for this booking's shipper or its accepted
          carrier (GET /api/cargo), so there is nothing for the client to
          decide. Rendering whatever arrived is correct. */}
      {shipment.shipper?.label ? (
        <ContactRow label="Shipper" name={shipment.shipper.label} phone={shipment.shipper.phone} />
      ) : null}
      {shipment.pickupContact?.label ? (
        <ContactRow label="Pickup" name={shipment.pickupContact.label} phone={shipment.pickupContact.phone} />
      ) : null}
      {shipment.dropoffContact?.label ? (
        <ContactRow label="Dropoff" name={shipment.dropoffContact.label} phone={shipment.dropoffContact.phone} />
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: semantic.bgSurface,
    borderColor: semantic.borderDefault,
    borderWidth: 1,
    borderRadius: radius.pura20,
    padding: space.s16,
    marginBottom: space.s12,
  },
  pressed: { opacity: 0.9 },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  price: { fontSize: type.title - 4, fontWeight: '700', color: semantic.textPrimary },
  badge: {
    paddingHorizontal: space.s12,
    paddingVertical: space.s4,
    borderRadius: radius.puraPill,
  },
  badgeText: { fontSize: type.footnote, fontWeight: '600' },
  route: { flexDirection: 'row', alignItems: 'center', marginTop: space.s12, gap: space.s8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  place: { flexShrink: 1, fontSize: type.label, color: semantic.textPrimary },
  arrow: { color: semantic.textTertiary, fontSize: type.caption },
  facts: { flexDirection: 'row', flexWrap: 'wrap', gap: space.s12, marginTop: space.s12 },
  fact: { fontSize: type.caption, color: semantic.textSecondary },
  contactRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: space.s12,
    paddingTop: space.s12,
    borderTopWidth: 1,
    borderTopColor: semantic.borderDefault,
    gap: space.s8,
  },
  contactName: { flexShrink: 1, fontSize: type.caption, color: semantic.textSecondary },
  contactPhone: { fontSize: type.caption, fontWeight: '600', color: colors.primaryDeep },
});
