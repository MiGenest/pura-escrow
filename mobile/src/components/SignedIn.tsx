import { useEmbeddedSolanaWallet } from '@privy-io/expo';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from 'react-native';

import {
  fetchProfile,
  loadStoredProfile,
  mergeProfile,
  type Profile,
  type SigningWallet,
} from '@/lib/profile';
import { CLUSTER, programIdShort } from '@/lib/solana';
import { colors, radius, semantic, space, type } from '@/lib/theme';
import { LOGO_SOURCE } from '@/lib/theme';

import { CarrierHome } from './CarrierHome';
import { RoleOnboarding } from './RoleOnboarding';
import { ShipperHome } from './ShipperHome';

/**
 * Everything after a successful login: make sure the user has an embedded
 * Solana wallet, look up their profile, and show screen 2 only if they do
 * not already have a role.
 *
 * Skip-on-re-entry mirrors the web client exactly — App.jsx renders
 * Onboarding only when `!profile`, and its Profile tab shows role in a
 * read-only `role-locked` block. A returning user must never be walked back
 * through a role choice, because the server WOULD accept the overwrite
 * (`role = excluded.role`) even though no product surface offers it.
 */

type Gate =
  | { k: 'wallet' }
  | { k: 'loading' }
  | { k: 'onboard'; wallet: SigningWallet }
  | { k: 'ready'; profile: Profile }
  | { k: 'error'; message: string };

export function SignedIn({ userId, onSignOut }: { userId: string; onSignOut: () => void }) {
  const solana = useEmbeddedSolanaWallet();
  const [gate, setGate] = useState<Gate>({ k: 'wallet' });

  // A profile write needs a wallet to sign with, and a fresh Privy account
  // has none until one is created.
  const wallets = solana.wallets ?? [];
  const address = wallets[0]?.address;
  const hasWallet = wallets.length > 0;
  const createFn = 'create' in solana ? solana.create : undefined;
  // create() must fire at most once per mount: the effect's deps change as
  // Privy's state settles, and a second call races the first.
  const attemptedCreate = useRef(false);

  useEffect(() => {
    // The wallet LIST is the authoritative check, not `status`. Observed on
    // device 2026-09-17: status read 'not-created' while wallets[] was
    // already populated, so create() threw "Solana wallet already exists for
    // this user". Worse than the noise, the catch below used to fail the
    // whole screen for it — the user only escaped that error state because
    // the profile lookup happened to land afterwards and overwrite the gate.
    // On a slower network they would have been stuck on "Something went
    // wrong" with a perfectly good wallet sitting right there.
    if (hasWallet || solana.status !== 'not-created' || !createFn) return;
    if (attemptedCreate.current) return;
    attemptedCreate.current = true;

    console.log('[wallet] creating embedded solana wallet');
    createFn().catch((err: unknown) => {
      const msg = String(err);
      // Benign: another path already made the wallet. It will appear in
      // wallets[] on the next render, so this must not fail the screen.
      if (/already exists/i.test(msg)) {
        console.log('[wallet] create skipped — wallet already exists');
        return;
      }
      console.log('[wallet] create FAILED', msg);
      setGate({ k: 'error', message: 'Could not create your wallet.' });
    });
  }, [hasWallet, solana.status, createFn]);

  // `wallets` is a fresh array on every render, so it must never be a
  // useCallback/useEffect dependency — that gave `load` a new identity each
  // render and re-fired the lookup effect. The device log for 2026-09-17
  // shows the symptom plainly: two `[profile] lookup:` lines for a single
  // sign-in. Read the list through a ref instead and key the effect on the
  // address alone, which is the value that actually changes.
  const walletsRef = useRef(wallets);
  walletsRef.current = wallets;

  const load = useCallback(async () => {
    if (!address) return;
    setGate({ k: 'loading' });
    try {
      const profile = await fetchProfile(address);
      console.log(
        `[profile] lookup: ${profile ? `role=${profile.role}` : 'none'} privyUser=${userId}`
      );
      if (profile?.role) {
        // The server owns role/name/company and never returns a phone, so the
        // locally-held copy is folded back in here — the booking flow writes
        // cargo.contact_phone from it, and the worker stores that field
        // INSERT-only. See mergeProfile.
        const stored = await loadStoredProfile(address);
        const merged = mergeProfile(profile, stored);
        console.log(`[profile] local: ${stored ? `phone=${merged.phone ? 'set' : 'none'}` : 'absent'}`);
        setGate({ k: 'ready', profile: merged });
      } else {
        setGate({ k: 'onboard', wallet: walletsRef.current[0] as unknown as SigningWallet });
      }
    } catch {
      // Deliberately NOT treated as "no profile" — see fetchProfile's note.
      setGate({ k: 'error', message: 'Could not reach the server.' });
    }
  }, [address, userId]);

  useEffect(() => {
    if (address) void load();
  }, [address, load]);

  if (gate.k === 'error') {
    return (
      <Shell>
        <Text style={styles.title}>Something went wrong</Text>
        <Text style={styles.subtitle}>{gate.message}</Text>
        <Pressable style={styles.primaryBtn} onPress={() => void load()}>
          <Text style={styles.primaryBtnText}>Try again</Text>
        </Pressable>
      </Shell>
    );
  }

  if (gate.k === 'wallet' || gate.k === 'loading' || !address) {
    return (
      <Shell>
        <ActivityIndicator color={colors.primaryDeep} />
        <Text style={[styles.subtitle, { marginTop: space.s16 }]}>
          {gate.k === 'loading' ? 'Checking your account…' : 'Preparing your wallet…'}
        </Text>
      </Shell>
    );
  }

  if (gate.k === 'onboard') {
    return (
      <RoleOnboarding
        wallet={gate.wallet}
        onDone={(profile) => setGate({ k: 'ready', profile })}
      />
    );
  }

  // Screens 3 and 4. Both roles now have their own tab set; neither is
  // complete (carrier Earnings, shipper Tracking/History are stubs inside
  // each view).
  const signingWallet = walletsRef.current[0] as unknown as SigningWallet;

  if (gate.profile.role === 'carrier') {
    return <CarrierHome wallet={signingWallet} profile={gate.profile} onSignOut={onSignOut} />;
  }

  return (
    <ShipperHome
      wallet={signingWallet}
      profile={gate.profile}
      onProfileChange={(profile) => setGate({ k: 'ready', profile })}
      onSignOut={onSignOut}
    />
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <View style={styles.screen}>
      <Image source={LOGO_SOURCE} style={styles.logo} resizeMode="contain" />
      {children}
      <Text style={styles.footer}>
        {CLUSTER} · program {programIdShort}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: semantic.bgCanvas,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.s24 + space.s8,
  },
  logo: { width: 72, height: 72, marginBottom: space.s24 },
  title: {
    fontSize: type.title,
    fontWeight: '700',
    color: semantic.textPrimary,
    textAlign: 'center',
  },
  subtitle: {
    marginTop: space.s8,
    fontSize: type.subtitle,
    color: semantic.textSecondary,
    textAlign: 'center',
  },
  hint: {
    marginTop: space.s4,
    fontSize: type.caption,
    color: semantic.textTertiary,
    textAlign: 'center',
  },
  primaryBtn: {
    marginTop: space.s20,
    alignSelf: 'stretch',
    backgroundColor: semantic.actionPrimary,
    borderRadius: radius.pura20,
    paddingVertical: space.s16,
    alignItems: 'center',
  },
  primaryBtnText: {
    color: semantic.textInverse,
    fontSize: type.body,
    fontWeight: '600',
  },
  footer: {
    position: 'absolute',
    bottom: space.s24 + space.s16,
    color: semantic.textTertiary,
    fontSize: type.footnote,
  },
});
