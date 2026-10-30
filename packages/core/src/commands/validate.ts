import type { CommandDefinition, CommandRunInput } from './types';
import { COMMANDS } from './registry';

export interface CommandInputError {
  ok: false;
  message: string;
  field?: string;
}

export type CommandInputValidation = { ok: true } | CommandInputError;

function fail(message: string, field?: string): CommandInputError {
  return { ok: false, message, field };
}

/** 静态注册表校验：重复 id / 别名、源数量、槽位与工具声明。 */
export function assertCommandDefinitions(commands: CommandDefinition[] = COMMANDS): void {
  const ids = new Set<string>();
  const aliases = new Set<string>();
  for (const command of commands) {
    const id = command.id.toLowerCase();
    if (ids.has(id)) throw new Error(`重复的命令 id: ${command.id}`);
    ids.add(id);
    for (const alias of command.aliases) {
      const key = alias.toLowerCase();
      if (aliases.has(key)) throw new Error(`重复的命令别名: ${alias}`);
      aliases.add(key);
    }
    if (command.sources.min < 0 || command.sources.max < command.sources.min || command.sources.max > 4) {
      throw new Error(`命令 ${command.id} 的源数量范围非法`);
    }
    const slotKeys = new Set<string>();
    for (const slot of command.slots) {
      if (slotKeys.has(slot.key)) throw new Error(`命令 ${command.id} 存在重复槽位: ${slot.key}`);
      slotKeys.add(slot.key);
    }
    if (command.execution === 'deterministic' && command.extraTools?.length) {
      throw new Error(`确定性命令 ${command.id} 不能声明 Agent 私有工具`);
    }
  }
}

export function validateCommandInput(command: CommandDefinition, input: CommandRunInput): CommandInputValidation {
  const sources = Array.isArray(input.sources) ? input.sources : [];
  if (sources.length < command.sources.min) {
    return fail(`至少需要 ${command.sources.min} 个源`, 'sources');
  }
  if (sources.length > command.sources.max) {
    return fail(`最多支持 ${command.sources.max} 个源`, 'sources');
  }
  for (const [index, source] of sources.entries()) {
    if (!source || typeof source.connectionId !== 'string' || !source.connectionId.trim()) {
      return fail(`第 ${index + 1} 个源缺少连接`, 'sources');
    }
    if (command.sources.database === 'required' && !source.database?.trim()) {
      return fail(`第 ${index + 1} 个源需要选择数据库`, 'sources');
    }
  }
  if (!command.sources.allowSameConnection) {
    const ids = sources.map((source) => source.connectionId);
    if (new Set(ids).size !== ids.length) return fail('该命令不允许重复选择同一个连接', 'sources');
  }
  for (const slot of command.slots) {
    if (slot.kind === 'sources') continue;
    const value = input[slot.key];
    if (slot.required) {
      if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) {
        return fail(`缺少必填项：${slot.label.zh}`, slot.key);
      }
      if (slot.kind === 'mapping' && typeof value !== 'object') {
        return fail('键与字段映射格式不正确', slot.key);
      }
    }
    if (value === undefined || value === null) continue;
    if (slot.kind === 'enum' && slot.options?.length) {
      const allowed = new Set(slot.options.map((option) => option.value));
      if (!allowed.has(String(value))) return fail(`${slot.label.zh} 取值无效`, slot.key);
    }
    if (slot.kind === 'number' && (typeof value !== 'number' || Number.isNaN(value))) {
      return fail(`${slot.label.zh} 必须是数字`, slot.key);
    }
    if (slot.kind === 'boolean' && typeof value !== 'boolean') {
      return fail(`${slot.label.zh} 必须是布尔值`, slot.key);
    }
    if (slot.kind === 'text' && typeof value !== 'string') {
      return fail(`${slot.label.zh} 必须是文本`, slot.key);
    }
  }
  return { ok: true };
}
