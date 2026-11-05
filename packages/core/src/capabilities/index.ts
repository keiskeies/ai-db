import type { Capability, CapabilityId } from './types';

import transfer from './transfer.json' with { type: 'json' };
import compareData from './compare-data.json' with { type: 'json' };
import schemaSync from './schema-sync.json' with { type: 'json' };
import jobs from './jobs.json' with { type: 'json' };
import pipelines from './pipelines.json' with { type: 'json' };
import generate from './generate.json' with { type: 'json' };
import monitor from './monitor.json' with { type: 'json' };
import users from './users.json' with { type: 'json' };
import dictionary from './dictionary.json' with { type: 'json' };
import advancedObjects from './advanced-objects.json' with { type: 'json' };
import search from './search.json' with { type: 'json' };
import queryBuilder from './query-builder.json' with { type: 'json' };
import agentContext from './agent-context.json' with { type: 'json' };
import reports from './reports.json' with { type: 'json' };

/**
 * 全部能力契约。顺序即 Agent 提示里的展示顺序：按工具箱的常见使用频率排列，
 * 让模型优先看到高频能力。
 */
export const CAPABILITIES: Capability[] = [
  transfer,
  compareData,
  schemaSync,
  jobs,
  pipelines,
  generate,
  monitor,
  users,
  dictionary,
  advancedObjects,
  search,
  queryBuilder,
  agentContext,
  reports,
] as Capability[];

const BY_ID = new Map<string, Capability>(CAPABILITIES.map((capability) => [capability.id, capability]));

export function getCapability(id: string): Capability | undefined {
  return BY_ID.get(id);
}

export function listCapabilities(): Capability[] {
  return [...CAPABILITIES];
}

/** 该功能当前是否有可调用的 Agent 工具。 */
export function isCallable(capability: Capability): boolean {
  return capability.tools.length > 0;
}

export type { CapabilityId };
