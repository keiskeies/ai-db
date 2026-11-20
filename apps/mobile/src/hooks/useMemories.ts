import { useEffect, useState } from 'react';
import type { Memory } from '@aidb/core';
import type { BridgeClient } from '../bridge';
import { notify } from '../lib/utils';
import type { TabKey } from '../types';

export function useMemories(client: BridgeClient, { tab, mePage }: { tab: TabKey; mePage: 'memory' | 'connections' | 'settings' | null }) {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [memoryQuery, setMemoryQuery] = useState('');
  const [memoryLoading, setMemoryLoading] = useState(false);

  const [memoryDraft, setMemoryDraft] = useState<{ id?: string; kind: string; title: string; content: string } | null>(null);

  useEffect(() => {
    if (tab === 'me' && mePage === 'memory') void loadMemories();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, mePage]);

  const loadMemories = async (q = memoryQuery) => {
    setMemoryLoading(true);
    try {
      const result = await client.memories(q);
      setMemories(result.memories);
    } catch (err: any) {
      notify('加载失败', err?.message ?? '');
    } finally {
      setMemoryLoading(false);
    }
  };

  return { memories, memoryQuery, setMemoryQuery, memoryLoading, memoryDraft, setMemoryDraft, loadMemories };
}
