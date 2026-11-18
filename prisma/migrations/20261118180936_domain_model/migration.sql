/*
  Warnings:

  - You are about to drop the `health_check` table. If the table is not empty, all the data it contains will be lost.

*/
-- CreateEnum
CREATE TYPE "workspace_role" AS ENUM ('project_manager', 'developer', 'reader');

-- CreateEnum
CREATE TYPE "release_status" AS ENUM ('pending', 'dispatching', 'building', 'success', 'partial_failure', 'failed', 'abandoned');

-- CreateEnum
CREATE TYPE "snapshot_status" AS ENUM ('pending', 'dispatching', 'building', 'success', 'failed', 'abandoned', 'superseded');

-- CreateEnum
CREATE TYPE "build_status" AS ENUM ('pending', 'building', 'success', 'failed', 'canceled');

-- CreateEnum
CREATE TYPE "webhook_delivery_status" AS ENUM ('pending', 'success', 'failed');

-- CreateEnum
CREATE TYPE "sync_run_kind" AS ENUM ('baseline_list', 'baseline_packages', 'package_metadata', 'release_status');

-- CreateEnum
CREATE TYPE "sync_run_status" AS ENUM ('running', 'success', 'failed');

-- CreateEnum
CREATE TYPE "sync_run_trigger" AS ENUM ('manual', 'schedule');

-- DropTable
DROP TABLE "health_check";

-- CreateTable
CREATE TABLE "workspace" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "workspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_user" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "is_platform_admin" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "app_user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "membership" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" "workspace_role" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_manager" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "user_id" TEXT,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "project_manager_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "baseline" (
    "id" TEXT NOT NULL,
    "crp_branch_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "repo_type" TEXT,
    "is_check" BOOLEAN NOT NULL DEFAULT false,
    "synced_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "baseline_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "baseline_package_version" (
    "id" TEXT NOT NULL,
    "baseline_id" TEXT NOT NULL,
    "package_name" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "fetched_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "baseline_package_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "project_manager_id" TEXT NOT NULL,
    "baseline_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "package" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "repo_path" TEXT NOT NULL,
    "default_branch" TEXT NOT NULL,
    "current_version" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "package_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "package_dependency" (
    "id" TEXT NOT NULL,
    "package_id" TEXT NOT NULL,
    "upstream_package_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "package_dependency_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_software" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "package_id" TEXT NOT NULL,
    "tracked_branch" TEXT NOT NULL,
    "last_submitted_commit" TEXT,
    "last_submitted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "project_software_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "release" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "status" "release_status" NOT NULL DEFAULT 'pending',
    "description" TEXT,
    "created_by_id" TEXT NOT NULL,
    "crp_topic_id" TEXT,
    "crp_branch_id" TEXT,
    "crp_topic_state" INTEGER,
    "crp_topic_abandoned" BOOLEAN,
    "crp_topic_completed" BOOLEAN,
    "crp_work_progress" INTEGER,
    "crp_work_progress_label" TEXT,
    "crp_work_progress_synced_at" TIMESTAMPTZ(3),
    "submitted_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "rollback_of_id" TEXT,
    "code_source_release_id" TEXT,
    "risk_flag" BOOLEAN,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "release_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "release_package_snapshot" (
    "id" TEXT NOT NULL,
    "release_id" TEXT NOT NULL,
    "package_name" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "branch" TEXT NOT NULL,
    "commit_sha" TEXT NOT NULL,
    "code_version" TEXT NOT NULL,
    "repo_version" TEXT,
    "release_version" TEXT NOT NULL,
    "status" "snapshot_status" NOT NULL DEFAULT 'pending',
    "status_changed_at" TIMESTAMPTZ(3),
    "superseded_by_id" TEXT,
    "superseded_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "release_package_snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "release_repository_record" (
    "id" TEXT NOT NULL,
    "release_id" TEXT NOT NULL,
    "snapshot_id" TEXT NOT NULL,
    "crp_release_id" TEXT NOT NULL,
    "crp_build_id" TEXT,
    "crp_release_state" INTEGER,
    "crp_status_name" TEXT,
    "repository_url" TEXT,
    "last_synced_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "release_repository_record_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "build_task" (
    "id" TEXT NOT NULL,
    "release_id" TEXT NOT NULL,
    "snapshot_id" TEXT NOT NULL,
    "shuttle_task_id" TEXT,
    "status" "build_status" NOT NULL DEFAULT 'pending',
    "last_polled_at" TIMESTAMPTZ(3),
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "build_task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "build_job" (
    "id" TEXT NOT NULL,
    "build_task_id" TEXT NOT NULL,
    "shuttle_job_id" TEXT NOT NULL,
    "arch" TEXT NOT NULL,
    "status" "build_status" NOT NULL DEFAULT 'pending',
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "build_job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_endpoint" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "event_types" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "description" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "webhook_endpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_delivery" (
    "id" TEXT NOT NULL,
    "endpoint_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "signature" TEXT NOT NULL,
    "status" "webhook_delivery_status" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "delivered_at" TIMESTAMPTZ(3),

    CONSTRAINT "webhook_delivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_run" (
    "id" TEXT NOT NULL,
    "kind" "sync_run_kind" NOT NULL,
    "status" "sync_run_status" NOT NULL DEFAULT 'running',
    "trigger" "sync_run_trigger" NOT NULL,
    "target_id" TEXT,
    "item_count" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(3),
    "error_message" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sync_run_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "workspace_slug_key" ON "workspace"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "app_user_email_key" ON "app_user"("email");

-- CreateIndex
CREATE INDEX "membership_user_id_idx" ON "membership"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "membership_workspace_id_user_id_key" ON "membership"("workspace_id", "user_id");

-- CreateIndex
CREATE INDEX "project_manager_workspace_id_idx" ON "project_manager"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "project_manager_workspace_id_name_key" ON "project_manager"("workspace_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "baseline_crp_branch_id_key" ON "baseline"("crp_branch_id");

-- CreateIndex
CREATE UNIQUE INDEX "baseline_package_version_baseline_id_package_name_key" ON "baseline_package_version"("baseline_id", "package_name");

-- CreateIndex
CREATE INDEX "project_project_manager_id_idx" ON "project"("project_manager_id");

-- CreateIndex
CREATE INDEX "project_baseline_id_idx" ON "project"("baseline_id");

-- CreateIndex
CREATE UNIQUE INDEX "project_workspace_id_name_key" ON "project"("workspace_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "project_workspace_id_key_key" ON "project"("workspace_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "package_name_key" ON "package"("name");

-- CreateIndex
CREATE UNIQUE INDEX "package_repo_path_key" ON "package"("repo_path");

-- CreateIndex
CREATE INDEX "package_dependency_upstream_package_id_idx" ON "package_dependency"("upstream_package_id");

-- CreateIndex
CREATE UNIQUE INDEX "package_dependency_package_id_upstream_package_id_key" ON "package_dependency"("package_id", "upstream_package_id");

-- CreateIndex
CREATE INDEX "project_software_package_id_idx" ON "project_software"("package_id");

-- CreateIndex
CREATE UNIQUE INDEX "project_software_project_id_package_id_key" ON "project_software"("project_id", "package_id");

-- CreateIndex
CREATE UNIQUE INDEX "release_crp_topic_id_key" ON "release"("crp_topic_id");

-- CreateIndex
CREATE INDEX "release_status_idx" ON "release"("status");

-- CreateIndex
CREATE INDEX "release_created_at_idx" ON "release"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "release_project_id_version_key" ON "release"("project_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "release_package_snapshot_superseded_by_id_key" ON "release_package_snapshot"("superseded_by_id");

-- CreateIndex
CREATE INDEX "release_package_snapshot_release_id_status_idx" ON "release_package_snapshot"("release_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "release_package_snapshot_release_id_package_name_attempt_key" ON "release_package_snapshot"("release_id", "package_name", "attempt");

-- CreateIndex
CREATE UNIQUE INDEX "release_repository_record_snapshot_id_key" ON "release_repository_record"("snapshot_id");

-- CreateIndex
CREATE UNIQUE INDEX "release_repository_record_crp_release_id_key" ON "release_repository_record"("crp_release_id");

-- CreateIndex
CREATE UNIQUE INDEX "build_task_snapshot_id_key" ON "build_task"("snapshot_id");

-- CreateIndex
CREATE UNIQUE INDEX "build_task_shuttle_task_id_key" ON "build_task"("shuttle_task_id");

-- CreateIndex
CREATE INDEX "build_task_release_id_idx" ON "build_task"("release_id");

-- CreateIndex
CREATE INDEX "build_task_status_idx" ON "build_task"("status");

-- CreateIndex
CREATE UNIQUE INDEX "build_job_shuttle_job_id_key" ON "build_job"("shuttle_job_id");

-- CreateIndex
CREATE INDEX "build_job_build_task_id_idx" ON "build_job"("build_task_id");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_endpoint_workspace_id_url_key" ON "webhook_endpoint"("workspace_id", "url");

-- CreateIndex
CREATE INDEX "webhook_delivery_endpoint_id_status_idx" ON "webhook_delivery"("endpoint_id", "status");

-- CreateIndex
CREATE INDEX "webhook_delivery_created_at_idx" ON "webhook_delivery"("created_at");

-- CreateIndex
CREATE INDEX "sync_run_kind_started_at_idx" ON "sync_run"("kind", "started_at");

-- CreateIndex
CREATE INDEX "sync_run_status_idx" ON "sync_run"("status");

-- AddForeignKey
ALTER TABLE "membership" ADD CONSTRAINT "membership_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership" ADD CONSTRAINT "membership_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_manager" ADD CONSTRAINT "project_manager_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_manager" ADD CONSTRAINT "project_manager_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "baseline_package_version" ADD CONSTRAINT "baseline_package_version_baseline_id_fkey" FOREIGN KEY ("baseline_id") REFERENCES "baseline"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project" ADD CONSTRAINT "project_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project" ADD CONSTRAINT "project_project_manager_id_fkey" FOREIGN KEY ("project_manager_id") REFERENCES "project_manager"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project" ADD CONSTRAINT "project_baseline_id_fkey" FOREIGN KEY ("baseline_id") REFERENCES "baseline"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "package_dependency" ADD CONSTRAINT "package_dependency_package_id_fkey" FOREIGN KEY ("package_id") REFERENCES "package"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "package_dependency" ADD CONSTRAINT "package_dependency_upstream_package_id_fkey" FOREIGN KEY ("upstream_package_id") REFERENCES "package"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_software" ADD CONSTRAINT "project_software_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_software" ADD CONSTRAINT "project_software_package_id_fkey" FOREIGN KEY ("package_id") REFERENCES "package"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "release" ADD CONSTRAINT "release_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "release" ADD CONSTRAINT "release_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "release_package_snapshot" ADD CONSTRAINT "release_package_snapshot_release_id_fkey" FOREIGN KEY ("release_id") REFERENCES "release"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "release_package_snapshot" ADD CONSTRAINT "release_package_snapshot_superseded_by_id_fkey" FOREIGN KEY ("superseded_by_id") REFERENCES "release_package_snapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "release_repository_record" ADD CONSTRAINT "release_repository_record_release_id_fkey" FOREIGN KEY ("release_id") REFERENCES "release"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "release_repository_record" ADD CONSTRAINT "release_repository_record_snapshot_id_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "release_package_snapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "build_task" ADD CONSTRAINT "build_task_release_id_fkey" FOREIGN KEY ("release_id") REFERENCES "release"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "build_task" ADD CONSTRAINT "build_task_snapshot_id_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "release_package_snapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "build_job" ADD CONSTRAINT "build_job_build_task_id_fkey" FOREIGN KEY ("build_task_id") REFERENCES "build_task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_endpoint" ADD CONSTRAINT "webhook_endpoint_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_delivery" ADD CONSTRAINT "webhook_delivery_endpoint_id_fkey" FOREIGN KEY ("endpoint_id") REFERENCES "webhook_endpoint"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
