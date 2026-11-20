import React from 'react';
import type { BridgeClient } from '../../bridge';

/** 图表一键解读/预测：Agent 消息流用当前会话的连接与库；仪表板等可用 insight prop 覆盖。 */
export const ChartInsightContext = React.createContext<{ client: BridgeClient; connectionId?: string; database?: string } | null>(null);
