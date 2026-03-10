import { DarkTheme, ThemeProvider as NavigationThemeProvider } from '@react-navigation/native';
import { WalletProvider, WDKService, NetworkType } from '@tetherto/wdk-react-native-provider';
import { ThemeProvider } from '@tetherto/wdk-uikit-react-native';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo } from 'react';
import { View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import 'react-native-reanimated';
import getChainsConfig from '@/config/get-chains-config';
import '@/utils/mock-xaut-transfers-patch';
import { Toaster } from 'sonner-native';
import { colors } from '@/constants/colors';
import { networkConfigs } from '@/config/networks';
import { HistoricalPriceSync } from '@/components/HistoricalPriceSync';

SplashScreen.preventAutoHideAsync();

const CustomDarkTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: colors.background,
    card: colors.background,
  },
};

export default function RootLayout() {
  useEffect(() => {
    const initApp = async () => {
      try {
        await WDKService.initialize();
      } catch (error) {
        console.error('Failed to initialize services in app layout:', error);
      } finally {
        SplashScreen.hideAsync();
      }
    };

    initApp();
  }, []);

  // Memoize the WalletProvider config to avoid recomputing on every render
  const walletProviderConfig = useMemo(() => {
    const chainsConfig = getChainsConfig();
    const networkTypeValues = Object.values(NetworkType);
    
    // Wrap each chain config value to ensure blockchain property exists and is accessible
    const wrappedChainsConfig: Record<string, any> = {};
    Object.keys(chainsConfig).forEach((key) => {
      const chainConfig = chainsConfig[key];
      if (chainConfig && typeof chainConfig === 'object') {
        // Ensure blockchain property exists
        if (!chainConfig.blockchain) {
          wrappedChainsConfig[key] = { ...chainConfig, blockchain: key };
        } else {
          wrappedChainsConfig[key] = chainConfig;
        }
      } else {
        wrappedChainsConfig[key] = { blockchain: key };
      }
    });
    
    // Add all NetworkType enum values as keys to ensure WDKService can find them
    // WDKService might be accessing chainsConfig using NetworkType enum values directly
    networkTypeValues.forEach((networkTypeValue) => {
      if (!wrappedChainsConfig[networkTypeValue]) {
        // Find the corresponding chain config via networkConfigs mapping
        const networkConfig = networkConfigs[networkTypeValue as NetworkType];
        const chainId = networkConfig?.id;
        if (chainId && wrappedChainsConfig[chainId]) {
          wrappedChainsConfig[networkTypeValue] = wrappedChainsConfig[chainId];
        } else {
          wrappedChainsConfig[networkTypeValue] = { blockchain: networkTypeValue };
        }
      }
    });
    
    // Create a proxy to intercept access attempts and provide safe defaults
    const chainsConfigProxy = new Proxy(wrappedChainsConfig, {
      get(target, prop) {
        const propStr = String(prop);
        // Ignore internal JavaScript properties
        if (propStr === 'toJSON' || propStr === 'toString' || propStr === 'valueOf' || propStr === 'constructor' || propStr.startsWith('Symbol(')) {
          return target[prop as string];
        }
        const value = target[prop as string];
        if (value === undefined || value === null) {
          // Return a safe default object with blockchain property
          return { blockchain: propStr };
        } else if (typeof value === 'object') {
          // Ensure blockchain exists
          if (!value.blockchain) {
            return { ...value, blockchain: propStr };
          }
          // Wrap the value in a proxy to catch .blockchain access
          return new Proxy(value, {
            get(targetValue, nestedProp) {
              const nestedPropStr = String(nestedProp);
              if (nestedPropStr === 'blockchain' && !targetValue.blockchain) {
                return propStr; // Return key as fallback
              }
              return targetValue[nestedProp as string];
            },
          });
        }
        return value;
      },
      ownKeys(target) {
        return Object.keys(target);
      },
      getOwnPropertyDescriptor(target, prop) {
        return Object.getOwnPropertyDescriptor(target, prop);
      },
    });
    
    return {
      indexer: {
        apiKey: process.env.EXPO_PUBLIC_WDK_INDEXER_API_KEY!,
        url: process.env.EXPO_PUBLIC_WDK_INDEXER_BASE_URL!,
      },
      chains: chainsConfigProxy,
      enableCaching: true,
    };
  }, []);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ThemeProvider
        defaultMode="dark"
        brandConfig={{
          primaryColor: colors.primary,
        }}
      >
        <WalletProvider config={walletProviderConfig}>
          <HistoricalPriceSync />
          <NavigationThemeProvider value={CustomDarkTheme}>
            <View style={{ flex: 1, backgroundColor: colors.background }}>
              <Stack
                screenOptions={{
                  headerShown: false,
                  contentStyle: { backgroundColor: colors.background },
                }}
              />
              <StatusBar style="light" />
            </View>
          </NavigationThemeProvider>
        </WalletProvider>
        <Toaster
          offset={90}
          toastOptions={{
            style: {
              backgroundColor: colors.background,
              borderWidth: 1,
              borderColor: colors.border,
            },
            titleStyle: { color: colors.text },
            descriptionStyle: { color: colors.text },
          }}
        />
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}
