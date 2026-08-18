import type { Bindings, EmailQueueMessage } from "@/worker/env";

function emailContent(message: EmailQueueMessage): { subject: string; text: string } {
  switch (message.kind) {
    case "verification":
      return {
        subject: "你的 CForum 验证码",
        text: `验证码：${message.payload.code ?? ""}\n\n此验证码将在 10 分钟后失效。若非本人操作，请忽略本邮件。`,
      };
    case "registration_decision":
      return {
        subject: "CForum 注册审核结果",
        text: message.payload.message ?? "你的注册状态已更新，请返回站点查看。",
      };
    case "security_alert":
      return {
        subject: "CForum 账号安全提醒",
        text: message.payload.message ?? "你的账号发生了一项安全相关变更。",
      };
    case "level_change":
      return {
        subject: "CForum 等级变更",
        text: message.payload.message ?? "你的社区等级已更新。",
      };
  }
}

async function deliverEmail(message: EmailQueueMessage, env: Bindings): Promise<void> {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) {
    throw new Error("email_provider_unavailable");
  }
  const content = emailContent(message);
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json",
      "idempotency-key": message.idempotencyKey,
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to: [message.recipient],
      subject: content.subject,
      text: content.text,
    }),
  });
  if (!response.ok) throw new Error(`email_provider_${response.status}`);
}

export async function handleEmailQueue(
  batch: MessageBatch<EmailQueueMessage>,
  env: Bindings,
): Promise<void> {
  await Promise.all(
    batch.messages.map(async (message) => {
      try {
        await deliverEmail(message.body, env);
        message.ack();
      } catch {
        message.retry();
      }
    }),
  );
}
