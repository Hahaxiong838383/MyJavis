# staging 哑端点(契约 §4.3 初期形态)

收下 → 契约校验(必填/type/主版本)→ JSONL 计量日志。Bearer key 鉴权 + 每日配额 + keys.json 热加载(改文件即生效,吊销=删行)。

部署位:47.239 `/opt/myjavis-staging/`,pm2 `myjavis-staging-perception`(:3002,仅 127.0.0.1),
nginx `javis.chenchuan.cc` 443 block 加 `location ^~ /staging/ → 127.0.0.1:3002/`(strip 前缀)。

- 端点:`POST https://javis.chenchuan.cc/staging/perception/ingest`(Bearer key)
- 健康:`GET https://javis.chenchuan.cc/staging/health`
- 真 keys.json 只在服务器(600),不入 git;样例见 keys.example.json。
