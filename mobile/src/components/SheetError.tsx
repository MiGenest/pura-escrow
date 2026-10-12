import { StyleSheet, Text, View } from 'react-native';

import { radius, semantic, space, type } from '@/lib/theme';

/**
 * A failed attempt inside a confirm sheet.
 *
 * Deliberately loud, and deliberately ABOVE the details rather than below
 * the button. Both sheets used to render the error as one line of
 * caption-sized danger text under the rows, which is what the web client
 * does — and on device 2026-09-18 it was missed completely: an accept
 * failed on a stale blockhash, the message rendered, and the load was
 * simply tapped again. Two taps, one success, and the user reasonably read
 * the pair as a possible double-submit.
 *
 * So: filled block, real heading, body text at reading size, sitting where
 * the eye already is. The heading says nothing happened, because the most
 * valuable thing to communicate after a failed on-chain attempt is that it
 * did NOT partially land.
 */
export function SheetError({ message }: { message: string }) {
  return (
    <View style={styles.box} accessibilityRole="alert">
      <Text style={styles.heading}>Nothing was sent</Text>
      <Text style={styles.body}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    marginBottom: space.s20,
    backgroundColor: semantic.bgDanger,
    borderColor: semantic.borderDanger,
    borderWidth: 1.5,
    borderRadius: radius.pura12,
    paddingHorizontal: space.s16,
    paddingVertical: space.s12 + 2,
  },
  heading: {
    fontSize: type.body,
    fontWeight: '700',
    color: semantic.textDanger,
  },
  body: {
    marginTop: space.s4,
    fontSize: type.label,
    color: semantic.textDanger,
    lineHeight: 20,
  },
});
