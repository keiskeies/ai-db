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
        const location = (globalThis as any).location;
        const params = new URLSearchParams(location?.search ?? '');
        const bridge = params.get('bridge');
        const token = params.get('token');
        if (bridge && token) {
          saved = { baseUrl: normalizeBaseUrl(bridge), token };
          await saveBridgeConfig(saved);
        }
        // token 是一次性配对入口：仅保留当前页面内存后立即替换历史项，避免刷新/前进后退/复制 URL 泄露。
        // 不完整配对里的孤立 token 也同样清除；保留无关查询参数和 hash。
        if (params.has('token')) {
          params.delete('token');
          if (bridge && token) params.delete('bridge');
          const search = params.toString();
          const hash = location?.hash ?? '';
          const next = `${location?.pathname ?? '/'}${search ? `?${search}` : ''}${hash}`;
          try {
            (globalThis as any).history?.replaceState(null, '', next);
          } catch {
            /* blocked history API must not prevent pairing */
          }
        }
      }
      setConfig(saved);
      setReady(true);
    })();
  }, []);

  return { config, setConfig, ready };
}
