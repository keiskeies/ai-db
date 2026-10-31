import type { JsonSchema } from './types';
import type { Risk } from '../types';

export type BuiltinMcpKind = 'filesystem' | 'git' | 'web';

export interface BuiltinMcpToolDefinition {
  name: string;
  description: string;
  risk: Extract<Risk, 'read' | 'write' | 'destructive'>;
  inputSchema: JsonSchema;
}

export interface BuiltinMcpServerDefinition {
  kind: BuiltinMcpKind;
  id: string;
  name: string;
  title: string;
  description: string;
  /** What the configured args mean, shown in Settings and in the Agent catalog. */
  argsLabel: string;
  argsPlaceholder: string;
  defaultEnabled: boolean;
  tools: BuiltinMcpToolDefinition[];
}

const pathProp = {
  type: 'string',
  description: 'Absolute path inside a granted root. Relative paths resolve against the first granted root.',
};

const filesystemTools: BuiltinMcpToolDefinition[] = [
  {
    name: 'list_directory',
    description:
      'List files and folders under a granted directory. Skips .git, node_modules, dist, build, target and other dependency/build directories.',
    risk: 'read',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: pathProp,
        file_path: { type: 'string', description: 'Alias for path (Claude-style)' },
        depth: { type: 'integer', minimum: 1, maximum: 3, description: 'Recursion depth, default 1' },
        maxEntries: { type: 'integer', minimum: 1, maximum: 1000, description: 'Default 400' },
      },
    },
  },
  {
    name: 'read_file',
    description:
      'Read a UTF-8 text file line by line. Use offset/limit for large files instead of re-reading from the start. Binary files are rejected.',
    risk: 'read',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: pathProp,
        file_path: { type: 'string', description: 'Alias for path (Claude-style)' },
        offset: { type: 'integer', minimum: 0, description: 'Zero-based line offset, default 0' },
        limit: { type: 'integer', minimum: 1, maximum: 2000, description: 'Max lines, default 400' },
      },
    },
  },
  {
    name: 'read_multiple_files',
    description:
      'Read several UTF-8 text files in one call. Per-file errors are returned instead of failing the batch. Use it for a Java package or a group of entity classes after search_files.',
    risk: 'read',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        paths: { type: 'array', items: { type: 'string' }, description: 'Absolute or root-relative file paths (max 20)' },
        files: { type: 'array', items: { type: 'string' }, description: 'Alias for paths' },
        offset: { type: 'integer', minimum: 0, description: 'Zero-based line offset for every file, default 0' },
        limit: { type: 'integer', minimum: 1, maximum: 2000, description: 'Max lines per file, default 400' },
        maxTotalChars: { type: 'integer', minimum: 1000, maximum: 400000, description: 'Total content cap, default 120000' },
      },
    },
  },
  {
    name: 'search_files',
    description:
      'Find files by name or path glob under a granted directory. query/pattern supports * and ?; ** matches across directories (e.g. **/*.java or src/**/*.ts). Omit query and pass pattern for Claude-style Glob calls.',
    risk: 'read',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'File name, path glob or substring, e.g. *.java or OrderService' },
        pattern: { type: 'string', description: 'Alias for query (Claude-style Glob pattern), e.g. **/*.java' },
        path: { type: 'string', description: 'Directory to search; defaults to the first granted root' },
        file_path: { type: 'string', description: 'Alias for path' },
        maxResults: { type: 'integer', minimum: 1, maximum: 500, description: 'Default 500' },
        head_limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Alias for maxResults' },
      },
    },
  },
  {
    name: 'grep_files',
    description:
      'Search file contents with a JavaScript regular expression. Returns file, line number and the matching line; optional context lines and files/count output modes. Uses ripgrep when installed and falls back to a built-in scanner.',
    risk: 'read',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['pattern'],
      properties: {
        pattern: { type: 'string', description: 'JavaScript regular expression, e.g. @Table\\(name' },
        path: { type: 'string', description: 'Directory to search; defaults to the first granted root' },
        file_path: { type: 'string', description: 'Alias for path' },
        include: { type: 'string', description: 'File name filter, e.g. *.java or *.ts' },
        glob: { type: 'string', description: 'Claude-style alias for include' },
        type: { type: 'string', description: 'File type shorthand, e.g. java (maps to *.java)' },
        caseSensitive: { type: 'boolean', description: 'Default false' },
        ignore_case: { type: 'boolean', description: 'Claude-style inverse of caseSensitive' },
        '-i': { type: 'boolean', description: 'Claude-style ignore-case flag' },
        maxMatches: { type: 'integer', minimum: 1, maximum: 500, description: 'Default 100' },
        head_limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Claude-style alias for maxMatches' },
        context: { type: 'integer', minimum: 0, maximum: 5, description: 'Context lines before/after each match, default 0' },
        '-A': { type: 'integer', minimum: 0, maximum: 5, description: 'Claude-style after-context' },
        '-B': { type: 'integer', minimum: 0, maximum: 5, description: 'Claude-style before-context' },
        '-C': { type: 'integer', minimum: 0, maximum: 5, description: 'Claude-style context' },
        outputMode: { type: 'string', enum: ['content', 'files', 'count'], description: 'content returns lines; files/count aggregate by file. Default content' },
        output_mode: { type: 'string', enum: ['content', 'files_with_matches', 'count'], description: 'Claude-style alias for outputMode' },
      },
    },
  },
  {
    name: 'file_info',
    description: 'Show type, size and modification time for a path. Use before reading or writing when unsure.',
    risk: 'read',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { path: pathProp, file_path: { type: 'string', description: 'Alias for path (Claude-style)' } },
    },
  },
  {
    name: 'write_file',
    description:
      'Write a UTF-8 text file inside a granted root. Existing files are only overwritten when overwrite=true. Write operation, requires approval in ask mode.',
    risk: 'write',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: pathProp,
        file_path: { type: 'string', description: 'Alias for path (Claude-style)' },
        content: { type: 'string', description: 'Full UTF-8 content (max 2 MB)' },
        overwrite: { type: 'boolean', description: 'Default false' },
        createDirs: { type: 'boolean', description: 'Create missing parent directories, default true' },
      },
    },
  },
  {
    name: 'edit_file',
    description:
      'Replace exact text in a file. Fails when oldText is missing or appears multiple times unless replaceAll=true. Write operation, requires approval in ask mode.',
    risk: 'write',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: pathProp,
        file_path: { type: 'string', description: 'Alias for path (Claude-style)' },
        oldText: { type: 'string', description: 'Exact text to replace' },
        old_string: { type: 'string', description: 'Alias for oldText (Claude-style)' },
        newText: { type: 'string', description: 'Replacement text' },
        new_string: { type: 'string', description: 'Alias for newText (Claude-style)' },
        replaceAll: { type: 'boolean', description: 'Default false' },
        replace_all: { type: 'boolean', description: 'Alias for replaceAll (Claude-style)' },
      },
    },
  },
  {
    name: 'move_file',
    description:
      'Move or rename a file or directory inside granted roots. Existing destinations are only replaced when overwrite=true (files only). Write operation, requires approval in ask mode.',
    risk: 'write',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        source: pathProp,
        source_path: { type: 'string', description: 'Alias for source' },
        destination: { type: 'string', description: 'Destination path inside a granted root' },
        destination_path: { type: 'string', description: 'Alias for destination' },
        overwrite: { type: 'boolean', description: 'Replace an existing file, default false' },
      },
    },
  },
  {
    name: 'delete_file',
    description:
      'Delete a single file inside a granted root. Directories are rejected. confirm must equal the file name or full path. Destructive operation, always requires approval.',
    risk: 'destructive',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: pathProp,
        file_path: { type: 'string', description: 'Alias for path (Claude-style)' },
        confirm: { type: 'string', description: 'File name or full path; guards against accidental deletion' },
      },
    },
  },
];

const gitTools: BuiltinMcpToolDefinition[] = [
  {
    name: 'git_status',
    description: 'Read git status (branch and changed files) for a configured repository. Read-only.',
    risk: 'read',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { repo: { type: 'string', description: 'Configured repository path; optional when only one is configured' } },
    },
  },
  {
    name: 'git_log',
    description: 'Read the recent commit history of a configured repository. Read-only.',
    risk: 'read',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        repo: { type: 'string' },
        maxCount: { type: 'integer', minimum: 1, maximum: 100, description: 'Default 20' },
        path: { type: 'string', description: 'Optional path inside the repository' },
      },
    },
  },
  {
    name: 'git_diff',
    description: 'Show a unified diff for working tree, staged changes or a ref. Read-only.',
    risk: 'read',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        repo: { type: 'string' },
        ref: { type: 'string', description: 'Optional ref such as HEAD~1 or main..feature' },
        staged: { type: 'boolean', description: 'Diff staged changes' },
        path: { type: 'string', description: 'Optional path inside the repository' },
      },
    },
  },
  {
    name: 'git_show',
    description: 'Show a commit (message, stats and optional patch). Read-only.',
    risk: 'read',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['ref'],
      properties: {
        repo: { type: 'string' },
        ref: { type: 'string', description: 'Commit or tag, e.g. HEAD or v1.2.0' },
        patch: { type: 'boolean', description: 'Include the full patch, default false' },
      },
    },
  },
];

const webTools: BuiltinMcpToolDefinition[] = [
  {
    name: 'fetch_url',
    description:
      'Fetch a public HTTP(S) URL and return readable text. HTML is converted to text; JSON is returned as-is. Private, loopback and link-local addresses are blocked.',
    risk: 'read',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['url'],
      properties: {
        url: { type: 'string', description: 'http:// or https:// URL' },
        maxChars: { type: 'integer', minimum: 500, maximum: 200000, description: 'Default 20000' },
      },
    },
  },
  {
    name: 'web_search',
    description:
      'Search the public web through the configured search backends (Exa, Parallel, DuckDuckGo, SearXNG and optional keyed providers). Returns title, URL and snippet, with per-backend status.',
    risk: 'read',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'Natural-language search query' },
        numResults: { type: 'integer', minimum: 1, maximum: 20, description: 'Override the configured result count' },
      },
    },
  },
];

export const BUILTIN_MCP_SERVERS: BuiltinMcpServerDefinition[] = [
  {
    kind: 'filesystem',
    id: 'builtin-filesystem',
    name: 'filesystem',
    title: '文件系统',
    description: '读取项目代码、配置与迁移脚本，并在授权目录内写产物。未配置目录时不可访问任何文件。',
    argsLabel: '允许的目录',
    argsPlaceholder: 'C:\\server\\kbook\\backend',
    defaultEnabled: true,
    tools: filesystemTools,
  },
  {
    kind: 'git',
    id: 'builtin-git',
    name: 'git',
    title: 'Git（只读）',
    description: '查看仓库状态、提交历史与 diff，用来理解表结构变更的来源。只读命令。',
    argsLabel: '仓库目录',
    argsPlaceholder: 'D:\\item\\ai-db',
    defaultEnabled: true,
    tools: gitTools,
  },
  {
    kind: 'web',
    id: 'builtin-web',
    name: 'web',
    title: '网页抓取',
    description: '抓取公开文档、OpenAPI 与 GitHub 页面。启用后可访问所有公网地址，内网与回环地址始终拦截。',
    argsLabel: '域名限制（可选）',
    argsPlaceholder: 'docs.example.com；留空=允许所有公网',
    defaultEnabled: false,
    tools: webTools,
  },
];

const KIND_BY_NAME = new Map(BUILTIN_MCP_SERVERS.map((server) => [server.name, server.kind]));
const SERVER_BY_KIND = new Map(BUILTIN_MCP_SERVERS.map((server) => [server.kind, server]));

function kindFromRef(ref: string): BuiltinMcpKind | undefined {
  const value = ref.trim().toLowerCase();
  if (!value) return undefined;
  if (value.startsWith('builtin:')) {
    const kind = value.slice('builtin:'.length);
    return SERVER_BY_KIND.has(kind as BuiltinMcpKind) ? (kind as BuiltinMcpKind) : undefined;
  }
  if (value.startsWith('builtin-')) {
    const kind = value.slice('builtin-'.length);
    return SERVER_BY_KIND.has(kind as BuiltinMcpKind) ? (kind as BuiltinMcpKind) : undefined;
  }
  return KIND_BY_NAME.get(value);
}

/** Resolve a server id / command / name to a built-in kind (UI and execution path). */
export function builtinMcpKindOf(ref: string): BuiltinMcpKind | undefined {
  return kindFromRef(ref);
}

/**
 * Risk mapping trusts only the fixed first-party ids, commands and reserved names.
 * The gateway refuses to create external servers with these names, so a user server
 * cannot inherit read/destructive semantics by picking "filesystem".
 */
function riskKindFromRef(ref: string): BuiltinMcpKind | undefined {
  const value = ref.trim().toLowerCase();
  if (!value) return undefined;
  for (const server of BUILTIN_MCP_SERVERS) {
    if (value === server.id || value === server.name || value === `builtin:${server.kind}`) return server.kind;
  }
  return undefined;
}

export function builtinMcpServer(kind: BuiltinMcpKind): BuiltinMcpServerDefinition | undefined {
  return SERVER_BY_KIND.get(kind);
}

export function builtinMcpToolRisk(serverRef: string, toolName: string): Extract<Risk, 'read' | 'write' | 'destructive'> | undefined {
  const kind = riskKindFromRef(serverRef);
  if (!kind) return undefined;
  const tool = SERVER_BY_KIND.get(kind)?.tools.find((item) => item.name === toolName.trim());
  return tool?.risk;
}
