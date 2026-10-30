import { useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, FolderUp, Loader2, Play, Save, Search, Square, Trash2 } from 'lucide-react';
import type { SkillDetail, SkillSummary } from '@aidb/core';
import { api, streamSkillRun, type SkillWorkerEvent, type SkillWorkerRun } from '../../lib/api';
import { deliverExportedFile } from '../../lib/desktop';
import { useApp } from '../../store';

interface PendingQuestion {
  id: string;
  question: string;
  options?: string[];
}

const EVENT_LABELS: Record<string, string> = {
  start: '开始',
  text_delta: '输出',
  thinking_delta: '思考',
  tool_call: '调用工具',
  tool_result: '工具结果',
  approval_required: '需要审批',
  approval_resolved: '审批完成',
  plan: '计划',
  usage: '用量',
  done: '完成',
  aborted: '已中止',
  error: '错误',
  skill_question: '提问',
  skill_answer: '回答',
  skill_artifact: '产物',
};

function eventSummary(event: SkillWorkerEvent): string {
  switch (event.type) {
    case 'text_delta':
      return event.text.replace(/\s+/g, ' ').slice(0, 160);
    case 'tool_call':
      return `${event.tool} · ${event.summary || JSON.stringify(event.args).slice(0, 120)}`;
    case 'tool_result':
      return `${event.tool} · ${event.result.summary}${event.result.ok ? '' : '（失败）'}`;
    case 'skill_question':
      return event.question;
    case 'skill_answer':
      return event.answer;
    case 'skill_artifact':
      return `${event.files.filter((file) => file.type === 'file').length} 个文件`;
    case 'done':
      return event.summary ?? '';
    case 'error':
      return `${event.code} · ${event.message}`;
    default:
      return '';
  }
}

export function SkillsTool() {
  const notify = useApp((s) => s.notify);
  const features = useApp((s) => s.settings.features);
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [path, setPath] = useState('');
  const [gitUrl, setGitUrl] = useState('');
  const [gitSubdir, setGitSubdir] = useState('');
  const [npmSpec, setNpmSpec] = useState('');
  const [installingPpt, setInstallingPpt] = useState(false);
  const [query, setQuery] = useState('');
  const [secrets, setSecrets] = useState<{ declared: string[]; set: string[] }>({ declared: [], set: [] });
  const [secretDraft, setSecretDraft] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [run, setRun] = useState<SkillWorkerRun | null>(null);
  const [answerText, setAnswerText] = useState('');
  const [question, setQuestion] = useState<PendingQuestion | null>(null);
  const [text, setText] = useState('');
  const [events, setEvents] = useState<SkillWorkerEvent[]>([]);
  const [starting, setStarting] = useState(false);
  const streamRef = useRef<AbortController | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = async () => {
    setLoading(true);
    try {
      setSkills((await api.skills(true)).skills);
    } catch (err: any) {
      notify('error', '读取 Skills 失败', err?.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    return () => streamRef.current?.abort();
  }, []);

  const open = async (skill: SkillSummary) => {
    try {
      const { skill: full } = await api.skill(skill.id);
      setDetail(full);
      setSecrets(await api.skillSecrets(skill.id));
      setSecretDraft({});
    } catch (err: any) {
      notify('error', '打开 Skill 失败', err?.message);
    }
  };

  const saveSecrets = async () => {
    if (!detail) return;
    const values = Object.fromEntries(Object.entries(secretDraft).filter(([, value]) => value.trim()));
    if (!Object.keys(values).length) {
      notify('info', '没有新的密钥', '填入值后再保存');
      return;
    }
    try {
      setSecrets(await api.saveSkillSecrets(detail.id, values));
      setSecretDraft({});
      notify('success', '密钥已加密保存', detail.id);
    } catch (err: any) {
      notify('error', '保存密钥失败', err?.message);
    }
  };

  const clearSecret = async (name: string) => {
    if (!detail) return;
    try {
      setSecrets(await api.deleteSkillSecret(detail.id, name));
      notify('info', '密钥已清除', name);
    } catch (err: any) {
      notify('error', '清除密钥失败', err?.message);
    }
  };

  const importPath = async () => {
    if (!path.trim()) {
      notify('warning', '填入 skill 目录路径');
      return;
    }
    setImporting(true);
    try {
      const { skill } = await api.importSkill({ path: path.trim() });
      notify('success', 'Skill 已导入', `${skill.name} · ${skill.fileCount} 个文件`);
      setPath('');
      await load();
    } catch (err: any) {
      notify('error', '导入 Skill 失败', err?.message);
    } finally {
      setImporting(false);
    }
  };

  const importZip = async (file: File) => {
    setImporting(true);
    try {
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      let binary = '';
      const chunk = 0x8000;
      for (let index = 0; index < bytes.length; index += chunk) {
        binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
      }
      const base64 = btoa(binary);
      const { skill } = await api.importSkill({ zipBase64: base64, id: file.name.replace(/\.zip$/i, '') });
      notify('success', 'Skill 压缩包已导入', skill.name);
      await load();
    } catch (err: any) {
      notify('error', '导入 Skill 压缩包失败', err?.message);
    } finally {
      setImporting(false);
    }
  };

  const importGit = async () => {
    if (!gitUrl.trim()) {
      notify('warning', '填入 Git 仓库地址');
      return;
    }
    setImporting(true);
    try {
      const { skill } = await api.importSkill({ git: gitUrl.trim(), subdir: gitSubdir.trim() || undefined });
      notify('success', 'Git Skill 已导入', `${skill.name} · ${skill.fileCount} 个文件`);
      setGitUrl('');
      setGitSubdir('');
      await load();
    } catch (err: any) {
      notify('error', '从 Git 导入失败', err?.message);
    } finally {
      setImporting(false);
    }
  };

  const importNpm = async () => {
    if (!npmSpec.trim()) {
      notify('warning', '填入 npm 包名');
      return;
    }
    setImporting(true);
    try {
      const { skill } = await api.importSkill({ npm: npmSpec.trim() });
      notify('success', 'npm Skill 已导入', `${skill.name} · ${skill.fileCount} 个文件`);
      setNpmSpec('');
      await load();
    } catch (err: any) {
      notify('error', '从 npm 导入失败', err?.message);
    } finally {
      setImporting(false);
    }
  };

  const installPpt = async () => {
    setInstallingPpt(true);
    try {
      const { skill } = await api.importSkill({ git: 'https://github.com/hugohe3/ppt-master.git', subdir: 'skills/ppt-master', id: 'ppt-master' });
      notify('success', 'PPT Master 已安装', `${skill.name} · ${skill.fileCount} 个文件`);
      await load();
    } catch (err: any) {
      notify('error', '安装 PPT Master 失败', err?.message);
    } finally {
      setInstallingPpt(false);
    }
  };

  const toggle = async (skill: SkillSummary) => {
    try {
      await api.enableSkill(skill.id, !skill.enabled);
      await load();
    } catch (err: any) {
      notify('error', '更新 Skill 失败', err?.message);
    }
  };

  const remove = async (skill: SkillSummary) => {
    if (!window.confirm(`卸载 Skill「${skill.name}」？文件会移到备份目录。`)) return;
    try {
      await api.deleteSkill(skill.id);
      if (detail?.id === skill.id) setDetail(null);
      await load();
    } catch (err: any) {
      notify('error', '卸载失败', err?.message);
    }
  };

  const refreshRun = async (runId: string) => {
    try {
      const { run: next } = await api.skillRun(runId);
      setRun(next);
    } catch {
      /* the stream may finish before the run record is readable */
    }
  };

  const startRun = async (skill: SkillDetail) => {
    if (!skill.enabled) {
      notify('warning', 'Skill 已禁用', '先启用再运行');
      return;
    }
    streamRef.current?.abort();
    setStarting(true);
    setText('');
    setEvents([]);
    setQuestion(null);
    try {
      const { run: started } = await api.startSkillRun(skill.id, prompt.trim() || undefined);
      setRun({
        runId: started.runId,
        skill: started.skill,
        status: 'running',
        text: '',
        outputs: [],
        startedAt: new Date().toISOString(),
      });
      const controller = new AbortController();
      streamRef.current = controller;
      void streamSkillRun(
        started.runId,
        (event) => {
          if (event.type === 'text_delta') setText((value) => value + event.text);
          setEvents((items) => [...items.slice(-199), event]);
          if (event.type === 'skill_question') setQuestion({ id: event.id, question: event.question, options: event.options });
          if (event.type === 'skill_answer') setQuestion((current) => (current?.id === event.id ? null : current));
          if (event.type === 'skill_artifact') {
            setRun((current) => (current ? { ...current, outputs: event.files, workspace: event.workspace } : current));
          }
          if (event.type === 'done' || event.type === 'aborted' || event.type === 'error') {
            void refreshRun(started.runId);
          }
        },
        0,
        controller.signal,
      ).catch((err: any) => {
        if (!controller.signal.aborted) notify('error', 'Skill 进度中断', err?.message);
      });
    } catch (err: any) {
      notify('error', '启动 Skill Worker 失败', err?.message);
    } finally {
      setStarting(false);
    }
  };

  const cancelRun = async () => {
    if (!run) return;
    try {
      await api.cancelSkillRun(run.runId);
      notify('info', '已请求取消', '正在停止 Skill Worker');
    } catch (err: any) {
      notify('error', '取消失败', err?.message);
    }
  };

  const replyQuestion = async () => {
    if (!run || !question || !answerText.trim()) return;
    const questionId = question.id;
    const answer = answerText.trim();
    setQuestion(null);
    setAnswerText('');
    try {
      const result = await api.answerSkillQuestion(run.runId, questionId, answer);
      if (!result.ok) notify('warning', '问题已失效', 'Worker 可能已经结束');
    } catch (err: any) {
      notify('error', '提交回答失败', err?.message);
    }
  };

  const saveOutput = async (area: string, filePath: string) => {
    if (!run?.workspace) {
      notify('warning', '产物目录未知', '等待运行结束后再保存');
      return;
    }
    const source = `${run.workspace}/${area}/${filePath}`;
    const saved = await deliverExportedFile(source);
    if (!saved) {
      notify('info', '产物路径', source);
      return;
    }
    if (saved.ok) notify('success', '已保存 Skill 产物', saved.path ?? source);
    else if (saved.canceled) notify('info', '未选择位置', `文件仍在 ${source}`);
    else notify('error', '保存失败', saved.error ?? source);
  };

  const outputFiles = run?.outputs.filter((file) => file.type === 'file' && file.area !== 'input') ?? [];
  const filteredSkills = useMemo(() => {
    const text = query.trim().toLowerCase();
    if (!text) return skills;
    return skills.filter((skill) => `${skill.name} ${skill.id} ${skill.description}`.toLowerCase().includes(text));
  }, [skills, query]);
  const templateGroups = useMemo(() => {
    const kinds = ['brands', 'styles', 'layouts', 'decks'];
    const groups = new Map<string, string[]>();
    for (const file of detail?.files ?? []) {
      const parts = file.path.split('/');
      if (parts[0] !== 'templates' || !kinds.includes(parts[1]) || !parts[2]) continue;
      const list = groups.get(parts[1]) ?? [];
      if (!list.includes(parts[2])) list.push(parts[2]);
      groups.set(parts[1], list);
    }
    return [...groups.entries()].map(([kind, names]) => ({ kind, names: names.sort() }));
  }, [detail]);

  return (
    <div className="tool-pane">
      <div className="tool-pane-head">
        <BookOpen size={15} /> Skills
        <span className="muted">SKILL.md 目录包 · 子 Agent 执行 · 产物带回</span>
      </div>
      <div className="tool-scroll">
        {!features.skills ? <div className="dash-empty" style={{ color: 'var(--warning, #D6B45A)' }}>Agent 自动调用已关闭；仍可在本页手动运行 Skill Worker。</div> : null}
        <div className="panel" style={{ padding: 10, marginBottom: 10 }}>
          <div className="panel-head" style={{ paddingLeft: 0 }}>推荐技能</div>
          <div className="tool-row" style={{ padding: 0, border: 0 }}>
            <span style={{ flex: 1 }}>
              <strong>PPT Master</strong> <span className="badge">第三方</span>
              <div className="muted" style={{ fontSize: 10 }}>原生 PPTX、品牌模板与质量门禁；AI PPT 依赖它。</div>
            </span>
            {skills.some((skill) => skill.id === 'ppt-master') ? (
              <span className="badge read">已安装</span>
            ) : (
              <button className="btn primary" onClick={() => void installPpt()} disabled={installingPpt}>
                {installingPpt ? <Loader2 size={12} className="spin" /> : null} 一键安装
              </button>
            )}
          </div>
          <div className="muted" style={{ fontSize: 10, marginTop: 6 }}>约 60MB，首次从官方仓库拉取；轻量内置技能已自动安装，无需操作。</div>
        </div>
        <details className="panel" style={{ padding: 10, marginBottom: 10 }}>
          <summary className="panel-head" style={{ paddingLeft: 0, cursor: 'pointer' }}>手动导入（目录 / zip / Git / npm）</summary>
          <div className="tool-row" style={{ padding: 0, border: 0 }}>
            <div className="field" style={{ flex: 1 }}>
              <label>本地目录（含 SKILL.md）</label>
              <input className="input" value={path} onChange={(e) => setPath(e.target.value)} placeholder="D:\path\to\skill" />
            </div>
            <button className="btn primary" onClick={() => void importPath()} disabled={importing}>
              {importing ? <Loader2 size={12} className="spin" /> : <FolderUp size={12} />} 导入目录
            </button>
            <button className="btn" onClick={() => fileRef.current?.click()} disabled={importing}>
              导入 zip
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".zip"
              style={{ display: 'none' }}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void importZip(file);
                e.target.value = '';
              }}
            />
          </div>
          <div className="tool-row" style={{ padding: '8px 0 0', border: 0 }}>
            <div className="field" style={{ flex: 1 }}>
              <label>Git 仓库（https / ssh / git@）</label>
              <input className="input" value={gitUrl} onChange={(e) => setGitUrl(e.target.value)} placeholder="https://github.com/user/skill-repo" />
            </div>
            <div className="field" style={{ width: 170 }}>
              <label>子目录（可选）</label>
              <input className="input" value={gitSubdir} onChange={(e) => setGitSubdir(e.target.value)} placeholder="skills/my-skill" />
            </div>
            <button className="btn" onClick={() => void importGit()} disabled={importing}>
              导入 Git
            </button>
          </div>
          <div className="tool-row" style={{ padding: '8px 0 0', border: 0 }}>
            <div className="field" style={{ flex: 1 }}>
              <label>npm 包（包内需含 SKILL.md）</label>
              <input className="input" value={npmSpec} onChange={(e) => setNpmSpec(e.target.value)} placeholder="@scope/skill 或 skill@1.2.0" />
            </div>
            <button className="btn" onClick={() => void importNpm()} disabled={importing}>
              导入 npm
            </button>
          </div>
          <div className="muted" style={{ fontSize: 10, marginTop: 6 }}>
            Skill 在独立上下文中运行，只允许读取技能目录、写 workspace/output、执行声明的 entrypoint。
          </div>
        </details>
        <div className="panel" style={{ marginBottom: 10 }}>
          <div className="panel-head">
            技能
            <span className="badge">{skills.length} 个可用 · {skills.filter((skill) => skill.builtin).length} 个内置</span>
          </div>
          <div style={{ padding: '0 10px 8px' }}>
            <div className="search-box">
              <Search size={12} />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索技能…" />
            </div>
          </div>
          {loading ? <div className="dash-empty"><Loader2 size={14} className="spin" /> 读取中…</div> : null}
          {!loading && !skills.length ? <div className="dash-empty">还没有 Skill。可以从上方一键安装，或手动导入。</div> : null}
          {!loading && skills.length && !filteredSkills.length ? <div className="dash-empty">没有匹配的技能。</div> : null}
          {filteredSkills.map((skill) => (
            <div key={skill.id} className="skill-card">
              <div className="skill-card-main" onClick={() => void open(skill)}>
                <div className="skill-card-title">
                  <strong>{skill.name}</strong>
                  {skill.builtin ? <span className="badge">内置</span> : null}
                  {skill.runnable ? <span className="badge read">子代理</span> : null}
                  {!skill.enabled ? <span className="badge">已停用</span> : null}
                </div>
                <div className="muted" style={{ fontSize: 10.5, lineHeight: 1.5 }}>{skill.description.slice(0, 160)}</div>
                <div className="muted" style={{ fontSize: 10 }}>{skill.id}{skill.version ? ` · v${skill.version}` : ''} · {skill.fileCount} 个文件</div>
              </div>
              <div className="skill-card-actions">
                <input type="checkbox" checked={skill.enabled} onChange={() => void toggle(skill)} title="启用 / 禁用" />
                <button className="btn small" onClick={() => void open(skill)}>查看</button>
                <button className="icon-btn" onClick={() => void remove(skill)} title="卸载"><Trash2 size={12} /></button>
              </div>
            </div>
          ))}
        </div>
        {detail ? (
          <div className="panel" style={{ marginBottom: 10 }}>
            <div className="panel-head">
              {detail.name}
              <span className="badge">{detail.id}</span>
              <div className="spacer" />
              <button className="icon-btn" onClick={() => setDetail(null)}>×</button>
            </div>
            <div style={{ padding: 10 }}>
              <div className="field">
                <label>任务说明（可留空，按 SKILL.md 默认流程执行）</label>
                <textarea
                  className="input"
                  rows={2}
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="例如：用当前 AiDB 报告生成 3 页原生 PPTX，保留关键数字"
                />
              </div>
              <div className="tool-row" style={{ padding: '8px 0 0', border: 0 }}>
                <button className="btn primary" onClick={() => void startRun(detail)} disabled={starting || run?.status === 'running'}>
                  {starting || run?.status === 'running' ? <Loader2 size={12} className="spin" /> : <Play size={12} />}
                  运行 Skill Worker
                </button>
                {run?.status === 'running' ? (
                  <button className="btn" onClick={() => void cancelRun()}>
                    <Square size={11} /> 取消
                  </button>
                ) : null}
                <span className="muted" style={{ fontSize: 10 }}>使用当前模型与 api key；运行过程不进入主会话上下文。</span>
              </div>
            </div>
            {secrets.declared.length ? (
              <div style={{ padding: '0 10px 8px' }}>
                <div className="muted" style={{ fontSize: 10, marginBottom: 4 }}>密钥（加密保存，仅运行时注入）</div>
                {secrets.declared.map((name) => (
                  <div key={name} className="tool-row" style={{ padding: '3px 0', border: 0 }}>
                    <span className="mono" style={{ width: 190, fontSize: 10 }}>{name}{secrets.set.includes(name) ? ' ●' : ''}</span>
                    <input
                      className="input"
                      type="password"
                      value={secretDraft[name] ?? ''}
                      onChange={(e) => setSecretDraft((current) => ({ ...current, [name]: e.target.value }))}
                      placeholder={secrets.set.includes(name) ? '已设置，留空保持不变' : '未设置'}
                    />
                    {secrets.set.includes(name) ? (
                      <button className="btn small" onClick={() => void clearSecret(name)}>清除</button>
                    ) : null}
                  </div>
                ))}
                <div className="row" style={{ justifyContent: 'flex-end', marginTop: 4 }}>
                  <button className="btn small" onClick={() => void saveSecrets()}>保存密钥</button>
                </div>
              </div>
            ) : null}
            {templateGroups.length ? (
              <div style={{ padding: '0 10px 8px' }}>
                <div className="muted" style={{ fontSize: 10, marginBottom: 4 }}>模板（点击填入任务）</div>
                {templateGroups.map((group) => (
                  <div key={group.kind} className="tool-row" style={{ padding: '3px 0', border: 0, flexWrap: 'wrap', alignItems: 'center' }}>
                    <span className="muted" style={{ width: 52, fontSize: 10 }}>{group.kind}</span>
                    {group.names.slice(0, 40).map((name) => (
                      <button
                        key={name}
                        className="badge"
                        style={{ cursor: 'pointer', border: '1px solid var(--border)', background: 'var(--bg-inset)' }}
                        onClick={() => setPrompt((current) => `使用 templates/${group.kind}/${name} 模板。\n${current}`.trim())}
                        title={`填入：${name}`}
                      >
                        {name}
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            ) : null}
            <div style={{ maxHeight: 240, overflow: 'auto', padding: 8 }}>
              {detail.files.slice(0, 120).map((file) => (
                <div key={file.path} className="muted" style={{ fontSize: 10 }}>
                  {file.type === 'directory' ? '▸ ' : '· '}{file.path}{file.size ? ` (${file.size}B)` : ''}
                </div>
              ))}
            </div>
            <pre
              className="mono"
              style={{ margin: 0, padding: 8, maxHeight: 320, overflow: 'auto', background: 'var(--bg-inset)', fontSize: 10, whiteSpace: 'pre-wrap' }}
            >
              {detail.body ?? ''}
            </pre>
          </div>
        ) : null}
        {run ? (
          <div className="panel">
            <div className="panel-head">
              Skill 运行
              <span className={`badge ${run.status === 'failed' ? 'danger' : ''}`}>{run.status}</span>
              <span className="muted mono" style={{ fontSize: 10 }}>{run.runId}</span>
              <div className="spacer" />
              {run.status === 'running' ? (
                <button className="btn small" onClick={() => void cancelRun()}><Square size={10} /> 取消</button>
              ) : null}
            </div>
            {question ? (
              <div style={{ margin: 10, padding: 10, border: '1px solid var(--accent)', borderRadius: 6, background: 'var(--bg-inset)' }}>
                <div style={{ fontWeight: 600, marginBottom: 6 }}>{question.question}</div>
                {question.options?.length ? (
                  <div className="tool-row" style={{ padding: '0 0 6px', border: 0, flexWrap: 'wrap' }}>
                    {question.options.map((option) => (
                      <button key={option} className="btn small" onClick={() => { setAnswerText(option); }}>
                        {option}
                      </button>
                    ))}
                  </div>
                ) : null}
                <div className="tool-row" style={{ padding: 0, border: 0 }}>
                  <input
                    className="input"
                    value={answerText}
                    onChange={(e) => setAnswerText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void replyQuestion();
                    }}
                    placeholder="回答后 Worker 继续"
                  />
                  <button className="btn primary" onClick={() => void replyQuestion()} disabled={!answerText.trim()}>回答</button>
                </div>
              </div>
            ) : null}
            {outputFiles.length ? (
              <div style={{ padding: 10, borderBottom: '1px solid var(--border)' }}>
                <div className="muted" style={{ fontSize: 10, marginBottom: 4 }}>产物</div>
                {outputFiles.map((file) => (
                  <div key={`${file.area}/${file.path}`} className="tool-row" style={{ padding: '2px 0', border: 0 }}>
                    <span className="mono" style={{ flex: 1, fontSize: 10 }}>{file.area}/{file.path} <span className="muted">{file.size ?? 0}B</span></span>
                    <button className="btn small" onClick={() => void saveOutput(file.area, file.path)} title="另存为">
                      <Save size={10} /> 保存
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
            <div className="mono" style={{ maxHeight: 260, overflow: 'auto', padding: 10, fontSize: 10, whiteSpace: 'pre-wrap', borderBottom: '1px solid var(--border)' }}>
              {events.length ? events.map((event, index) => {
                const summary = eventSummary(event);
                if (!summary) return null;
                const tone = event.type === 'error' || (event.type === 'tool_result' && !event.result.ok) ? 'var(--danger)' : 'inherit';
                return (
                  <div key={index} style={{ color: tone }}>
                    <span className="muted">[{EVENT_LABELS[event.type] ?? event.type}]</span> {summary}
                  </div>
                );
              }) : <span className="muted">等待事件…</span>}
            </div>
            <pre
              className="mono"
              style={{ margin: 0, padding: 10, maxHeight: 320, overflow: 'auto', background: 'var(--bg-inset)', fontSize: 10, whiteSpace: 'pre-wrap' }}
            >
              {text || run.text || '（最终答复会显示在这里）'}
            </pre>
          </div>
        ) : null}
      </div>
    </div>
  );
}
