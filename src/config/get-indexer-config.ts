import type { IndexerConfig } from '@spacesops/wdk-react-native-core';

/**
 * WDK Indexer credentials from Expo public env (embedded at bundle time).
 */
const getIndexerConfig = (): IndexerConfig | undefined => {
  const baseUrl = process.env.EXPO_PUBLIC_WDK_INDEXER_BASE_URL;
  const apiKey = process.env.EXPO_PUBLIC_WDK_INDEXER_API_KEY;
  if (!baseUrl || !apiKey) {
    return undefined;
  }
  return { baseUrl, apiKey };
};

export default getIndexerConfig;
