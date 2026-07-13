# MyJavis 外部协作架构文档

**版本**:v1.0
**维护人**:项目 Owner(下文简称"我")
**适用范围**:MyJavis 项目与实习生/外部贡献者的全部协作活动
**当前协作线**:视觉感知(myjavis-vision)
**文档定位**:本文档是协作的唯一权威规范。所有仓库、权限、流程变更须先更新本文档。

---

## 0. 设计总纲:三条第一性原则

本架构的一切细节都从以下三条原则推导,遇到文档未覆盖的新情况时,按原则裁决:

**原则一:隔离靠结构,不靠自觉。**
安全性必须由权限结构和网络边界保证,而不是由"大家小心一点"维持。任何依赖人为纪律的隔离方案都视为未隔离。

**原则二:核心以服务/制品形态存在,永不以源码形态流出。**
外部贡献者接触 core 的唯一方式是网络端点(staging 服务)和契约文档(contracts)。不存在任何场景需要向外部分发 core 的源码、Docker 镜像或可反编译的打包产物。

**原则三:白名单增量,不做黑名单减量。**
所有面向外部的仓库从空白开始、白名单式填充内容。永远不从 core 复制、fork、filter 历史后"删除敏感部分"——历史删不干净,且无法证明删干净了。

**价值切分标准(判断某模块归 core 还是 contrib)**:
> 这段代码给竞品看到,他能省掉多少试错时间?
> 照公开文档能写出来的 → contrib;踩坑调参后才有的答案 → core。

---

## 1. 仓库版图

### 1.1 组织结构

所有仓库统一放在 GitHub Organization 下(免费版即可),不使用个人账号仓库。原因:org 提供仓库级成员管理,外部协作者(outside collaborator)只被授权到具体仓库,在成员列表里看不到其他仓库的存在。

```
github.com/your-org/
│
├── myjavis-core            # 核心仓(现有仓库改名而来,永不加第二个协作者)
│   ├── kernel/             #   DRAFT/COMMIT 状态机、CQRS 事件溯源
│   ├── orchestrator/       #   级联编排、turn detection、barge-in 策略
│   ├── engine/             #   Experience Engine 路由与降级决策(Tier A/B/C)
│   ├── prompts/            #   系统 prompt、语义端点检测 prompt
│   ├── configs/            #   上游凭证模板、延迟预算参数
│   ├── contracts/          #   ★ 全部接口契约的唯一源头(Source of Truth)
│   │   ├── vision/         #     视觉感知契约
│   │   ├── adapter/        #     (未来)Experience Adapter 契约
│   │   └── CONTRACT_VERSION
│   ├── release/            #   app 组装定义(见 §6,初期不独立成仓)
│   │   ├── compose.yaml
│   │   ├── versions.lock
│   │   ├── build.sh
│   │   └── smoke/
│   └── scripts/
│       └── sync-contracts.sh  # 契约单向同步脚本
│
├── myjavis-vision          # 视觉感知服务(实习生 A 完整拥有)
│   ├── contracts/          #   只读副本,从 core 单向同步,CODEOWNERS=我
│   ├── capture/            #   摄像头/视频文件接入
│   ├── pipeline/           #   检测、跟踪、VLM 推理
│   ├── emitter/            #   PerceptionEvent 封装与推送
│   ├── bench/              #   数据集、精度/延迟评测
│   ├── replay/             #   录像回放回归测试工具(golden events)
│   ├── mock/               #   哑接收端(schema 校验 + 打日志)
│   └── CLAUDE.md           #   只写本仓规范与契约用法,不写内核设计
│
└── myjavis-<line>          # (未来)每条新协作线一个独立仓,同构复制
    例:myjavis-adapters(RTC/TEN 适配)、myjavis-eval(评测工具)、
       myjavis-webui(前端面板)……
```

### 1.2 仓库定位速查

| 仓库 | 定位 | 协作者 | 历史来源 |
|---|---|---|---|
| myjavis-core | 全部核心资产 + 契约源头 + app 组装定义 | 只有我(Admin) | 现有仓库原地改名,历史保留 |
| myjavis-vision | 视觉感知独立服务 | 实习生 A(Write) | 空仓从零开始 |
| myjavis-\<line\> | 未来各协作线 | 对应实习生(Write) | 空仓从零开始 |

### 1.3 关于 myjavis-app 是否独立成仓

app 组装定义(versions.lock、compose、build 脚本、smoke 测试)**初期作为 core 仓的 `release/` 目录**。仅当出现"需要让实习生调试组装后行为、看到打包脚本"的需求时,才拆为独立的 `myjavis-app` 仓单独授权。在此之前不拆,减少仓库数量与 secret 暴露面(app 构建 secret 能拉 core 镜像,见 §7.2)。

---

## 2. 权限矩阵

### 2.1 仓库权限

| 角色 | myjavis-core | myjavis-vision | myjavis-\<future\> |
|---|---|---|---|
| 我 | Admin | Admin | Admin |
| 实习生 A(视觉) | **无权限,不知道仓库存在** | Write | 无 |
| 实习生 B(未来线) | 无 | 无 | Write |
| CI 机器人 / PAT | Actions | 仅 contracts 同步写入 | 同左 |

权限规则:
- 实习生一律 **Write**,不给 Maintain(Maintain 可改仓库设置)、不给 Admin。
- 实习生之间的仓库默认互不可见。若两条线需要协作(如视觉事件供前端面板消费),通过 contracts + staging 端点协作,不通过互开仓库权限。
- 所有面向实习生的仓库开启:main 分支保护、Require pull request review(reviewer=我)、Require status checks(CI 必绿)。

### 2.2 制品(GHCR)权限

| 对象 | vision 镜像 | core 镜像 | app 交付物 |
|---|---|---|---|
| 实习生(经 vision 仓 CI 的 GITHUB_TOKEN) | push + pull | **无** | 无 |
| 我 / core CI / app 构建 | pull | push + pull | push + pull |

GHCR 私有包默认只关联所属仓库,vision 仓的 `GITHUB_TOKEN` 天然拉不到 core 镜像,无需额外配置——这是制品层隔离的基石,**任何时候不要为了"方便联调"给外部仓库的 CI 配置能访问 core 包的 PAT**。

### 2.3 云端资源权限

| 资源 | 实习生可见/可用 | 说明 |
|---|---|---|
| staging core 服务端点 | ✅ 仅端点 URL | wss/gRPC 契约端点,内部黑盒 |
| 实习生专属 API key | ✅ 本人持有 | 独立发放、独立配额、可随时吊销 |
| 重新部署本人容器的 webhook | ✅(可选) | 只能触发"重启 vision 容器"这一个动作 |
| staging 服务器 SSH / 控制台 | ❌ | |
| 生产环境一切 | ❌ | |
| 我的上游 provider 凭证 / 代理路由配置 | ❌ | |

---

## 3. 契约体系(Contracts):唯一的协作界面

契约是整个架构中**我唯一需要亲自做重的部分**。契约质量决定了实习生能否独立工作、以及隔离边界是否清晰。

### 3.1 基本规则

1. **单一源头**:所有契约只在 `myjavis-core/contracts/` 编写和修改。各协作仓中的 `contracts/` 是只读副本。
2. **单向同步**:core → 协作仓,通过 `scripts/sync-contracts.sh`(rsync + commit + push)手动触发;变更频繁后再升级为 GitHub Action(使用只有 contracts 写权限的 fine-grained PAT)。
3. **副本保护**:每个协作仓中 `contracts/` 目录设 CODEOWNERS 指向我。实习生的 PR 若触碰该目录,必须我批准。
4. **版本锚点**:`CONTRACT_VERSION` 文件随契约走。所有服务(core staging、vision 服务)启动时上报自己实现的契约版本,握手时互相校验,不匹配直接报错拒连。app 组装期同样校验(见 §6)。

### 3.2 契约内容要求

一份合格的契约包含四部分,缺一不可:

| 部分 | 内容 | 反例(不合格) |
|---|---|---|
| 格式契约 | 消息 schema、字段类型、枚举值 | 只有 proto 文件没有语义说明 |
| 语义契约 | 每个事件在什么条件下发出、消费方可假设什么 | "视线切换时上报"却不定义"切换"的判定 |
| 时序契约 | 时间戳规范、时钟对齐握手、事件顺序保证 | 不带单调时钟戳,融合期对不上音频轴 |
| 精度契约 | 延迟上限、误报率、置信度语义 | 无验收指标,review 只能看实现 |

### 3.3 视觉线契约:PerceptionEvent 三层结构

```
L0 状态心跳:   人在/不在、注意力朝向          (低频持续, 如 1Hz)
L1 离散事件:   手势触发、视线切换、人员进出    (事件驱动)
L2 语义描述:   VLM 场景/物体描述 + 置信度     (按需或低频)
```

- **只传语义事件,不传帧、不传 embedding**。原始帧永不离开 vision 服务,隐私边界与带宽问题一并解决。
- core 侧订阅哪些层级、如何融合进对话状态,属于核心逻辑,**不写入契约、不向实习生解释**。契约只定义"有什么可订阅"。
- 精度契约示例:L1 手势事件端到端延迟 ≤ 200ms,误触发 ≤ x 次/小时——这同时是实习生的 bench 目标和我的验收标准。

### 3.4 契约变更流程

```
需求出现 → 我在 core/contracts/ 修改 + CONTRACT_VERSION 递增
        → 跑 sync-contracts.sh 同步到协作仓
        → 协作仓自动出现契约更新 commit
        → 实习生按新契约适配,PR 中注明 "implements contracts vX.Y"
```

实习生对契约有修改意见:在协作仓开 issue 讨论 → 我裁决 → 我在 core 侧修改。**实习生从消费者视角评审契约初稿是被鼓励的**(也是考察工程判断力的机会),但修改权始终在我。

---

## 4. 开发与测试:三层金字塔

### 4.1 分层定义

| 层级 | 占比 | 环境 | 依赖 | 谁执行 |
|---|---|---|---|---|
| L1 本地回放测试 | ~80% | 实习生本机 | 零外部依赖 | 实习生,随时 |
| L2 staging 联调 | ~15% | 我的 VPS staging | 端点 + 本人 key | 实习生,随时 |
| L3 全链路验收 | ~5% | 我的环境 | 真实上游 + 真实内核 | 只有我 |

### 4.2 L1:回放测试(replay harness)

实习生开发的主战场,也是每条协作线的**第一个任务**:

```bash
replay run video.mp4 --assert golden.json
# 输入标注视频 → 断言产出的事件序列与 golden events 一致
```

- 测试数据:公开数据集 + 实习生自录素材。**禁止使用我或公司的任何真实场景录像。**
- contrib 仓 CI 跑的就是这一层(lint + 单测 + 回放回归),零 secret。
- 配套一个哑接收端(`mock/`):只校验 schema、打日志,让 emitter 链路可以本地闭环。

### 4.3 L2:staging 联调

- 我在 VPS 上维护一个**常青 staging**:core 以服务形态部署,暴露契约端点(如 `/perception/ingest`、`wss://staging.../session`)。
- staging 使用**降配的真实内核**:上游模型可换便宜的,但编排逻辑必须是真的,否则联调无意义。
- 融合逻辑尚未就绪时,ingest 端点可以先是哑实现(收下、校验、打日志)——实习生已可验证真实网络路径;融合逻辑上线后他无需改任何东西。
- 实习生 key:独立发放、每日配额限流、用量单独计量、可随时吊销。压测需求单独约时间窗口开闸。
- staging 日志脱敏:不向外回传内部状态细节。

### 4.4 L3:全链路验收

实习生版本进入 versions.lock 前,由我在自己环境拉起完整链路(真实上游、真实延迟预算)验证。结果以 PR comment / issue 形式反馈,附 smoke 报告。

### 4.5 集成测试自动化(可选,做不做都安全)

**关键安全规则:面向实习生的仓库的 CI 里,永远不放 staging 地址之外的任何 secret。**
原因:实习生有 Write 权限即可修改 workflow 文件,GitHub Secrets 防得住读仓库的人,防不住能改 workflow 的人。

若需要"PR 自动跑 staging 集成测试":

```
vision PR 打上 label "needs-integration"
   → core 仓的 workflow 监听该事件(workflow 只有我能改)
   → checkout vision 的 PR 分支
   → 用 core 仓持有的 secret 连 staging 跑集成
   → 结果以 comment 回帖到 vision PR
```

简化替代:key 本来就发给了实习生本人,他本地手动连 staging 即可,CI 只保留 L1。安全性等价,只是少了自动化。

---

## 5. 日常协作流程

### 5.1 实习生的一天

```
1. git clone myjavis-vision && docker compose up mock     # 5 分钟起环境
2. feature 分支开发 → 对 replay harness 调试 → 单测绿
3. 需要真实联调:配置指向 staging + 本人 key,验证真实事件流
4. 提 PR → CI(L1)绿 → 我 review → merge
5. merge 即自动构建镜像推 GHCR → staging 更新 → 他立刻能看到
   自己的改动在真实链路中的表现
6. 之后的集成/打包/部署对他透明,下个迭代收到真机数据反馈
```

### 5.2 PR 规范

- 一个 PR 对应一个 contract 能力点或一个 bench 指标改进,禁止巨型 PR。
- PR 描述必须写明:实现的契约版本、影响的事件层级(L0/L1/L2)、bench 数据前后对比。
- Review 视角:**看指标、看契约符合度、看代码质量,不讨论 core 如何消费这些事件。**

### 5.3 任务分派模板

所有任务定义为"实现/改进某个契约能力",而非开放式探索。视觉线的参考序列:

| 阶段 | 任务 | 目的 |
|---|---|---|
| 第 1–2 周 | 契约评审(消费者视角提意见)+ replay harness | 建立测试底座,同时考察工程判断与保密意识 |
| 第 2–4 周 | L0/L1 基础管线(人员检测、注意力朝向、2–3 个手势) | 现成模型(YOLO 系/MediaPipe),重点看事件化质量与指标达标 |
| 第 4–6 周 | L2 VLM 描述 + staging 联调 | 打通真实链路 |
| 之后 | 精度攻坚 或 RK3588 边缘移植(RKNN 检测 + 小 VLM) | 按产品优先级;边缘移植同样不触碰 core |

**前两个任务是观察期**:代码质量和保密意识确认后,再进入接近契约边界的任务。

---

## 6. 打包、集成与发布

### 6.1 核心理念

**集成发生在制品层,不发生在源码层。**
每个仓库独立产出版本化镜像;"打包 app"= 按版本清单组装制品。app 的每个版本本质上是 `versions.lock` 的一次 commit:

```yaml
# core/release/versions.lock
core:   v1.4.2
vision: v0.3.1
client: v0.9.0
```

由此获得:回滚 = revert 一个文件;追查"哪次集成引入问题" = git blame 一个文件。

### 6.2 三段流水线

```
[vision 仓, 实习生, 全自动]
  merge → CI 构建镜像 → 推 GHCR
  tags: v0.3.1(git tag 触发的正式版) + main-<sha>(每次 merge)
  镜像内嵌 CONTRACT_VERSION,启动时上报

[core 仓, 我, 全自动]
  merge → CI 构建 → 推 GHCR(同上)

[app 组装, 我, 一条命令]
  ./build.sh                        # 读 lock → 拉镜像 → 契约版本互校
                                    # → 起临时环境跑 smoke → 出交付物
  ./build.sh --vision main-a3f8c2   # 临时覆盖试新版本,不动 lock
  # 验证 OK → 更新 lock + commit,这才算"完成一次集成"
```

- smoke 测试:回放几段标准会话 + 视觉事件,断言端到端行为。
- **build 全程控制在 5 分钟内**(镜像分层缓存优化),这个速度决定敢不敢高频跑。
- 交付物形态:服务端 + Web → compose bundle + `deploy.sh staging|prod`;有客户端壳 → client 构建时烧入端点配置,产出安装包。client 只是薄接入层,核心逻辑全部在 core 镜像内。

### 6.3 视觉线的集成方向:消费镜像,不回流源码

vision 的交付物 = **Docker 镜像 + 契约版本号**。core 仓不含视觉实现源码,不做 subtree pull——事故面(把外部 git 历史混入 core)从结构上不存在。
仅在"收编"场景(实习生转正/离职、项目内化)才做一次性**代码审计式合并**。

### 6.4 实习生与"完整 app"

- **九成场景他不需要完整 app**:staging 常青即最新集成版,他的闭环是 vision → staging ingest。
- **一成场景需看整机行为**(如调 UI 上的视觉反馈):给**编译后的安装包或部署好的实例使用权,不给组装能力**。
- 若 core 为 Python 等源码随镜像走的技术栈:连打包后的服务端 bundle 都不给,只给远程实例。

---

## 7. 安全纪律

### 7.1 源码与历史

1. core 仓永不加第二个协作者,永不 fork / mirror / template。
2. 新协作仓一律空仓起步、白名单填充当前文件;**禁止** `git filter-repo` / subtree split 从 core 提取历史(早期 commit 混有核心设计讨论,丢历史是最干净的)。
3. 初始填充后必查:`grep -ri "内核|orchestrator|draft.*commit|路由|prompt"`;确认无 `.env`、`.claude/`、密钥、隐藏文件混入。
4. 历史探索性 demo(如眼动+手势 demo)**不直接搬**:先由我消化进契约设计或整理成干净参考实现,再决定是否以示例形式放入——demo 里的思路注释和内核联动痕迹等于泄露设计过程。

### 7.2 密钥与配置

1. 实习生凭证独立发放:专属 key、独立配额、随时可吊销。
2. 我的上游 provider 凭证、代理/路由配置、生产配置,一律只存在于 core 与我的环境。
3. `.env.example` 只含协作仓所需变量。
4. 外部仓 CI 零核心 secret(见 §4.5);app 构建 secret(可拉 core 镜像)只存在于 core 仓,故 app 定义所在仓库不向实习生开放。

### 7.3 AI 编码工具(双方都在用,新的泄露面)

1. 协作仓 `CLAUDE.md` 只写本仓规范与契约用法,**不引用、不解释核心架构设计思路**。
2. 我在 core 工作时的 `.claude/`、MCP 配置、settings 不得 commit 进任何协作仓。
3. 默认假设:协作仓里的每个字都会进入实习生所用第三方模型的上下文——因此连"核心模块长什么样"的注释都不该出现。

### 7.4 口头与协作纪律

1. 结对/讨论只讲契约语义("检测到视线切换上报 L1"),不讲内核消费方式("core 收到后如何调整打断预算")。融合策略是最后的护城河。
2. 期望行为描述止步于契约;精度目标用 bench 指标表达,不用内核行为解释。

### 7.5 离场与事故响应

**实习生离职 checklist**(15 分钟内完成):
- [ ] 移除协作仓 collaborator 权限
- [ ] 吊销其 API key、webhook token
- [ ] GHCR 侧确认其 push 权限随仓库权限失效
- [ ] staging 轮换端点凭证(若曾共享)
- [ ] 其未合并分支由我接管评估

**疑似泄露响应**:立即吊销所有该协作线凭证 → 审计 staging 用量日志(key 单独计量的价值)→ 评估暴露面(结构上应仅限:契约 + 协作仓源码 + staging 端点行为)→ 契约本身按"可被看到"设计,泄露契约不构成核心损失。

---

## 8. 扩展新协作线 SOP

未来每加一条协作线(新实习生/新能力域),按此清单执行,约半天:

```
□ 1. 价值切分:用 §0 标准划定该线的 core / contrib 边界
□ 2. 契约先行:在 core/contracts/<line>/ 写出四要素齐全的契约 v0.1(§3.2)
□ 3. 建空仓 myjavis-<line>:org 下 private 空仓,白名单填充
      (contracts 副本 + 脚手架 + mock/哑接收端 + 本仓 CLAUDE.md)
□ 4. 泄露检查:§7.1 第 3 条
□ 5. 仓库规则:main 保护 / Require PR review / CI 必绿 / contracts 目录 CODEOWNERS=我
□ 6. staging 开对应契约端点(初期可为哑实现)
□ 7. 发放独立凭证:key + 配额 + (可选)重部署 webhook
□ 8. CI:本仓构建推 GHCR(v* + main-<sha> 双 tag,内嵌 CONTRACT_VERSION)
□ 9. versions.lock 增加该线条目,build.sh/smoke 覆盖新制品
□ 10. 邀请实习生(Write),布置第一个任务:契约评审 + 测试底座(观察期)
```

**协作线之间的关系**:默认互不可见。跨线协作(如前端面板消费视觉事件)一律通过契约 + staging 端点,不通过互开仓库。

---

## 9. 附录

### A. 一次性迁移操作(从现状到本架构)

```bash
# 1. 现有仓库改名(GitHub 自动重定向旧地址)
#    GitHub UI: rename → myjavis-core;建议同时迁入 org
git remote set-url origin git@github.com:your-org/myjavis-core.git

# 2. 建空仓并白名单填充
mkdir ~/myjavis-vision && cd ~/myjavis-vision && git init
#    仅复制:相关 contracts 当前文件、通用 lint/.editorconfig
grep -ri "内核\|orchestrator\|draft.*commit\|路由\|prompt" . \
  --include="*.md" --include="*.py"        # 泄露检查
ls -la                                      # 确认无隐藏文件混入
git add . && git commit -m "init: perception service scaffold + contracts v0.1"
git remote add origin git@github.com:your-org/myjavis-vision.git
git push -u origin main

# 3. core 侧同步脚本 scripts/sync-contracts.sh
rsync -av --delete contracts/vision/ ~/myjavis-vision/contracts/
cd ~/myjavis-vision && git add contracts \
  && git commit -m "contracts: sync from core vX.Y" && git push
```

### B. 高频命令速查

| 场景 | 命令 |
|---|---|
| 契约变更下发 | `./scripts/sync-contracts.sh` |
| 打包 app(按 lock) | `./release/build.sh` |
| 试实习生最新版 | `./release/build.sh --vision main-<sha>` |
| 正式集成 | 验证绿 → 改 versions.lock → commit |
| 回滚 | `git revert <lock-commit>` → 重新 build |
| 部署 | `./release/deploy.sh staging\|prod` |

### C. 责任分工一览

| 事项 | 我 | 实习生 |
|---|---|---|
| 契约定义与变更 | ✅ 唯一修改权 | 消费者视角提意见 |
| 协作仓代码 | Review + merge | 开发 + PR |
| L1 回放测试 | 定验收指标 | 建设 + 日常执行 |
| staging 运维 | ✅ | 仅作为客户端使用 |
| L3 全链路验收 | ✅ | — |
| versions.lock / 打包 / 部署 | ✅ | 透明,不参与 |
| 凭证发放与吊销 | ✅ | 保管本人 key |

---

*本文档随架构演进更新,更新记录写入 core 仓 git 历史。*

---

## 10. 变更记录

### v1.1(2026-07-08,Owner 拍板,覆盖正文对应条款)

1. **core 仓不迁 org、不改名**(覆盖 §1.1"不使用个人账号仓库"、§1.2 表首行、§9.A step 1):core = Owner 个人账号仓 `MyJavis`,原地保留。理由:core 永不加协作者,留在个人账号隔离性更强——协作者在 org 成员视角下连 core 的存在都看不到。协作仓(myjavis-vision 及未来各线)统一放 org `FUTURUS-ProductResearch`。
2. **GitHub 计划:使用免费版**(实测 2026-07-08:免费版 org **私有仓**的分支保护与 Ruleset 均被 403 拒,需 Pro/公开仓)。因此 §2.1 的"main 分支保护 / Require PR review"在免费版不可强制,对策:
   - 流程纪律:协作仓 CLAUDE.md/README 明写"一律走 PR,禁止直推 main",入职宣讲;
   - 审计兜底:Owner 定期查 main 直推记录(`git log --first-parent main`,非 merge commit 即违规);
   - 损失面评估:协作仓即使被直推破坏,可 revert;核心资产全部在 core,结构隔离不受影响(原则一仍成立)。
3. **契约 v0.1 已立**:`contracts/vision/`(四要素)+ `CONTRACT_VERSION`(vision=0.1.0)+ `scripts/sync-contracts.sh`;协作仓 myjavis-vision 已按 §8 SOP 建立(白名单填充 + 泄露自查零命中 + 零 secret CI)。

### v1.2(2026-07-09,Owner 拍板:视觉线端侧集成形态)

1. **vision 运行位 = 端侧**(适配 §6.2/§6.3 的"镜像部署"假设):视觉感知需采本机摄像头,生产运行位是用户端(macOS app,未来 RK3588 边缘盒),VPS staging 仅为契约联调环境,不是运行位。
2. **交付物形态 = 单二进制可执行体,作为 Tauri sidecar 随 MyJavis.app 分发**:app 启动时拉起 sidecar,本地采帧、本地推理,只对外产出 PerceptionEvent——"原始帧永不离开本机"由进程边界结构化保证(原则一)。技术栈选型硬约束:必须能编译/打包为单个可执行文件(Go/Rust 原生,Node 可 pkg/SEA,Python 可 PyInstaller,实习生自选)。
3. **CI 制品走 GitHub Releases 替代 GHCR**(免费私有仓可用):`v*` tag → Release 附二进制,日常 merge 用 Actions artifact(`main-<sha>` 语义)。隔离等价:vision 仓 `GITHUB_TOKEN` 天然只能发本仓 Release,拉不到 core 任何东西(§2.2 精神不变)。
4. **app 组装落地版**(§6.2 三段流水线适配 MyJavis 现实=pm2+rsync+Tauri dmg 而非 compose):core 仓 `release/`(versions.lock + build.sh + smoke)**于 vision 首个 v0.1 tag 后建立**;build.sh = 读 lock → 拉 vision Release 附件 → CONTRACT_VERSION 互校 → 塞入 Tauri bundle(externalBin)→ smoke → 接现有 release-app.sh 出 dmg + 自动更新。回滚仍 = revert lock 一个文件。
5. §6.4 不变:实习生九成场景不需要完整 app;需看整机行为时给编译后的 dmg,不给组装能力。
