import { parentPort, workerData } from "node:worker_threads";
import { parseFile } from "./knowledge-parse.mjs";
try {
  parentPort.postMessage({
    ok: true,
    data: await parseFile(workerData.filename, Buffer.from(workerData.bytes)),
  });
} catch (e) {
  parentPort.postMessage({
    ok: false,
    status: e.status ?? 422,
    code: e.message ?? "file_parse_failed",
  });
}
