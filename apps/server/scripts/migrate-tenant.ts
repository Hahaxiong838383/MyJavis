/**
 * 多租户迁移（批次A，幂等可重跑）：
 * 1. 若不存在名为 OWNER_NAME 的租户则创建（川哥的主租户）；
 * 2. 把 tenant_id 为空的存量声纹全部归给该租户；
 * 3. 打印租户 id + token（token 供 App 设置页激活用）。
 * 跑法：npm run migrate:tenant（生产：node dist/../ 用 tsx 或部署后跑 dist 版）
 */
import { createTenant, listTenants } from '../src/tenant/registry.js';
import { storage } from '../src/memory/index.js';

const OWNER_NAME = process.env.MIGRATE_OWNER_NAME ?? '川哥';

const existing = listTenants().find((t) => t.name === OWNER_NAME);
const owner = existing ?? createTenant(OWNER_NAME);
console.log(`${existing ? '已存在' : '已创建'}主租户: id=${owner.id} name=${owner.name} token=${owner.token}`);

const res = storage.db.prepare(`UPDATE voiceprint SET tenant_id = ? WHERE tenant_id = '' OR tenant_id IS NULL`).run(owner.id);
console.log(`存量声纹归属: ${res.changes} 条 → ${owner.id}`);
console.log(`\n提示: 把 DEFAULT_ADMIN_TENANT=${owner.id} 写入 .env（admin key 调业务端点时的默认租户，兼容现有 App）`);
