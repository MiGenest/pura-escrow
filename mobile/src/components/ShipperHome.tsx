import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BookLoad } from './BookLoad';
import { ShipperHistory } from './ShipperHistory';
import { ShipperTracking } from './ShipperTracking';
import type { Profile, SigningWallet } from '@/lib/profile';
import { CLUSTER, programIdShort } from '@/lib/solana';
import { colors, radius, semantic, space, type } from '@/lib/theme';

/**
 * SHIPPER — main view.
 *
 * Tabs mirror SHIPPER_TABS in solana/app/src/constants.js exactly: Book /
 * Tracking / History / Profile.
 *
 * Tracking and History are NOT the same data source, which is why they are
 * two tabs rather than a filter: tracking reads live Booking accounts off the
 * chain, while history can only be reconstructed from D1 (GET
 * /api/cargo/history), because release() and cancel() close the account
 * outright and leave no terminal state on-chain to read. They are separate
 * components for the same reason — almost nothing is shared between them
 * but the tab bar.
 *
 * Each mounts fresh when its tab is selected and fetches on mount, rather
 * than being kept alive and refreshed centrally. That is deliberate for
 * History: its read costs a wallet signature, so a mount is the user
 * actually asking for it, not a background effect firing on a screen they
 * are not looking at.
 */

type TabId = 'book' | 'tracking' | 'history' | 'profile';

const TABS: { id: TabId; label: string }[] = [
  { id: 'book', label: 'Book' },
  { id: 'tracking', label: 'Tracking' },
  { id: 'history', label: 'History' },
  { id: 'profile', label: 'Profile' },
];

export function ShipperHome({
  wallet,
  profile,
  onProfileChange,
  onSignOut,
}: {
  wallet: SigningWallet;
  profile: Profile;
  onProfileChange: (p: Profile) => void;
  onSignOut: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [tab, setTab] = useState<TabId>('book');

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>
          {tab === 'book' ? 'Post a load' : TABS.find((t) => t.id === tab)?.label}
        </Text>
      </View>

      {tab === 'book' ? (
        <BookLoad wallet={wallet} profile={profile} onProfileChange={onProfileChange} />
      ) : tab === 'profile' ? (
        <View style={styles.centered}>
          <Text style={styles.profileRole}>
            Shipper{profile.name ? ` · ${profile.name}` : ''}
          </Text>
          <Text style={styles.muted}>
            {wallet.address.slice(0, 4)}…{wallet.address.slice(-4)}
          </Text>
          <Pressable style={styles.retryBtn} onPress={onSignOut}>
            <Text style={styles.retryText}>Sign out</Text>
          </Pressable>
        </View>
      ) : tab === 'tracking' ? (
        <ShipperTracking wallet={wallet} />
      ) : (
        <ShipperHistory wallet={wallet} />
      )}

      <Text style={styles.footer}>
        {CLUSTER} · program {programIdShort}
      </Text>

      <View style={[styles.tabBar, { paddingBottom: insets.bottom || space.s12 }]}>
        {TABS.map((tb) => (
          <Pressable key={tb.id} style={styles.tab} onPress={() => setTab(tb.id)}>
            <Text style={[styles.tabLabel, tab === tb.id && styles.tabLabelActive]}>
              {tb.label}
            </Text>
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
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.s24 },
  muted: { marginTop: space.s12, fontSize: type.label, color: semantic.textSecondary, textAlign: 'center' },
  profileRole: { fontSize: type.title - 6, fontWeight: '700', color: semantic.textPrimary },
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
});
