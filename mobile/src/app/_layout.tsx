// Side-effect import, and it MUST stay first: it installs crypto/TextEncoder/
// Buffer that Privy and @solana/web3.js read at module load.
import '@/lib/polyfills';

import { PrivyProvider } from '@privy-io/expo';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { colors } from '@/lib/theme';

const appId = process.env.EXPO_PUBLIC_PRIVY_APP_ID ?? '';
const clientId = process.env.EXPO_PUBLIC_PRIVY_CLIENT_ID ?? '';

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <PrivyProvider appId={appId} clientId={clientId}>
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: colors.bg },
          }}
        />
      </PrivyProvider>
    </SafeAreaProvider>
  );
}
