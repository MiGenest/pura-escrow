import { useState } from 'react';
import {
  ActivityIndicator,
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

import { saveProfile, type Profile, type Role, type SigningWallet } from '@/lib/profile';
import { CLUSTER, programIdShort } from '@/lib/solana';
import { colors, radius, semantic, space, type } from '@/lib/theme';

/**
 * Screen 2 — role selection + details.
 *
 * Mirrors the web client's onboarding (solana/app/src/App.jsx): pick a role,
 * then fill details, then ONE POST /api/profile carrying both. Web gates
 * "continue" on a name longer than one character and nothing else; the same
 * rule is used here so the two clients accept the same input.
 *
 * Role is presented as a one-time choice because that is what the product
 * does — the web Profile tab renders it in a `role-locked` block with no
 * control. Worth knowing that this is convention rather than enforcement:
 * the server's upsert does `role = excluded.role`, so a signed write would
 * change it. Nothing here offers that, deliberately.
 */

type Step = 'role' | 'details';

const ROLE_CARDS: { id: Role; title: string; note: string }[] = [
  // Copy lifted from solana/app/src/i18n.js's role_*_title / role_*_note so
  // the choice reads identically on both clients.
  { id: 'shipper', title: 'I have cargo', note: 'You post loads and your payment is held safely until delivery' },
  { id: 'carrier', title: 'I have a truck', note: 'You accept loads and get paid on delivery' },
];

export function RoleOnboarding({
  wallet,
  onDone,
}: {
  wallet: SigningWallet;
  onDone: (p: Profile) => void;
}) {
  const insets = useSafeAreaInsets();
  const [step, setStep] = useState<Step>('role');
  const [role, setRole] = useState<Role | null>(null);
  const [name, setName] = useState('');
  const [company, setCompany] = useState('');
  const [phone, setPhone] = useState('');
  const [plate, setPlate] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Same gate as the web client's `ready`.
  const ready = name.trim().length > 1;

  const submit = async () => {
    if (!role) return;
    setBusy(true);
    setError(null);
    const profile: Profile = {
      role,
      name: name.trim(),
      company: company.trim() || null,
      phone: phone.trim() || null,
      // plate is a carrier field on the web client too
      plate: role === 'carrier' ? plate.trim() || null : null,
    };
    console.log(`[onboard] save: start role=${role}`);
    try {
      await saveProfile(wallet, profile);
      console.log('[onboard] save: ok');
      onDone(profile);
    } catch (err) {
      console.log(
        '[onboard] save: FAILED',
        JSON.stringify(err, Object.getOwnPropertyNames(Object(err)))
      );
      setError(err instanceof Error ? err.message : 'Could not save. Try again.');
    }
    setBusy(false);
  };

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingTop: insets.top + space.s24 * 2, paddingBottom: insets.bottom + space.s24 },
        ]}
        keyboardShouldPersistTaps="handled"
      >
        {step === 'role' ? (
          <>
            <Text style={styles.title}>Who are you?</Text>
            <Text style={styles.subtitle}>This sets up your workspace.</Text>

            {ROLE_CARDS.map((r) => (
              <Pressable
                key={r.id}
                onPress={() => setRole(r.id)}
                style={({ pressed }) => [
                  styles.roleCard,
                  role === r.id && styles.roleCardActive,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={[styles.roleTitle, role === r.id && styles.roleTitleActive]}>
                  {r.title}
                </Text>
                <Text style={styles.roleNote}>{r.note}</Text>
              </Pressable>
            ))}

            <Pressable
              disabled={!role}
              onPress={() => setStep('details')}
              style={({ pressed }) => [
                styles.primaryBtn,
                !role && styles.btnDisabled,
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.primaryBtnText}>Continue</Text>
            </Pressable>
          </>
        ) : (
          <>
            <Text style={styles.title}>Your details</Text>
            <Text style={styles.subtitle}>
              {role === 'carrier' ? 'So shippers know who is driving.' : 'So carriers know who to contact.'}
            </Text>

            <Text style={styles.label}>Full name</Text>
            <TextInput
              style={styles.input}
              value={name}
              onChangeText={setName}
              placeholder="Your name"
              placeholderTextColor={colors.textFaint}
              editable={!busy}
            />

            <Text style={styles.label}>Company</Text>
            <TextInput
              style={styles.input}
              value={company}
              onChangeText={setCompany}
              placeholder="Optional"
              placeholderTextColor={colors.textFaint}
              editable={!busy}
            />

            <Text style={styles.label}>Phone</Text>
            <TextInput
              style={styles.input}
              value={phone}
              onChangeText={setPhone}
              placeholder="Optional"
              placeholderTextColor={colors.textFaint}
              keyboardType="phone-pad"
              editable={!busy}
            />

            {role === 'carrier' && (
              <>
                <Text style={styles.label}>Truck plate</Text>
                <TextInput
                  style={styles.input}
                  value={plate}
                  onChangeText={setPlate}
                  placeholder="Optional"
                  placeholderTextColor={colors.textFaint}
                  autoCapitalize="characters"
                  editable={!busy}
                />
              </>
            )}

            <Pressable
              disabled={!ready || busy}
              onPress={submit}
              style={({ pressed }) => [
                styles.primaryBtn,
                (!ready || busy) && styles.btnDisabled,
                pressed && styles.pressed,
              ]}
            >
              {busy ? (
                <ActivityIndicator color={semantic.textInverse} />
              ) : (
                <Text style={styles.primaryBtnText}>Enter Pura</Text>
              )}
            </Pressable>

            <Pressable onPress={() => setStep('role')} disabled={busy}>
              <Text style={styles.link}>Back</Text>
            </Pressable>
          </>
        )}

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <Text style={styles.footer}>
          {CLUSTER} · program {programIdShort}
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: semantic.bgCanvas },
  content: { paddingHorizontal: space.s24, alignItems: 'stretch' },
  title: {
    fontSize: type.title,
    fontWeight: '700',
    color: semantic.textPrimary,
    textAlign: 'center',
  },
  subtitle: {
    marginTop: space.s8,
    marginBottom: space.s24,
    fontSize: type.subtitle,
    color: semantic.textSecondary,
    textAlign: 'center',
  },
  roleCard: {
    backgroundColor: semantic.bgSurface,
    borderColor: semantic.borderDefault,
    borderWidth: 1,
    borderRadius: radius.pura20,
    padding: space.s20,
    marginBottom: space.s12,
  },
  roleCardActive: {
    borderColor: colors.primaryDeep,
    backgroundColor: colors.primarySoft,
  },
  roleTitle: {
    fontSize: type.body,
    fontWeight: '600',
    color: semantic.textPrimary,
  },
  roleTitleActive: { color: colors.primaryDeep },
  roleNote: {
    marginTop: space.s4,
    fontSize: type.caption,
    color: semantic.textSecondary,
  },
  label: {
    marginTop: space.s16,
    marginBottom: space.s8,
    fontSize: type.label,
    fontWeight: '600',
    color: semantic.textSecondary,
  },
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
  primaryBtn: {
    marginTop: space.s24,
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
  btnDisabled: { opacity: 0.45 },
  pressed: { opacity: 0.85 },
  link: {
    marginTop: space.s16,
    textAlign: 'center',
    color: colors.primaryDeep,
    fontSize: type.label,
    fontWeight: '600',
  },
  error: {
    marginTop: space.s20,
    color: colors.danger,
    fontSize: type.label,
    textAlign: 'center',
  },
  footer: {
    marginTop: space.s24 + space.s16,
    textAlign: 'center',
    color: semantic.textTertiary,
    fontSize: type.footnote,
  },
});
