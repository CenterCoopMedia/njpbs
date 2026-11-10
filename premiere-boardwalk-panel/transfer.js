"use strict";
const { expectedError } = require("./reports.js");

function checkCancelled(signal) {
  if (signal?.aborted) throw expectedError("Transfer stopped. Your source is unchanged.");
}

function safeFilename(value) {
  const cleaned = String(value).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").replace(/[. ]+$/g, "");
  const extension = cleaned.match(/\.[a-z0-9]{1,10}$/i)?.[0] || "";
  const name = cleaned.length <= 120 ? cleaned : cleaned.slice(0, 120 - extension.length) + extension;
  return !name || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) ? `media-${name || "video"}` : name;
}

function requireSignedTransferUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port ||
      !/^[a-z0-9][a-z0-9.-]*\.s3\.us-east-2\.amazonaws\.com$/.test(url.hostname)) {
    throw new Error("Boardwalk returned an unexpected transfer address.");
  }
  return url.href;
}

async function writeAll(fs, fd, data, position) {
  const view = data instanceof Uint8Array ? data : new Uint8Array(data);
  let offset = 0;
  while (offset < view.byteLength) {
    const { bytesWritten } = await fs.write(fd, view.buffer, view.byteOffset + offset, view.byteLength - offset, position + offset);
    if (!Number.isInteger(bytesWritten) || bytesWritten < 1 || bytesWritten > view.byteLength - offset) {
      throw new Error("The cache disk stopped accepting data. Check free space and try again.");
    }
    offset += bytesWritten;
  }
}

async function download({ fs, fetcher = fetch, url, path, expectedBytes, signal, onProgress, onCreated }) {
  try {
    checkCancelled(signal);
    const response = await fetcher(requireSignedTransferUrl(url), { signal, redirect: "error" });
    if (!response.ok) throw Object.assign(new Error(`Download failed (${response.status}). Retry to get a fresh link.`), { status: response.status, diagnosticCode: "http" });
    if (!response.body?.getReader) throw new Error("This Premiere build cannot stream the download. Update Premiere and try again.");
    const reader = response.body.getReader();
    let fd;
    let bytes = 0;
    try {
      fd = await fs.open(path, "wx");
      onCreated?.();
      while (true) {
        checkCancelled(signal);
        const chunk = await reader.read();
        if (chunk.done) break;
        checkCancelled(signal);
        if (Number.isSafeInteger(expectedBytes) && bytes + chunk.value.byteLength > expectedBytes) {
          throw new Error("The download size changed. Refresh the library and try again.");
        }
        await writeAll(fs, fd, chunk.value, bytes);
        bytes += chunk.value.byteLength;
        onProgress(bytes, expectedBytes);
      }
      if (!bytes || (Number.isSafeInteger(expectedBytes) && bytes !== expectedBytes)) {
        throw new Error("The download is incomplete. Retry before importing it.");
      }
      return bytes;
    } finally {
      try { await reader.cancel(); } finally { if (fd !== undefined) await fs.close(fd); }
    }
  } catch (error) {
    // Premiere can reject a canceled fetch with plain Error("aborted").
    checkCancelled(signal);
    throw error;
  }
}

async function readPart(fs, fd, start, size) {
  const buffer = new ArrayBuffer(size);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await fs.read(fd, buffer, offset, size - offset, start + offset);
    if (!Number.isInteger(bytesRead) || bytesRead < 1 || bytesRead > size - offset) {
      throw new Error("The selected file changed or could not be read. Select the original file again.");
    }
    offset += bytesRead;
  }
  return buffer;
}

async function upload({ fs, fetcher = fetch, client, file, path, session, digest, signal, onProgress, onSession }) {
  const resumed = await client.request("cmsResumeSourceMediaUpload", { sessionId: session.sessionId }, signal);
  if (resumed.asset) return resumed.asset;
  session = resumed.upload;
  const metadata = await file.getMetadata();
  if (session.originalName !== file.name || session.sizeBytes !== metadata.size ||
      session.lastModified !== new Date(metadata.dateModified).getTime()) {
    throw expectedError("Select the same, unchanged file to resume this upload.");
  }
  if (!Number.isSafeInteger(session.partSize) || session.partSize < 1 || session.partSize > 64 * 1024 * 1024 ||
      session.totalParts !== Math.ceil(metadata.size / session.partSize)) {
    throw new Error("Boardwalk returned an unsupported upload size. Cancel this upload and start again.");
  }
  await onSession(session);
  if (!Array.isArray(session.completedParts) || session.completedParts.some(part =>
    !Number.isInteger(part.partNumber) || part.partNumber < 1 || part.partNumber > session.totalParts ||
    typeof part.checksumSha256 !== "string") ||
    new Set(session.completedParts.map(part => part.partNumber)).size !== session.completedParts.length) {
    throw new Error("Boardwalk returned invalid completed parts. Resume again before uploading bytes.");
  }
  const completed = new Set(session.completedParts.map(part => part.partNumber));
  let bytes = [...completed].reduce((total, part) => total + Math.min(session.partSize, metadata.size - (part - 1) * session.partSize), 0);
  onProgress(bytes, metadata.size);
  const fd = await fs.open(path, "r");
  try {
    // Match retained parts to the selected bytes before continuing a multipart upload.
    for (const part of session.completedParts) {
      checkCancelled(signal);
      const start = (part.partNumber - 1) * session.partSize;
      const data = await readPart(fs, fd, start, Math.min(session.partSize, metadata.size - start));
      if (await digest(data) !== part.checksumSha256) {
        throw new Error("This file differs from the uploaded parts. Select the original file or cancel this upload.");
      }
    }
    for (let partNumber = 1; partNumber <= session.totalParts; partNumber++) {
      if (completed.has(partNumber)) continue;
      checkCancelled(signal);
      const start = (partNumber - 1) * session.partSize;
      const data = await readPart(fs, fd, start, Math.min(session.partSize, metadata.size - start));
      const checksumSha256 = await digest(data);
      const signed = await client.request("cmsSignSourceMediaUploadParts", {
        sessionId: session.sessionId, version: session.version,
        parts: [{ partNumber, sizeBytes: data.byteLength, checksumSha256 }],
      }, signal);
      session = { ...session, version: signed.version };
      await onSession(session);
      const part = signed.parts.find(item => item.partNumber === partNumber);
      if (!part) throw new Error("Boardwalk did not authorize this part. Resume to try again.");
      const response = await fetcher(requireSignedTransferUrl(part.url), {
        method: "PUT", headers: part.requiredHeaders, body: data, signal, redirect: "error",
      });
      if (!response.ok) throw Object.assign(new Error(`Upload paused (${response.status}). Resume to try again.`), { status: response.status, diagnosticCode: "http" });
      bytes += data.byteLength;
      onProgress(bytes, metadata.size);
    }
    checkCancelled(signal);
    const result = await client.request("cmsCompleteSourceMediaUpload", {
      sessionId: session.sessionId, version: session.version,
    }, signal);
    return result.asset;
  } finally { await fs.close(fd); }
}

module.exports = { safeFilename, requireSignedTransferUrl, writeAll, readPart, download, upload };
