import { KnowledgeError as HttpError } from "./knowledge.mjs";
export async function receiveFile(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 10485760) throw new HttpError(413, "文件超过 10MB，请压缩或拆分后重试");
    chunks.push(chunk);
  }
  if (!size) throw new HttpError(400, "文件为空，请重新选择");
  let filename;
  try {
    filename = decodeURIComponent(req.headers["x-file-name"] ?? "");
  } catch {
    throw new HttpError(400, "文件名无效，请重新选择");
  }
  if (!filename || filename.length > 120 || /[\/\\\x00-\x1f]/.test(filename))
    throw new HttpError(400, "文件名无效，请重新选择");
  return { filename, bytes: Buffer.concat(chunks) };
}
