/** 全局批注测试 DDL，直接对应生成迁移 0122。 */
export const ANNOTATION_DDL = [
  'CREATE TABLE IF NOT EXISTS "annotation_messages" (\n\t"id" text PRIMARY KEY NOT NULL,\n\t"domain_id" text NOT NULL,\n\t"thread_id" text NOT NULL,\n\t"author_id" text NOT NULL,\n\t"body" text NOT NULL,\n\t"revision" integer DEFAULT 0 NOT NULL,\n\t"created_at" text NOT NULL,\n\t"updated_at" text NOT NULL,\n\t"withdrawn_at" text,\n\tCONSTRAINT "annotation_messages_revision_check" CHECK ("annotation_messages"."revision" >= 0 AND length("annotation_messages"."body") BETWEEN 1 AND 30000)\n);',
  'CREATE TABLE IF NOT EXISTS "annotation_notifications" (\n\t"id" text PRIMARY KEY NOT NULL,\n\t"domain_id" text NOT NULL,\n\t"thread_id" text NOT NULL,\n\t"message_id" text NOT NULL,\n\t"user_id" text NOT NULL,\n\t"created_at" text NOT NULL,\n\t"read_at" text,\n\tCONSTRAINT "annotation_notifications_message_user_unique" UNIQUE("message_id","user_id")\n);',
  'CREATE TABLE IF NOT EXISTS "annotation_operations" (\n\t"id" text PRIMARY KEY NOT NULL,\n\t"domain_id" text NOT NULL,\n\t"actor_id" text NOT NULL,\n\t"operation" text NOT NULL,\n\t"key" text NOT NULL,\n\t"request_hash" text NOT NULL,\n\t"resource_id" text NOT NULL,\n\t"created_at" text NOT NULL,\n\tCONSTRAINT "annotation_operations_identity_unique" UNIQUE("domain_id","actor_id","operation","key")\n);',
  'CREATE TABLE IF NOT EXISTS "annotation_sources" (\n\t"id" text PRIMARY KEY NOT NULL,\n\t"domain_id" text NOT NULL,\n\t"target" jsonb NOT NULL,\n\t"target_key" text NOT NULL,\n\t"content_hash" text NOT NULL,\n\t"content" text NOT NULL,\n\t"created_at" text NOT NULL,\n\tCONSTRAINT "annotation_sources_domain_identity_unique" UNIQUE("domain_id","id"),\n\tCONSTRAINT "annotation_sources_version_unique" UNIQUE("domain_id","target_key","content_hash"),\n\tCONSTRAINT "annotation_sources_hash_check" CHECK ("annotation_sources"."content_hash" ~ \'^[a-f0-9]{64}$\')\n);',
  'CREATE TABLE IF NOT EXISTS "annotation_threads" (\n\t"id" text PRIMARY KEY NOT NULL,\n\t"domain_id" text NOT NULL,\n\t"source_id" text NOT NULL,\n\t"owner_id" text NOT NULL,\n\t"student_id" text,\n\t"visibility" text DEFAULT \'private\' NOT NULL,\n\t"anchor" jsonb NOT NULL,\n\t"state" text DEFAULT \'open\' NOT NULL,\n\t"revision" integer DEFAULT 0 NOT NULL,\n\t"created_at" text NOT NULL,\n\t"updated_at" text NOT NULL,\n\t"withdrawn_at" text,\n\tCONSTRAINT "annotation_threads_domain_identity_unique" UNIQUE("domain_id","id"),\n\tCONSTRAINT "annotation_threads_audience_check" CHECK (("annotation_threads"."visibility" = \'private\' AND "annotation_threads"."student_id" IS NULL) OR ("annotation_threads"."visibility" = \'teaching\' AND "annotation_threads"."student_id" IS NOT NULL)),\n\tCONSTRAINT "annotation_threads_state_check" CHECK ("annotation_threads"."state" IN (\'open\',\'resolved\') AND "annotation_threads"."revision" >= 0)\n);',
  'ALTER TABLE "annotation_messages" ADD CONSTRAINT "annotation_messages_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;',
  'ALTER TABLE "annotation_messages" ADD CONSTRAINT "annotation_messages_thread_domain_fk" FOREIGN KEY ("domain_id","thread_id") REFERENCES "public"."annotation_threads"("domain_id","id") ON DELETE no action ON UPDATE no action;',
  'ALTER TABLE "annotation_notifications" ADD CONSTRAINT "annotation_notifications_message_id_annotation_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."annotation_messages"("id") ON DELETE no action ON UPDATE no action;',
  'ALTER TABLE "annotation_notifications" ADD CONSTRAINT "annotation_notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;',
  'ALTER TABLE "annotation_notifications" ADD CONSTRAINT "annotation_notifications_thread_domain_fk" FOREIGN KEY ("domain_id","thread_id") REFERENCES "public"."annotation_threads"("domain_id","id") ON DELETE no action ON UPDATE no action;',
  'ALTER TABLE "annotation_operations" ADD CONSTRAINT "annotation_operations_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE no action ON UPDATE no action;',
  'ALTER TABLE "annotation_operations" ADD CONSTRAINT "annotation_operations_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;',
  'ALTER TABLE "annotation_sources" ADD CONSTRAINT "annotation_sources_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE no action ON UPDATE no action;',
  'ALTER TABLE "annotation_threads" ADD CONSTRAINT "annotation_threads_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE no action ON UPDATE no action;',
  'ALTER TABLE "annotation_threads" ADD CONSTRAINT "annotation_threads_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;',
  'ALTER TABLE "annotation_threads" ADD CONSTRAINT "annotation_threads_student_id_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;',
  'ALTER TABLE "annotation_threads" ADD CONSTRAINT "annotation_threads_source_domain_fk" FOREIGN KEY ("domain_id","source_id") REFERENCES "public"."annotation_sources"("domain_id","id") ON DELETE no action ON UPDATE no action;',
  'CREATE INDEX "idx_annotation_messages_thread" ON "annotation_messages" USING btree ("thread_id","created_at","id");',
  'CREATE INDEX "idx_annotation_notifications_inbox" ON "annotation_notifications" USING btree ("domain_id","user_id","created_at");',
  'CREATE INDEX "idx_annotation_threads_owner" ON "annotation_threads" USING btree ("domain_id","owner_id","created_at","id");',
  'CREATE INDEX "idx_annotation_threads_student" ON "annotation_threads" USING btree ("domain_id","student_id","created_at","id");',
  'CREATE INDEX "idx_annotation_threads_source" ON "annotation_threads" USING btree ("domain_id","source_id");',
];
/** 测试重置清理通知、会话、幂等记录及原文快照。 */
export const ANNOTATION_TABLES = [
  "annotation_notifications",
  "annotation_operations",
  "annotation_messages",
  "annotation_threads",
  "annotation_sources",
] as const;
