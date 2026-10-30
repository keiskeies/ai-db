export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  version?: string;
  license?: string;
  enabled: boolean;
  /** 随 AiDB 内置的技能，卸载后不会被重新加回。 */
  builtin?: boolean;
  fileCount: number;
  updatedAt: string;
}

export interface SkillFileEntry {
  path: string;
  type: 'file' | 'directory';
  size?: number;
}

export interface SkillDetail extends SkillSummary {
  files: SkillFileEntry[];
  /** SKILL.md 正文（不含 frontmatter），供 UI 预览。 */
  body?: string;
}

export interface SkillReadResult {
  skill: string;
  path: string;
  content: string;
  truncated: boolean;
  offset: number;
  totalChars: number;
  nextOffset?: number;
}


export interface SkillEntrypoint {
  id: string;
  /** 命令数组；第一项可用 ${python} / ${node} 占位，由宿主解析。 */
  command: string[];
  args?: string[];
  /** 是否允许模型在调用时追加参数；固定流水线应设为 false。 */
  allowArgs?: boolean;
  timeoutMs?: number;
  env?: Record<string, string>;
}

export interface SkillManifest {
  runtime?: { python?: string; node?: string; pythonPackages?: string[] };
  /** 在模型开始前由宿主确定性执行的 entrypoint（例如完整性检查、项目初始化）。 */
  bootstrap?: string | string[];
  /** 宿主给模型的精简适配说明；优先于技能内部的冗长工作流文档。 */
  guide?: string;
  /** 需要注入到 entrypoint 环境变量的密钥名；值存加密库，不返回给模型。 */
  secrets?: string[];
  permissions?: {
    fs?: Array<'skill' | 'workspace' | 'input' | 'output'>;
    process?: Array<'python' | 'node'>;
    network?: boolean;
    /** 允许该 skill 调用的 MCP Server id / 名称；为空表示不允许。 */
    mcp?: string[];
  };
  entrypoints?: SkillEntrypoint[];
}

export interface SkillRunInfo {
  id: string;
  skill: string;
  workspace: string;
  status: 'running' | 'succeeded' | 'failed' | 'timed_out';
  entrypoint?: string;
  /** 最近一次 project-init 生成的项目目录，供后续 entrypoint 使用。 */
  project?: string;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  error?: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
}

export interface SkillRunFile {
  path: string;
  area: 'workspace' | 'input' | 'output';
  type: 'file' | 'directory';
  size?: number;
}
