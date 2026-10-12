import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { searchPlaces, type Place } from '@/lib/geo';
import { colors, radius, semantic, space, type } from '@/lib/theme';

/**
 * Address picker. Stands in for the web client's LocationSearch, which is
 * built on the Google Places JS SDK and cannot run here — see lib/geo.ts.
 *
 * A chosen place is shown as a filled row rather than left in the input, so
 * the difference between "typed something" and "picked a real place with
 * coordinates" is visible. It has to be: the coordinates go on-chain and the
 * country code sets the booking's corridor, so free text that was never
 * resolved is not a booking.
 */
export function PlaceField({
  label,
  value,
  onChange,
  editable = true,
}: {
  label: string;
  value: Place | null;
  onChange: (p: Place | null) => void;
  editable?: boolean;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Place[]>([]);
  const [searching, setSearching] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Only the newest search may write results — a slow early request must not
  // land on top of a fast later one.
  const seq = useRef(0);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (value || query.trim().length < 2) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    // 500ms rather than the web client's 250: Nominatim's usage policy is one
    // request a second, and a typeahead is the easiest way to breach it.
    timer.current = setTimeout(() => {
      const mine = ++seq.current;
      void searchPlaces(query).then((hits) => {
        if (mine !== seq.current) return;
        setResults(hits);
        setSearching(false);
      });
    }, 500);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [query, value]);

  if (value) {
    return (
      <View>
        <Text style={styles.label}>{label}</Text>
        <Pressable
          disabled={!editable}
          onPress={() => {
            onChange(null);
            setQuery('');
          }}
          style={({ pressed }) => [styles.filled, pressed && styles.pressed]}
        >
          <Text style={styles.filledText} numberOfLines={2}>
            {value.name}
          </Text>
          {editable && <Text style={styles.change}>Change</Text>}
        </Pressable>
      </View>
    );
  }

  return (
    <View>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        style={styles.input}
        value={query}
        onChangeText={setQuery}
        placeholder="Search for an address"
        placeholderTextColor={colors.textFaint}
        editable={editable}
        autoCorrect={false}
      />
      {searching && <ActivityIndicator style={styles.spinner} color={colors.primaryDeep} />}
      {results.map((place, i) => (
        <Pressable
          key={`${place.lat},${place.lng},${i}`}
          onPress={() => {
            onChange(place);
            setResults([]);
            setQuery('');
          }}
          style={({ pressed }) => [styles.result, pressed && styles.pressed]}
        >
          <Text style={styles.resultTitle} numberOfLines={1}>
            {place.short}
          </Text>
          <Text style={styles.resultSub} numberOfLines={1}>
            {place.name}
          </Text>
        </Pressable>
      ))}
      {!searching && query.trim().length >= 2 && results.length === 0 && (
        <Text style={styles.empty}>No matches. Try a city or a street with a number.</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
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
  spinner: { marginTop: space.s12 },
  result: {
    marginTop: space.s8,
    backgroundColor: semantic.bgSurface,
    borderColor: semantic.borderDefault,
    borderWidth: 1,
    borderRadius: radius.pura12,
    paddingHorizontal: space.s16,
    paddingVertical: space.s12,
  },
  resultTitle: { fontSize: type.label, fontWeight: '600', color: semantic.textPrimary },
  resultSub: { marginTop: 2, fontSize: type.footnote, color: semantic.textTertiary },
  empty: { marginTop: space.s12, fontSize: type.caption, color: semantic.textTertiary },
  filled: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.s12,
    backgroundColor: colors.primarySoft,
    borderColor: colors.primaryDeep,
    borderWidth: 1,
    borderRadius: radius.pura12,
    paddingHorizontal: space.s16,
    paddingVertical: space.s12 + 2,
  },
  filledText: { flex: 1, fontSize: type.label, fontWeight: '600', color: colors.primaryDeep },
  change: { fontSize: type.caption, fontWeight: '600', color: colors.primaryDark },
  pressed: { opacity: 0.85 },
});
