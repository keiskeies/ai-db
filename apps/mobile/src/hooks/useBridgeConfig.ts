import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { loadBridgeConfig, normalizeBaseUrl, saveBridgeConfig, type BridgeConfig } from '../bridge';

export function useBridgeConfig() {
  const [config, setConfig] = useState<BridgeConfig | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    (async () => {
      let saved = await loadBridgeConfig();
      if (Platform.OS === 'web') {
        const search = (globalThis as any).location?.search ?? '';
        const params = new URLSearchParams(search);
        const bridge = params.get('bridge');
        const token = params.get('token');
        if (bridge && token) {
          saved = { baseUrl: normalizeBaseUrl(bridge), token };
          await saveBridgeConfig(saved);
        }
      }
      setConfig(saved);
      setReady(true);
    })();
  }, []);

  return { config, setConfig, ready };
}
