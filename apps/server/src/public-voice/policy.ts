export interface PublicVoicePolicy {
  roomId: string;
  systemPrompt: string;
  promptVersion: string;
  createdAt: number;
  expiresAt: number;
  capabilities: {
    memory: false;
    voiceprint: false;
    reminders: false;
    music: false;
  };
}

const policies = new Map<string, PublicVoicePolicy>();

function publicVoiceSecret(): string {
  return process.env.PUBLIC_VOICE_SHARED_SECRET?.trim() ?? '';
}

export function createPublicVoiceProof(roomId: string): string {
  const secret = publicVoiceSecret();
  if (!secret) throw new Error('public_voice_secret_missing');
  return createHmac('sha256', secret).update(`public-voice:${roomId}`).digest('hex');
}

export function verifyPublicVoiceProof(roomId: string | undefined, proof: string | undefined): boolean {
  if (!roomId || !proof || !publicVoiceSecret()) return false;
  const expected = Buffer.from(createPublicVoiceProof(roomId));
  const supplied = Buffer.from(proof);
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

export function resolvePublicVoicePolicy(
  roomId: string | undefined,
  proof: string | undefined,
): PublicVoicePolicy | undefined {
  const live = getPublicVoicePolicy(roomId);
  if (live) return live;
  if (!roomId || !verifyPublicVoiceProof(roomId, proof)) return undefined;
  // 进程重启会丢短会话内存。保留公开模式隔离，宁可重连，也绝不落入私有记忆链路。
  return {
    roomId,
    systemPrompt:
      '你是陈川的AI战略镜像，不是陈川本人。公开语音服务刚刚重启，本轮不访问或保存任何记忆。请简短告知访客当前会话需要关闭后重新连接，不要继续回答其他内容。',
    promptVersion: 'restart-safe-fallback',
    createdAt: Date.now(),
    expiresAt: Date.now() + 3 * 60_000,
    capabilities: { memory: false, voiceprint: false, reminders: false, music: false },
  };
}

export function registerPublicVoicePolicy(
  input: Omit<PublicVoicePolicy, 'capabilities'>,
): PublicVoicePolicy {
  const policy: PublicVoicePolicy = {
    ...input,
    capabilities: {
      memory: false,
      voiceprint: false,
      reminders: false,
      music: false,
    },
  };
  policies.set(policy.roomId, policy);
  return policy;
}

export function getPublicVoicePolicy(roomId?: string): PublicVoicePolicy | undefined {
  if (!roomId) return undefined;
  // 到期后仍保留策略直到 stop 完成，防火山迟到回调误落入私有记忆链路。
  return policies.get(roomId);
}

export function deletePublicVoicePolicy(roomId: string): void {
  policies.delete(roomId);
}

export function activePublicVoicePolicyCount(now = Date.now()): number {
  let active = 0;
  for (const policy of policies.values()) {
    if (now < policy.expiresAt) active += 1;
  }
  return active;
}

export function clearPublicVoicePoliciesForTest(): void {
  policies.clear();
}
import { createHmac, timingSafeEqual } from 'node:crypto';
