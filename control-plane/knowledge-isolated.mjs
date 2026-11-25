import { KnowledgeError as HttpError } from "./knowledge.mjs";
export async function parseFileIsolated(filename, bytes) {
  const { Worker } = await import("node:worker_threads");
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("./knowledge-parse-worker.mjs", import.meta.url),
      {
        workerData: { filename, bytes },
        resourceLimits: { maxOldGenerationSizeMb: 256 },
      },
    );
    let finished = false;
    const end = (error, data) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      worker.terminate();
      error ? reject(error) : resolve(data);
    };
    const timer = setTimeout(
      () => end(new HttpError(422, "file_parse_timeout")),
      30000,
    );
    worker.on("message", (m) =>
      m.ok ? end(null, m.data) : end(new HttpError(m.status, m.code)),
    );
    worker.on("error", () => end(new HttpError(422, "file_parse_failed")));
    worker.on("exit", () => {
      if (!finished) end(new HttpError(422, "file_parse_failed"));
    });
  });
}
