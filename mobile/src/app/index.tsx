import {
  useLoginWithEmail,
  useLoginWithOAuth,
  useLoginWithSMS,
  usePrivy,
} from '@privy-io/expo';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CLUSTER, programIdShort } from '@/lib/solana';
import { SignedIn } from '@/components/SignedIn';
import { colors, LOGO_SOURCE } from '@/lib/theme';

/** Which entry the user picked. 'choose' is the landing state. */
type Mode = 'choose' | 'email' | 'sms';

/** Looks like an email, versus a phone number. */
const isEmail = (v: string) => /\S+@\S+\.\S+/.test(v.trim());

export default function AuthScreen() {
  const insets = useSafeAreaInsets();
  const { isReady, user, logout } = usePrivy();

  const [mode, setMode] = useState<Mode>('choose');
  const [identifier, setIdentifier] = useState('');
  const [code, setCode] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const oauth = useLoginWithOAuth();
  const email = useLoginWithEmail();
  const sms = useLoginWithSMS();

  // Identity, logged from the authoritative source rather than a login()
  // return value. Must sit above the early returns below: hooks cannot be
  // called conditionally.
  useEffect(() => {
    console.log(`[auth] session: ${user ? `signed in ${user.id}` : 'signed out'}`);
  }, [user]);

  // Privy restores a stored session on first render; `isReady` is false until
  // that resolves. Rendering the sign-in options before then flashes a login
  // screen at an already-signed-in user — the exact bug the web client hit
  // (see solana/app/src/privy.jsx's `if (!ready)` gate).
  if (!isReady) {
    return (
      <View style={[styles.screen, styles.centered]}>
        <Image source={LOGO_SOURCE} style={styles.logo} resizeMode="contain" />
        <ActivityIndicator color={colors.primaryDeep} style={{ marginTop: 24 }} />
      </View>
    );
  }

  // A missing client ID is a configuration mistake, not a user-facing error.
  // Saying so plainly beats Privy's opaque failure, which is what cost a
  // whole debugging session on the Capacitor build.
  if (!process.env.EXPO_PUBLIC_PRIVY_CLIENT_ID) {
    return (
      <View style={[styles.screen, styles.centered, { paddingHorizontal: 32 }]}>
        <Image source={LOGO_SOURCE} style={styles.logo} resizeMode="contain" />
        <Text style={[styles.title, { marginTop: 24 }]}>Not configured yet</Text>
        <Text style={[styles.subtitle, { textAlign: 'center' }]}>
          EXPO_PUBLIC_PRIVY_CLIENT_ID is empty. Create an Expo-typed client in the
          Privy dashboard, add `pura` to its allowed URL schemes, then put its ID
          in .env and restart the dev server.
        </Text>
      </View>
    );
  }

  // Signed in — everything past auth (wallet, profile lookup, screen 2)
  // lives in SignedIn. Screen 2 is skipped entirely when the server already
  // has a role for this wallet, matching the web client.
  if (user) {
    return <SignedIn userId={user.id} onSignOut={() => { console.log('[auth] logout: start'); logout(); }} />;
  }

  const reset = () => {
    setMode('choose');
    setIdentifier('');
    setCode('');
    setCodeSent(false);
    setError(null);
  };

  const withBusy = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    console.log(`[auth] ${label}: start`);
    try {
      await fn();
      // NB: the login hooks are typed Promise<User | undefined> and do in
      // fact resolve undefined, so the return value cannot be used to
      // evidence who signed in. `user` from usePrivy() is the source of
      // truth; the effect below logs it when it changes.
      console.log(`[auth] ${label}: ok`);
    } catch (err) {
      // Privy's errors are often bare objects; surface something legible
      // rather than "[object Object]" — and log the raw shape too, because
      // the useful part (error_code / invalid_origin) is usually nested
      // somewhere the message doesn't reach.
      console.log(`[auth] ${label}: FAILED`, JSON.stringify(err, Object.getOwnPropertyNames(Object(err))));
      setError(err instanceof Error ? err.message : 'Something went wrong. Try again.');
    }
    setBusy(false);
  };

  const onGoogle = () =>
    withBusy('google-oauth', async () => {
      await oauth.login({ provider: 'google' });
    });

  const onContinue = () =>
    withBusy('send-code', async () => {
      const value = identifier.trim();
      if (!value) throw new Error('Enter an email or phone number.');
      if (isEmail(value)) {
        setMode('email');
        await email.sendCode({ email: value });
      } else {
        setMode('sms');
        await sms.sendCode({ phone: value });
      }
      setCodeSent(true);
    });

  const onVerify = () =>
    withBusy('verify-code', async () => {
      if (code.trim().length === 0) throw new Error('Enter the code we sent you.');
      if (mode === 'email') {
        await email.loginWithCode({ code: code.trim(), email: identifier.trim() });
      } else {
        await sms.loginWithCode({ code: code.trim(), phone: identifier.trim() });
      }
    });

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingTop: insets.top + 48, paddingBottom: insets.bottom + 32 },
        ]}
        keyboardShouldPersistTaps="handled"
      >
        <Image source={LOGO_SOURCE} style={styles.logo} resizeMode="contain" />
        <Text style={styles.title}>Log in or sign up</Text>
        <Text style={styles.subtitle}>Payment held until delivery.</Text>

        {!codeSent ? (
          <>
            <Pressable
              style={({ pressed }) => [styles.primaryBtn, pressed && styles.pressed]}
              onPress={onGoogle}
              disabled={busy}
            >
              <Text style={styles.primaryBtnText}>
                {busy ? 'Opening…' : 'Continue with Google'}
              </Text>
            </Pressable>

            <Text style={styles.divider}>or use email or phone</Text>

            <TextInput
              style={styles.input}
              placeholder="you@company.com"
              placeholderTextColor={colors.textFaint}
              value={identifier}
              onChangeText={setIdentifier}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              editable={!busy}
            />
            <Pressable
              style={({ pressed }) => [styles.secondaryBtn, pressed && styles.pressed]}
              onPress={onContinue}
              disabled={busy}
            >
              <Text style={styles.secondaryBtnText}>{busy ? 'Sending…' : 'Continue'}</Text>
            </Pressable>
          </>
        ) : (
          <>
            <Text style={styles.hint}>
              We sent a code to {identifier.trim()}.
            </Text>
            <TextInput
              style={styles.input}
              placeholder="123456"
              placeholderTextColor={colors.textFaint}
              value={code}
              onChangeText={setCode}
              keyboardType="number-pad"
              editable={!busy}
            />
            <Pressable
              style={({ pressed }) => [styles.primaryBtn, pressed && styles.pressed]}
              onPress={onVerify}
              disabled={busy}
            >
              <Text style={styles.primaryBtnText}>{busy ? 'Verifying…' : 'Verify'}</Text>
            </Pressable>
            <Pressable onPress={reset} disabled={busy}>
              <Text style={styles.link}>Use a different email or phone</Text>
            </Pressable>
          </>
        )}

        {error ? <Text style={styles.error}>{error}</Text> : null}

        {/* Proves at a glance which chain and program a build points at —
            the web client shows an equivalent devnet badge. Cheap insurance
            against testing a device build against the wrong program. */}
        <Text style={styles.footer}>
          {CLUSTER} · program {programIdShort}
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  centered: { alignItems: 'center', justifyContent: 'center' },
  content: { paddingHorizontal: 24, alignItems: 'stretch' },
  logo: { width: 72, height: 72, alignSelf: 'center' },
  title: {
    marginTop: 28,
    fontSize: 26,
    fontWeight: '700',
    color: colors.text,
    textAlign: 'center',
  },
  subtitle: {
    marginTop: 8,
    marginBottom: 32,
    fontSize: 15,
    color: colors.textMuted,
    textAlign: 'center',
  },
  primaryBtn: {
    backgroundColor: colors.primary,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
  },
  primaryBtnText: { color: colors.onPrimary, fontSize: 16, fontWeight: '600' },
  secondaryBtn: {
    marginTop: 12,
    backgroundColor: colors.primaryDeep,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
  },
  secondaryBtnText: { color: '#FFFFFF', fontSize: 16, fontWeight: '600' },
  pressed: { opacity: 0.85 },
  divider: {
    marginVertical: 20,
    textAlign: 'center',
    color: colors.textMuted,
    fontSize: 13,
  },
  input: {
    backgroundColor: colors.field,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 16,
    color: colors.text,
  },
  hint: { color: colors.textMuted, fontSize: 14, marginBottom: 12, textAlign: 'center' },
  link: {
    marginTop: 18,
    textAlign: 'center',
    color: colors.primaryDeep,
    fontSize: 14,
    fontWeight: '600',
  },
  error: { marginTop: 20, color: colors.danger, fontSize: 14, textAlign: 'center' },
  footer: {
    marginTop: 40,
    textAlign: 'center',
    color: colors.textFaint,
    fontSize: 12,
  },
});
