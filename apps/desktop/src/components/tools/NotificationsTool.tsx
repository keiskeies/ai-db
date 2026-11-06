import { useEffect, useState } from 'react';
import { Bell, Loader2, Plus, Send, Trash2 } from 'lucide-react';
import type { NotificationChannelInfo, NotificationChannelType } from '@aidb/core';
import { api } from '../../lib/api';
import { useApp } from '../../store';
import { askConfirm } from '../AskDialog';
import { SecretInput, Select, Option } from '../ui';
import { t as tr } from '../../i18n';

const TYPE_LABEL: Record<NotificationChannelType, string> = {
  feishu: tr("飞书群机器人"),
  wecom: tr("企业微信群机器人"),
  'qq-onebot': 'QQ（OneBot HTTP）',
  dingtalk: tr("钉钉群机器人"),
  slack: 'Slack',
  discord: 'Discord',
  telegram: 'Telegram',
};

const TYPE_HINT: Record<NotificationChannelType, string> = {
  feishu: tr("飞书群 → 设置 → 群机器人 → 添加自定义机器人，复制 Webhook。"),
  wecom: tr("企业微信群 → 群设置 → 群机器人 → 添加，复制 Webhook。"),
  'qq-onebot': tr("填写 OneBot 实现（NapCat / Lagrange 等）的 HTTP 地址与目标群号。"),
  dingtalk: tr("钉钉群 → 群设置 → 智能群助手 → 添加机器人 → 自定义，复制 Webhook。"),
  slack: tr("Slack App → Incoming Webhooks → 选择频道，复制 Webhook URL。"),
  discord: tr("频道设置 → 整合 → Webhook → 新建 Webhook，复制 URL。"),
  telegram: tr("在 @BotFather 创建 Bot 拿 token；chatId 可用 @channelusername 或数字 ID。"),
};

function defaultChannelName(type: NotificationChannelType): string {
  const names: Record<NotificationChannelType, string> = {
    feishu: tr("飞书数据群"),
    wecom: tr("企微数据群"),
    'qq-onebot': tr("QQ 数据群"),
    dingtalk: tr("钉钉数据群"),
    slack: tr("Slack 数据频道"),
    discord: tr("Discord 数据频道"),
    telegram: tr("Telegram 数据频道"),
  };
  return names[type];
}

export function NotificationsTool() {
  const notify = useApp((s) => s.notify);
  const connections = useApp((s) => s.connections);
  const [channels, setChannels] = useState<NotificationChannelInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [type, setType] = useState<NotificationChannelType>('feishu');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [token, setToken] = useState('');
  const [targetType, setTargetType] = useState<'group' | 'private'>('group');
  const [targetId, setTargetId] = useState('');
  const [botToken, setBotToken] = useState('');
  const [chatId, setChatId] = useState('');
  const [appId, setAppId] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [verificationToken, setVerificationToken] = useState('');
  const [inbound, setInbound] = useState(false);
  const [allowedChats, setAllowedChats] = useState('');
  const [connectionId, setConnectionId] = useState('');
  const [database, setDatabase] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      setChannels((await api.notificationChannels()).channels);
    } catch (err: any) {
      notify('error', tr("读取通知渠道失败"), err?.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const create = async (testAfter = false) => {
    const channelName = name.trim() || defaultChannelName(type);
    const inboundConfig = inbound && (type === 'feishu' || type === 'qq-onebot')
      ? {
          inbound: true,
          allowedChats: allowedChats.split(',').map((value) => value.trim()).filter(Boolean),
          connectionId: connectionId || undefined,
          database: database.trim() || undefined,
        }
      : {};
    const config =
      type === 'qq-onebot'
        ? { endpoint: endpoint.trim(), token: token.trim() || undefined, targetType, targetId: targetId.trim(), ...inboundConfig }
        : type === 'telegram'
          ? { botToken: botToken.trim(), chatId: chatId.trim() }
          : {
              webhookUrl: webhookUrl.trim(),
              ...((type === 'feishu' || type === 'dingtalk') && secret.trim() ? { secret: secret.trim() } : {}),
              ...(type === 'feishu'
                ? {
                    appId: appId.trim() || undefined,
                    appSecret: appSecret.trim() || undefined,
                    verificationToken: verificationToken.trim() || undefined,
                  }
                : {}),
              ...inboundConfig,
            };
    try {
      const { channel } = await api.createNotificationChannel({ name: channelName, type, config });
      if (testAfter) {
        const { result } = await api.testNotificationChannel(channel.id);
        notify(result.ok ? 'success' : 'error', result.ok ? tr("已保存并发送测试消息") : tr("已保存，但测试发送失败"), `${channelName} · ${result.message}`);
      } else {
        notify('success', tr("通知渠道已保存"), `${channelName} · ${TYPE_LABEL[type]}`);
      }
      setName('');
      setWebhookUrl('');
      setSecret('');
      setEndpoint('');
      setToken('');
      setTargetId('');
      setBotToken('');
      setChatId('');
      setAppId('');
      setAppSecret('');
      setVerificationToken('');
      setInbound(false);
      setAllowedChats('');
      setConnectionId('');
      setDatabase('');
      await load();
    } catch (err: any) {
      notify('error', tr("保存通知渠道失败"), err?.message);
    }
  };

  const test = async (channel: NotificationChannelInfo) => {
    setTesting(channel.id);
    try {
      const { result } = await api.testNotificationChannel(channel.id);
      notify(result.ok ? 'success' : 'error', result.ok ? tr("测试消息已发送") : tr("测试发送失败"), result.message);
    } catch (err: any) {
      notify('error', tr("测试发送失败"), err?.message);
    } finally {
      setTesting(null);
    }
  };

  const toggle = async (channel: NotificationChannelInfo) => {
    try {
      await api.updateNotificationChannel(channel.id, { enabled: !channel.enabled });
      await load();
    } catch (err: any) {
      notify('error', tr("更新渠道失败"), err?.message);
    }
  };

  const remove = async (channel: NotificationChannelInfo) => {
    if (!(await askConfirm({ message: tr("删除通知渠道「{0}」？", [channel.name]), danger: true, confirmLabel: tr("删除") }))) return;
    try {
      await api.deleteNotificationChannel(channel.id);
      await load();
    } catch (err: any) {
      notify('error', tr("删除失败"), err?.message);
    }
  };

  return (
    <div className="tool-pane">
      <div className="tool-pane-head">
        <Bell size={15} /> {tr(" 通知渠道 ")}<span className="muted">{tr("飞书 / 企微 / 钉钉 / Slack / Discord / Telegram / QQ · 报告推送")}</span>
      </div>
      <div className="tool-scroll">
        <div className="panel" style={{ padding: 10, marginBottom: 10 }}>
          <div className="panel-head" style={{ paddingLeft: 0 }}>{tr("添加机器人")}</div>
          <div className="row gap-6" style={{ flexWrap: 'wrap', marginBottom: 6 }}>
            {(Object.keys(TYPE_LABEL) as NotificationChannelType[]).map((value) => (
              <button key={value} className={`btn ${type === value ? 'primary' : ''}`} onClick={() => setType(value)}>
                {TYPE_LABEL[value]}
              </button>
            ))}
          </div>
          <div className="muted" style={{ fontSize: 10, marginBottom: 6 }}>{TYPE_HINT[type]}{tr(" Webhook 只需配置一次，之后在下方列表用开关启停；不需要安装 MCP。")}</div>
          <div className="field">
            <label>{tr("名称（可选）")}</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={defaultChannelName(type)} />
          </div>
          {type === 'telegram' ? (
            <div className="tool-row" style={{ padding: 0, border: 0, marginTop: 8 }}>
              <div className="field" style={{ flex: 1 }}>
                <label>Bot Token</label>
                <SecretInput value={botToken} onChange={(e) => setBotToken(e.target.value)} placeholder="123456:ABC…" name="aidb-telegram-bot-token" />
              </div>
              <div className="field" style={{ width: 220 }}>
                <label>Chat ID / @channel</label>
                <input className="input" value={chatId} onChange={(e) => setChatId(e.target.value)} placeholder="-100123…" />
              </div>
            </div>
          ) : type !== 'qq-onebot' ? (
            <>
              <div className="field" style={{ marginTop: 8 }}>
                <label>Webhook URL</label>
                <input className="input" value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)} placeholder="https://…" />
              </div>
              {type === 'feishu' || type === 'dingtalk' ? (
                <div className="field" style={{ marginTop: 8 }}>
                  <label>{tr("签名密钥（可选）")}</label>
                  <SecretInput value={secret} onChange={(e) => setSecret(e.target.value)} name="aidb-notify-sign-secret" />
                </div>
              ) : null}
              {type === 'feishu' ? (
                <details style={{ marginTop: 8 }}>
                  <summary className="muted" style={{ fontSize: 10, cursor: 'pointer' }}>{tr("高级：应用凭证（仅群内 @机器人问答需要）")}</summary>
                  <div className="tool-row" style={{ padding: 0, border: 0, marginTop: 8 }}>
                    <div className="field" style={{ flex: 1 }}>
                      <label>App ID</label>
                      <input
                        className="input"
                        value={appId}
                        onChange={(e) => setAppId(e.target.value)}
                        autoComplete="off"
                        name="aidb-feishu-app-id"
                        data-form-type="other"
                      />
                    </div>
                    <div className="field" style={{ flex: 1 }}>
                      <label>App Secret</label>
                      <SecretInput value={appSecret} onChange={(e) => setAppSecret(e.target.value)} name="aidb-feishu-app-secret" />
                    </div>
                    <div className="field" style={{ flex: 1 }}>
                      <label>Verification Token</label>
                      <SecretInput value={verificationToken} onChange={(e) => setVerificationToken(e.target.value)} name="aidb-feishu-verification-token" />
                    </div>
                  </div>
                </details>
              ) : null}
            </>
          ) : (
            <>
              <div className="field" style={{ marginTop: 8 }}>
                <label>OneBot HTTP endpoint</label>
                <input className="input" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="http://127.0.0.1:3000" />
              </div>
              <div className="row gap-6" style={{ marginTop: 8 }}>
                <div className="field" style={{ flex: 1 }}>
                  <label>{tr("Access Token（可选）")}</label>
                  <SecretInput value={token} onChange={(e) => setToken(e.target.value)} name="aidb-onebot-token" />
                </div>
                <div className="field" style={{ width: 110 }}>
                  <label>{tr("目标")}</label>
                  <Select className="select" value={targetType} onChange={(e) => setTargetType(e.target.value as 'group' | 'private')}>
                    <Option value="group">{tr("群")}</Option>
                    <Option value="private">{tr("私聊")}</Option>
                  </Select>
                </div>
                <div className="field" style={{ width: 140 }}>
                  <label>{tr("群号 / QQ")}</label>
                  <input className="input" value={targetId} onChange={(e) => setTargetId(e.target.value)} />
                </div>
              </div>
            </>
          )}
          {(type === 'feishu' || type === 'qq-onebot') ? (
            <details className="panel" style={{ padding: 8, marginTop: 8 }}>
              <summary className="row gap-6" style={{ alignItems: 'center', fontSize: 11, cursor: 'pointer' }}>
                {tr(" 高级：群内 @机器人问答（inbound） ")}</summary>
              <label className="row gap-6" style={{ alignItems: 'center', fontSize: 11, marginTop: 6 }}>
                <input type="checkbox" checked={inbound} onChange={(e) => setInbound(e.target.checked)} />
                {tr(" 启用 inbound 问答（只读 Agent，按群白名单） ")}</label>
              {inbound ? (
                <div className="tool-row" style={{ padding: 0, border: 0, marginTop: 6 }}>
                  <div className="field" style={{ flex: 1 }}>
                    <label>{tr("允许的会话 ID（逗号分隔；留空=全部）")}</label>
                    <input className="input" value={allowedChats} onChange={(e) => setAllowedChats(e.target.value)} placeholder={tr("群 chat_id / group:123")} />
                  </div>
                  <div className="field" style={{ width: 170 }}>
                    <label>{tr("绑定连接")}</label>
                    <Select className="select" value={connectionId} onChange={(e) => setConnectionId(e.target.value)}>
                      <Option value="">{tr("请选择")}</Option>
                      {connections.map((connection) => <Option key={connection.id} value={connection.id}>{connection.name}</Option>)}
                    </Select>
                  </div>
                  <div className="field" style={{ width: 130 }}>
                    <label>{tr("默认库（可选）")}</label>
                    <input className="input" value={database} onChange={(e) => setDatabase(e.target.value)} />
                  </div>
                </div>
              ) : null}
            </details>
          ) : null}
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
            <button className="btn" onClick={() => void create(false)}>{tr("保存")}</button>
            <button className="btn primary" onClick={() => void create(true)}><Plus size={12} /> {tr(" 保存并发送测试")}</button>
          </div>
        </div>
        <div className="panel">
          <div className="panel-head">{tr("已配置 ")}<span className="badge">{channels.length}</span></div>
          {loading ? <div className="dash-empty"><Loader2 size={14} className="spin" /> {tr(" 读取中…")}</div> : null}
          {!loading && !channels.length ? <div className="dash-empty">{tr("还没有通知渠道。先配置一个飞书/企微群机器人。")}</div> : null}
          {channels.map((channel) => (
            <div key={channel.id} className="transfer-row">
              <span className="badge">{channel.enabled ? 'ON' : 'OFF'}</span>
              <span className="badge">{channel.type}</span>
              <span style={{ flex: 1 }}>
                <strong>{channel.name}</strong>
                <div className="muted" style={{ fontSize: 10 }}>{channel.summary ?? ''}</div>
              </span>
              <button className="btn small" onClick={() => void toggle(channel)}>{channel.enabled ? tr("停用") : tr("启用")}</button>
              <button className="btn small" onClick={() => void test(channel)} disabled={testing === channel.id}>
                {testing === channel.id ? <Loader2 size={11} className="spin" /> : <Send size={11} />}{tr(" 测试 ")}</button>
              <button className="icon-btn" onClick={() => void remove(channel)} title={tr("删除")}><Trash2 size={12} /></button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
