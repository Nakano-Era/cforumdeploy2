import app from "@/worker/app";
import type { Bindings, EmailQueueMessage } from "@/worker/env";
import { handleEmailQueue } from "@/worker/queue";
import { handleScheduled } from "@/worker/scheduled";

export default {
  fetch: app.fetch,
  queue(batch: MessageBatch<EmailQueueMessage>, env: Bindings) {
    return handleEmailQueue(batch, env);
  },
  scheduled(controller: ScheduledController, env: Bindings) {
    return handleScheduled(controller, env);
  },
} satisfies ExportedHandler<Bindings, EmailQueueMessage>;
