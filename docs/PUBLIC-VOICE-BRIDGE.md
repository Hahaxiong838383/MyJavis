# MyJavis_ccsite 个人站公开语音服务

> 分支：`MyJavis_ccsite`。该分支只复用 MyJavis 的 RTC / ASR / TTS / LLM 技术栈，独立部署、独立进程、独立环境变量，禁止合并到 MyJavis `main`，也不替换现有 `myjavis-server`。

## 边界

- 浏览器只拿一次性 RTC 入房参数，不持有 MyJavis 控制密钥。
- 个人站 BFF 使用 `PUBLIC_VOICE_SHARED_SECRET` 调 `/public-voice/*`。
- 公开会话固定 `public-mirror-*` 房间，最长 120 秒，默认最多 2 路并发。
- 公开会话不加载或写入长期记忆，不启用声纹、提醒、音乐和设备控制。
- 日志只记房间、阶段、时延和 prompt 版本，不记访客原话或回答正文。
- 生产必须设置 `PUBLIC_VOICE_ONLY=1`；此模式不挂载私有 `/api/*` 路由，也不启动提醒调度器和记忆精修器。

## 环境变量

```bash
PUBLIC_VOICE_ENABLED=0
PUBLIC_VOICE_ONLY=1
PUBLIC_VOICE_SHARED_SECRET=
PUBLIC_VOICE_MAX_SECONDS=120
MAX_PUBLIC_VOICE_ROOMS=2
SERVICE_NAME=myjavis-ccsite
```

共享密钥只存在 MyJavis 与个人站生产环境文件中，权限 `600`，不得进入 Git、日志或前端包。

## 独立部署

- 目录：`/opt/myjavis-ccsite`
- PM2：`myjavis-ccsite`
- 端口：`3003`（仅回环监听）
- 公网前缀：`https://javis.chenchuan.cc/ccsite/`
- 个人站 BFF base URL：`https://javis.chenchuan.cc/ccsite`
- 火山回调：`https://javis.chenchuan.cc/ccsite/v1/chat/completions`

现有 `/opt/myjavis`、PM2 `myjavis-server`、`javis.chenchuan.cc` 根路径和私有数据目录不得修改。

## 接口

| 接口 | 用途 |
|---|---|
| `GET /public-voice/status` | BFF 健康与活跃会话数 |
| `POST /public-voice/start` | 使用可信服务端 prompt 创建公开 RTC 会话 |
| `POST /public-voice/stop` | 回收指定公开 RTC 会话 |

三者都要求 `X-Public-Voice-Secret`。浏览器不得直调。

## 故障与回滚

1. 个人站先设 `PUBLIC_VOICE_ENABLED=0`，入口立即降级为不可开始，文字问答不受影响。
2. MyJavis 再设 `PUBLIC_VOICE_ENABLED=0` 并重启，停止创建新公开会话。
3. 已创建会话由 120 秒硬超时回收；站点也会在结束、关页和倒计时归零时调用 stop。
4. MyJavis 进程若在通话中重启，签名回调仍保持无记忆隔离，只提示访客重新连接。

## 验收

```bash
pnpm --filter @myjavis/server typecheck
pnpm --filter @myjavis/server test:public-voice
pnpm --filter @myjavis/server build
```

生产验收必须覆盖：错密钥 `401`、公开会话开始/停止、120 秒回收、私有邀请码通话不回归、公开会话不新增记忆与 event log。
