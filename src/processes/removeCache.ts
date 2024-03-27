import { SandboxedJob } from "bullmq";
import Repository from "../Repository";
import { getRepository as getRepositoryImport } from "../database/database";
import { Exception, trace } from "@opentelemetry/api";

export default async function (job: SandboxedJob<Repository, void>) {
  const {
    connect,
    getRepository,
  }: {
    connect: () => Promise<void>;
    getRepository: typeof getRepositoryImport;
  } = require("../database/database");
  const span = trace.getTracer("ano-file").startSpan("proc.removeCache");
  span.setAttribute("repoId", job.data.repoId);
  try {
    await connect();
    console.log(
      `[QUEUE] Cache of ${job.data.repoId} is going to be removed...`
    );
    const repo = await getRepository(job.data.repoId);
    try {
      await repo.removeCache();
    } catch (error) {
      span.recordException(error as Exception);
      throw error;
    }
  } catch (error) {
    span.recordException(error as Exception);
  } finally {
    console.log(`[QUEUE] Cache of ${job.data.repoId} is removed.`);
    span.end();
  }
}
